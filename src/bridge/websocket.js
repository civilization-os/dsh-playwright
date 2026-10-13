/**
 * Minimal RFC 6455 WebSocket server and client.
 *
 * The Chrome Bridge deliberately carries no third-party dependency: a DeepSeek Harness plugin
 * must stay installable in restricted environments where fetching new packages is not possible,
 * and the bridge transport is a small, fully testable protocol surface.
 *
 * Implemented: RFC 6455 handshake, masking, all frame lengths, fragmentation, control frames
 * (close/ping/pong), UTF-8 validation for text frames, and bounded message sizes.
 * Not implemented: permessage-deflate extension negotiation.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Hard ceiling for one assembled WebSocket message. */
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024
/** Hard ceiling for an HTTP request head read from a raw socket. */
export const MAX_HEADER_BYTES = 32 * 1024
const CLOSE_CODES = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014])

export class WebSocketProtocolError extends Error {
  constructor(message, closeCode = 1002) {
    super(message)
    this.name = 'WebSocketProtocolError'
    this.closeCode = closeCode
  }
}

/** Compute the Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return createHash('sha1').update(`${String(key).trim()}${WS_GUID}`).digest('base64')
}

/** Parse an HTTP request head (upgrade request) from a raw buffer. */
export function parseHttpRequest(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return undefined
  const head = buffer.subarray(0, end).toString('latin1')
  const lines = head.split('\r\n')
  const match = /^([A-Z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(lines.shift() ?? '')
  if (!match) throw new WebSocketProtocolError('Malformed HTTP request line.')
  const headers = {}
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return { method: match[1], target: match[2], version: match[3], headers, headBytes: end + 4 }
}

function isUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/** Header length in bytes for a frame with the given payload length. */
export function frameHeaderSize(length) {
  if (length < 126) return 2
  if (length < 65536) return 4
  return 10
}

/** Write a WebSocket frame header into `target`. Returns the header length. */
function writeFrameHeader(target, opcode, length, fin, masked) {
  let offset
  if (length < 126) {
    target[1] = length
    offset = 2
  } else if (length < 65536) {
    target[1] = 126
    target.writeUInt16BE(length, 2)
    offset = 4
  } else {
    target[1] = 127
    target.writeBigUInt64BE(BigInt(length), 2)
    offset = 10
  }
  target[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  if (masked) target[1] |= 0x80
  return offset
}

/** Build one unmasked WebSocket frame. */
export function encodeFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  const frame = Buffer.allocUnsafe(frameHeaderSize(data.length) + data.length)
  const offset = writeFrameHeader(frame, opcode, data.length, fin, false)
  data.copy(frame, offset)
  return frame
}

/** Build one masked WebSocket frame. Client-to-server frames must be masked. */
export function encodeMaskedFrame(opcode, payload, fin = true, mask = randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  const header = frameHeaderSize(data.length)
  const frame = Buffer.allocUnsafe(header + 4 + data.length)
  writeFrameHeader(frame, opcode, data.length, fin, true)
  mask.copy(frame, header)
  const offset = header + 4
  for (let index = 0; index < data.length; index += 1) frame[offset + index] = data[index] ^ mask[index & 3]
  return frame
}

/**
 * A framed WebSocket over an established stream. Control-frame and UTF-8 validation are applied
 * before any application callback runs.
 */
export class WebSocketConnection {
  constructor(socket, options = {}) {
    this.socket = socket
    this.requireMask = options.requireMask !== false
    this.maskOutgoing = options.maskOutgoing === true
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.closed = false
    this.closeEmitted = false
    this.closeSent = false
    this.closeCode = undefined
    this.closeReason = undefined
    this.buffer = Buffer.alloc(0)
    this.fragments = undefined
    this.fragmentOpcode = 0
    this.onmessage = options.onmessage
    this.onclose = options.onclose
    this.onerror = options.onerror
    this.onprotocolerror = options.onprotocolerror
    socket.on('data', chunk => this.feed(chunk))
    socket.on('error', error => {
      this.closed = true
      this.onerror?.(error)
      this.reportTransportClose()
    })
    socket.on('close', () => {
      this.closed = true
      this.reportTransportClose()
    })
    socket.on('end', () => {
      this.closed = true
      this.reportTransportClose()
    })
  }

  get alive() {
    return !this.closed && !this.socket.destroyed
  }

  feed(chunk) {
    if (this.closed) return
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
      this.drain()
    } catch (error) {
      if (error instanceof WebSocketProtocolError) {
        this.onprotocolerror?.(error)
        this.close(error.closeCode, error.message)
        return
      }
      this.onerror?.(error)
      this.close(1011, 'internal error')
    }
  }

  drain() {
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      this.handleFrame(frame)
      if (this.closed) return
    }
  }

  /** Extract one complete frame, or undefined when more bytes are required. */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    if ((first & 0x70) !== 0) throw new WebSocketProtocolError('Reserved bits must be zero.')
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const wide = buffer.readBigUInt64BE(offset)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebSocketProtocolError('Frame length is out of range.', 1009)
      length = Number(wide)
      offset += 8
    }
    const isControl = (opcode & 0x08) !== 0
    if (isControl && (length > 125 || !fin)) throw new WebSocketProtocolError('Control frames must be unfragmented and at most 125 bytes.')
    if (!isControl && length > this.maxMessageBytes) throw new WebSocketProtocolError('Frame exceeds the maximum message size.', 1009)
    if (this.requireMask && !masked) throw new WebSocketProtocolError('Client frames must be masked.')
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
    if (masked) offset += 4
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3]
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x00) {
      if (this.fragments === undefined) throw new WebSocketProtocolError('Unexpected continuation frame.')
      this.fragments.push(payload)
      this.assertAssembledSize()
      if (fin) this.completeMessage(this.fragmentOpcode, Buffer.concat(this.fragments))
      return
    }
    if (opcode === 0x01 || opcode === 0x02) {
      if (this.fragments !== undefined) throw new WebSocketProtocolError('A new data frame started before the previous message finished.')
      if (fin) {
        this.completeMessage(opcode, payload)
        return
      }
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      this.assertAssembledSize()
      return
    }
    if (opcode === 0x08) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      // Record the peer's close code before the transport teardown can report 1006.
      this.closeCode = code === 1005 ? 1000 : code
      this.closeReason = reason
      this.close(this.closeCode, reason, { echo: false })
      return
    }
    if (opcode === 0x09) {
      this.writeFrame(0x0a, payload)
      return
    }
    if (opcode === 0x0a) return
    throw new WebSocketProtocolError(`Unsupported opcode ${opcode}.`)
  }

  assertAssembledSize() {
    let total = 0
    for (const fragment of this.fragments) total += fragment.length
    if (total > this.maxMessageBytes) throw new WebSocketProtocolError('Message exceeds the maximum message size.', 1009)
  }

  completeMessage(opcode, payload) {
    this.fragments = undefined
    this.fragmentOpcode = 0
    if (opcode === 0x01 && !isUtf8(payload)) throw new WebSocketProtocolError('Text frames must contain valid UTF-8.', 1007)
    this.onmessage?.(opcode === 0x01 ? payload.toString('utf8') : payload, opcode === 0x01)
  }

  writeFrame(opcode, payload) {
    if (!this.alive) return
    const frame = this.maskOutgoing ? encodeMaskedFrame(opcode, payload) : encodeFrame(opcode, payload)
    this.socket.write(frame, () => {})
  }

  send(data) {
    if (!this.alive) return false
    this.writeFrame(typeof data === 'string' ? 0x01 : 0x02, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    return true
  }

  ping(payload = Buffer.alloc(0)) {
    this.writeFrame(0x09, payload)
  }

  /**
   * Write one raw protocol frame, ignoring the connection's masking default.
   * This exists so tests can exercise protocol violations; application code sends messages.
   */
  writeRawFrame(opcode, payload, { masked, fin = true } = {}) {
    if (this.socket.destroyed) return
    const frame = (masked ?? this.maskOutgoing) ? encodeMaskedFrame(opcode, payload, fin) : encodeFrame(opcode, payload, fin)
    this.socket.write(frame, () => {})
  }

  close(code = 1000, reason = '', options = {}) {
    if (!this.closed) {
      this.closed = true
      this.closeSent = true
      this.sendCloseFrame(code, reason)
    }
    // Allow the closing frame to flush before tearing the stream down.
    const timer = setTimeout(() => this.socket.destroy(), 250)
    timer.unref?.()
    // When answering a peer's close frame, the peer already knows why the connection ended.
    if (options.echo !== false) {
      this.closeCode = code === 1005 ? 1000 : code
      this.closeReason = reason
      this.reportTransportClose()
    }
  }

  sendCloseFrame(code, reason) {
    if (this.socket.destroyed) return
    const safeCode = CLOSE_CODES.has(code) || code === 1005 ? code : 1000
    const reasonBytes = Buffer.from(String(reason).slice(0, 100), 'utf8')
    const payload = safeCode === 1005 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([safeCode >> 8, safeCode & 0xff]), reasonBytes])
    try {
      this.socket.write(this.maskOutgoing ? encodeMaskedFrame(0x08, payload) : encodeFrame(0x08, payload), () => {})
    } catch { /* socket already gone */ }
  }

  /**
   * Report the connection outcome exactly once. A close code observed in a peer's close frame, or
   * one we chose ourselves, always outranks the transport-level abnormal-closure code.
   */
  reportTransportClose() {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.onclose?.(this.closeCode ?? 1006, this.closeReason ?? '')
  }

  emitClose(code, reason) {
    if (this.closeEmitted) return
    this.closeCode = code
    this.closeReason = reason
    this.reportTransportClose()
  }
}

/** Send one HTTP response head on a raw socket and end it. */
function writeHttpError(socket, status, message) {
  const body = `${message}\n`
  socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  socket.destroy()
}

/**
 * Complete a WebSocket upgrade for a request already read from `socket`.
 * Returns the connection, or undefined when the request must be rejected.
 */
export function acceptUpgrade(socket, info, options = {}) {
  const { headers } = info.request
  const key = headers['sec-websocket-key']
  if (String(headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
    writeHttpError(socket, 400, 'Expected a WebSocket upgrade request.')
    return undefined
  }
  if (String(headers['sec-websocket-version'] ?? '') !== '13') {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nsec-websocket-version: 13\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
    socket.destroy()
    return undefined
  }
  // RFC 6455 requires a 16-byte base64 key. Reject anything else before completing the handshake.
  if (Buffer.from(key, 'base64').length !== 16) {
    writeHttpError(socket, 400, 'Invalid Sec-WebSocket-Key.')
    return undefined
  }
  const protocol = options.protocol ? `sec-websocket-protocol: ${options.protocol}\r\n` : ''
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key)}\r\n${protocol}\r\n`)
  socket.setNoDelay?.(true)
  const connection = new WebSocketConnection(socket, {
    requireMask: true,
    maskOutgoing: false,
    maxMessageBytes: options.maxMessageBytes,
    onmessage: options.onmessage,
    onclose: options.onclose,
    onerror: options.onerror,
    onprotocolerror: options.onprotocolerror,
  })
  connection.request = info.request
  if (info.buffer.length) connection.feed(info.buffer)
  return connection
}

/**
 * Handle a `server.on('upgrade')` event. Returns the connection or undefined.
 * `onReject` (optional) is called with a reason string when the handshake is refused.
 */
export function handleUpgrade(request, socket, head, options = {}) {
  const info = {
    request: {
      method: request.method,
      target: request.url,
      version: '1.1',
      headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
    },
    buffer: head?.length ? Buffer.from(head) : Buffer.alloc(0),
  }
  if (options.path && !matchesPath(request.url, options.path)) {
    writeHttpError(socket, 404, 'Not Found')
    return undefined
  }
  if (options.onHandshake && options.onHandshake(info) === false) {
    writeHttpError(socket, 403, 'Forbidden')
    return undefined
  }
  return acceptUpgrade(socket, info, options)
}

/** Path match that ignores the query string, so /bridge and /bridge?x=1 both match /bridge. */
export function matchesPath(target, path) {
  const value = String(target ?? '')
  const query = value.indexOf('?')
  return (query === -1 ? value : value.slice(0, query)) === path
}

/** Parse the Cookie or query parameter used to carry a session identifier. */
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

/** Constant-time string comparison that never short-circuits on length. */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.length !== b.length) {
    // Still consume the comparison so timing does not reveal the length mismatch early.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Connect a WebSocket client. Used by tests and by the CLI diagnostic, not by the extension
 * (which uses the browser's native WebSocket).
 */
export function connectWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const secure = parsed.protocol === 'wss:'
    const key = randomBytes(16).toString('base64')
    const request = (secure ? httpsRequest : httpRequest)({
      host: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      rejectUnauthorized: options.rejectUnauthorized !== false,
      timeout: options.timeoutMs ?? 15000,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...(options.headers ?? {}),
      },
    })
    let settled = false
    request.on('upgrade', (response, socket, head) => {
      settled = true
      if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy()
        reject(new Error('The server returned an invalid Sec-WebSocket-Accept value.'))
        return
      }
      socket.setNoDelay?.(true)
      const connection = new WebSocketConnection(socket, {
        requireMask: false,
        maskOutgoing: true,
        maxMessageBytes: options.maxMessageBytes,
        onmessage: options.onmessage,
        onclose: options.onclose,
        onerror: options.onerror,
        onprotocolerror: options.onprotocolerror,
      })
      if (head?.length) connection.feed(head)
      resolve(connection)
    })
    request.on('response', response => {
      if (settled) return
      settled = true
      response.resume()
      reject(new Error(`The WebSocket handshake was rejected with HTTP ${response.statusCode}.`))
    })
    request.on('timeout', () => { request.destroy(new Error('The WebSocket handshake timed out.')) })
    request.on('error', error => { if (!settled) { settled = true; reject(error) } })
    request.end()
  })
}
