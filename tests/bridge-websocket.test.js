/**
 * WebSocket transport tests.
 *
 * These cover the framing rules the bridge depends on: masking, every length encoding,
 * fragmentation, control frames, UTF-8 validation, size limits, the handshake, and the close-code
 * precedence that makes a peer's close reason survive transport teardown.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  acceptKey, parseHttpRequest, encodeFrame, encodeMaskedFrame, connectWebSocket, handleUpgrade,
  matchesPath, readCookie, safeEqual, WebSocketConnection, DEFAULT_MAX_MESSAGE_BYTES,
} from '../src/bridge/websocket.js'

/** Start a WebSocket server on an ephemeral port. */
async function startServer(t, options = {}) {
  const server = createServer()
  t.after(() => server.close())
  server.on('upgrade', (request, socket, head) => handleUpgrade(request, socket, head, { path: '/ws', ...options }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `ws://127.0.0.1:${server.address().port}/ws` }
}

/** Connect a client that the test is expected to close. */
async function startClient(t, url, options = {}) {
  const client = await connectWebSocket(url, options)
  t.after(() => client.close())
  return client
}

/** Resolve with the close code and reason reported to a client. */
function onClose(client) {
  return new Promise(resolve => { client.onclose = (code, reason) => resolve({ code, reason }) })
}

test('acceptKey implements the RFC 6455 example handshake', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('parseHttpRequest reads a request line and folds repeated headers', () => {
  const request = parseHttpRequest(Buffer.from('GET /x?y=1 HTTP/1.1\r\nHost: a\r\nX-A: 1\r\nX-A: 2\r\n\r\n'))
  assert.equal(request.method, 'GET')
  assert.equal(request.target, '/x?y=1')
  assert.equal(request.headers['x-a'], '1, 2')
  assert.equal(parseHttpRequest(Buffer.from('GET /x HTTP/1.1\r\n')), undefined)
  assert.throws(() => parseHttpRequest(Buffer.from('garbage\r\n\r\n')), /Malformed HTTP request line/)
})

test('path, cookie, and constant-time comparison helpers behave as specified', () => {
  assert.equal(matchesPath('/bridge?token=1', '/bridge'), true)
  assert.equal(matchesPath('/bridge/extra', '/bridge'), false)
  assert.equal(matchesPath(undefined, '/bridge'), false)
  assert.equal(readCookie('a=1; dsh_bridge_session=xyz; b=2', 'dsh_bridge_session'), 'xyz')
  assert.equal(readCookie('a=1', 'missing'), undefined)
  assert.equal(safeEqual('same', 'same'), true)
  assert.equal(safeEqual('same', 'diff'), false)
  assert.equal(safeEqual('short', 'longer-value'), false)
})

test('frame encoding covers 7-bit, 16-bit, and 64-bit payload lengths', () => {
  for (const size of [0, 1, 125, 126, 127, 65535, 65536]) {
    const payload = Buffer.alloc(size, 0x61)
    const frame = encodeFrame(0x02, payload)
    const expectedHeader = size < 126 ? 2 : size < 65536 ? 4 : 10
    assert.equal(frame.length, expectedHeader + size, `size ${size}`)
    assert.equal(frame[0], 0x82, `fin+opcode for size ${size}`)
    assert.equal(frame[1] & 0x80, 0, 'server frames are unmasked')
  }
  assert.equal(encodeFrame(0x01, Buffer.from('hi'), false)[0], 0x01, 'fin bit must clear for fragments')
  assert.equal(encodeMaskedFrame(0x01, Buffer.from('hi'))[1] & 0x80, 0x80, 'client frames must be masked')
})

test('text and binary messages round-trip through a real server connection', async t => {
  const received = []
  const { url } = await startServer(t, { onmessage: (text, isText) => received.push({ text, isText }) })
  const client = await startClient(t, url)
  client.send('hello world')
  client.send(Buffer.from([1, 2, 3]))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(received, [{ text: 'hello world', isText: true }, { text: Buffer.from([1, 2, 3]), isText: false }])
})

test('fragmented data frames are reassembled and ping is answered with pong', async t => {
  const messages = []
  const { url } = await startServer(t, { onmessage: text => { messages.push(text) } })
  const pongs = []
  const client = await startClient(t, url, { onmessage: (payload, isText) => { if (isText === false) pongs.push(payload) } })

  client.writeRawFrame(0x01, Buffer.from('frag'), { masked: true, fin: false })
  client.writeRawFrame(0x00, Buffer.from('mented'), { masked: true, fin: true })
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(messages, ['fragmented'])

  // A pong is a control frame, so it is delivered to the connection rather than to onmessage.
  const pong = new Promise(resolve => {
    const original = client.handleFrame.bind(client)
    client.handleFrame = frame => resolve(frame.payload.toString()) ?? original(frame)
  })
  client.ping(Buffer.from('abc'))
  assert.equal(await pong, 'abc')
})

test('protocol violations close with the correct status code', async t => {
  const { url } = await startServer(t)
  const expectClose = async (write, expectedCode) => {
    const client = await connectWebSocket(url)
    t.after(() => client.close())
    const closed = onClose(client)
    write(client)
    const outcome = await closed
    assert.equal(outcome.code, expectedCode, `expected ${expectedCode}, got ${outcome.code} (${outcome.reason})`)
  }
  // The server requires masked client frames, valid UTF-8 text, sane framing, and a size bound.
  await expectClose(client => client.writeRawFrame(0x01, Buffer.from('unmasked'), { masked: false }), 1002)
  await expectClose(client => client.writeRawFrame(0x01, Buffer.from([0xff, 0xfe, 0xfd]), { masked: true }), 1007)
  await expectClose(client => client.writeRawFrame(0x00, Buffer.from('orphan'), { masked: true }), 1002)
  await expectClose(client => {
    // A reserved bit must never be set.
    const frame = encodeMaskedFrame(0x01, Buffer.from('x'))
    frame[0] |= 0x40
    client.socket.write(frame)
  }, 1002)
  await expectClose(client => {
    // A fragmented control frame is illegal.
    const frame = encodeMaskedFrame(0x09, Buffer.from('x'), false)
    client.socket.write(frame)
  }, 1002)
})

test('a payload larger than the size limit is refused', async t => {
  const { url } = await startServer(t)
  // The server closes with 1009 as soon as the declared length exceeds the bound, so the client
  // must never have to push the whole body.
  const client = await connectWebSocket(url)
  t.after(() => client.close())
  const closed = onClose(client)
  client.writeRawFrame(0x01, Buffer.alloc(DEFAULT_MAX_MESSAGE_BYTES + 1), { masked: true })
  assert.equal((await closed).code, 1009)
})

test('a peer close code survives transport teardown, and teardown alone reports 1006', () => {
  const makeSocket = () => ({
    destroyed: false, writable: true, on: () => {}, off: () => {}, write: () => {}, destroy: () => {}, setNoDelay: () => {},
  })
  const observed = []
  const live = new WebSocketConnection(makeSocket(), { requireMask: false, onclose: (code, reason) => observed.push([code, reason]) })
  // Receive the peer's close frame first...
  live.handleFrame({ fin: true, opcode: 0x08, payload: Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from('going away')]) })
  // ...then the transport teardown arrives; it must not overwrite the observed code.
  live.reportTransportClose()
  assert.deepEqual(observed, [[1011, 'going away']])

  const aborted = []
  const dropped = new WebSocketConnection(makeSocket(), { requireMask: false, onclose: (code, reason) => aborted.push([code, reason]) })
  dropped.closed = true
  dropped.reportTransportClose()
  assert.deepEqual(aborted, [[1006, '']])
})

test('the handshake rejects a bad key, a wrong version, and a missing route', async t => {
  const { url } = await startServer(t)
  await assert.rejects(connectWebSocket(url.replace('/ws', '/other')), /404/)
  await assert.rejects(
    connectWebSocket(url, { headers: { 'sec-websocket-version': '8' } }),
    /handshake was rejected/,
  )
})
