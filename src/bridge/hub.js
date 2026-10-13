/**
 * Chrome Bridge hub: transport-agnostic connection and request management.
 *
 * The hub owns peer authentication, peer selection, request/response correlation, timeouts,
 * cancellation, and disconnect reporting. It knows nothing about WebSocket framing or about
 * Chrome, which keeps the security and lifecycle rules unit-testable with a fake peer.
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { safeEqual } from './websocket.js'

/** Default RPC method allowlist. Arbitrary JavaScript and shell execution are not representable. */
export const DEFAULT_METHODS = Object.freeze([
  'bridge.status',
  'bridge.ping',
  'browser.tabs',
  'browser.open',
  'browser.snapshot',
  'browser.act',
  'browser.wait',
])

export const AUTH_TIMEOUT_MS = 10000
export const HANDSHAKE_TTL_MS = 60000
/** Text-only frames keep the protocol simple and prevent binary smuggling. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** Load a token store persisted with owner-only permissions. */
export function createTokenStore(readFile, writeFile, path) {
  return {
    /** Return the active token records, ignoring any malformed entries. */
    async list() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        if (!Array.isArray(parsed?.tokens)) return []
        return parsed.tokens.filter(item => item && typeof item.token === 'string' && item.token.length >= 32)
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
    },
    async write(tokens) {
      await writeFile(path, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 })
      return tokens
    },
  }
}

export function createChromeBridgeHub(options = {}) {
  const log = options.log ?? (() => {})
  const methods = new Set(options.methods ?? DEFAULT_METHODS)
  const defaultTimeoutMs = options.timeoutMs ?? 30000
  const maxPending = options.maxPending ?? 64
  const peers = new Map()
  const pending = new Map()
  /**
   * Owning session -> peer. Keyed by the *session*, not the pairing token: an extension that
   * reconnects on the same session replaces its own stale connection, while two independently
   * paired browsers that happen to share a token remain distinct peers.
   */
  const ownedSessions = new Map()
  const listeners = new Set()

  const fingerprint = token => createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
  const err = (code, message) => new BridgeError(code, message)
  const emit = event => { for (const listener of listeners) { try { listener(event) } catch { /* listener faults are isolated */ } } }

  /** Reject pending work belonging to a peer so callers fail fast instead of waiting for a timeout. */
  function failPendingFor(peer, error) {
    for (const [id, entry] of pending) {
      if (entry.peer !== peer) continue
      pending.delete(id)
      entry.reject(error)
    }
  }

  function status() {
    return {
      listening: typeof options.isListening === 'function' ? options.isListening() : Boolean(options.listening),
      peers: [...peers.values()].map(peer => ({
        id: peer.id,
        authenticated: peer.authenticated,
        label: peer.label,
        extensionVersion: peer.extensionVersion,
        userAgent: peer.userAgent,
        connectedAt: peer.connectedAt,
        lastSeenAt: peer.lastSeenAt,
        pending: peer.pending,
      })),
    }
  }

  /**
   * Register a new transport connection and send the authentication challenge.
   * Returns the peer handle that the transport must feed inbound messages into.
   */
  function register(connection, attributes = {}) {
    const peer = {
      id: `bridge-${randomUUID().slice(0, 8)}`,
      connection,
      authenticated: false,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      pending: 0,
      sessionId: undefined,
      tokenId: undefined,
      label: undefined,
      extensionVersion: undefined,
      userAgent: attributes.userAgent,
      origin: attributes.origin,
      session: attributes.session,
      nonce: randomBytes(24).toString('base64url'),
      closes: 0,
    }
    peers.set(peer.id, peer)
    peer.authTimer = setTimeout(() => {
      if (!peer.authenticated) closePeer(peer, 'BRIDGE_UNAUTHENTICATED', 'The connection was not authenticated in time.')
    }, AUTH_TIMEOUT_MS)
    peer.authTimer.unref?.()
    send(peer, { type: 'challenge', protocol: 1, nonce: peer.nonce, authTimeoutMs: AUTH_TIMEOUT_MS, methods: [...methods] })
    log(`bridge peer ${peer.id} connected from ${attributes.origin ?? 'unknown origin'}`)
    emit({ type: 'peer-connected', peerId: peer.id })
    return peer
  }

  function send(peer, message) {
    try {
      const ok = peer.connection.send(JSON.stringify(message))
      if (ok === false) closePeer(peer, 'BRIDGE_OFFLINE', 'The bridge connection is no longer writable.')
      return ok !== false
    } catch {
      closePeer(peer, 'BRIDGE_OFFLINE', 'The bridge connection failed while sending a message.')
      return false
    }
  }

  function closePeer(peer, code, message) {
    if (peer.closed) return
    peer.closed = true
    clearTimeout(peer.authTimer)
    peers.delete(peer.id)
    if (peer.sessionId && ownedSessions.get(peer.sessionId) === peer) ownedSessions.delete(peer.sessionId)
    failPendingFor(peer, err(code, message))
    try { peer.connection.close?.(1000, code) } catch { /* transport already gone */ }
    log(`bridge peer ${peer.id} closed: ${code}`)
    emit({ type: 'peer-closed', peerId: peer.id, code, message })
  }

  function handleMessage(peer, raw) {
    if (peer.closed) return
    peer.lastSeenAt = Date.now()
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      closePeer(peer, 'BRIDGE_PROTOCOL_ERROR', 'Bridge messages must be JSON.')
      return
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      closePeer(peer, 'BRIDGE_PROTOCOL_ERROR', 'Bridge messages require a type.')
      return
    }
    if (message.type === 'hello') return handleHello(peer, message)
    if (!peer.authenticated) {
      closePeer(peer, 'BRIDGE_UNAUTHENTICATED', 'Authenticate before sending bridge requests.')
      return
    }
    if (message.type === 'response') return handleResponse(peer, message)
    if (message.type === 'event') return handleEvent(peer, message)
    if (message.type === 'request') {
      // The server never accepts model-facing requests from a browser peer.
      closePeer(peer, 'BRIDGE_PROTOCOL_ERROR', 'The bridge server does not accept requests from peers.')
      return
    }
    closePeer(peer, 'BRIDGE_PROTOCOL_ERROR', `Unsupported bridge message type: ${message.type}`)
  }

  function handleHello(peer, message) {
    if (peer.authenticated) {
      closePeer(peer, 'BRIDGE_PROTOCOL_ERROR', 'The peer already authenticated.')
      return
    }
    if (message.nonce !== peer.nonce) {
      closePeer(peer, 'BRIDGE_UNAUTHENTICATED', 'The authentication challenge did not match.')
      return
    }
    const token = typeof message.token === 'string' ? message.token.trim() : ''
    const record = token.length >= 32 ? findToken(token) : undefined
    if (!record) {
      log(`bridge peer ${peer.id} rejected: invalid token`)
      emit({ type: 'auth-failed', peerId: peer.id })
      closePeer(peer, 'BRIDGE_UNAUTHORIZED', 'The connection token is invalid or expired.')
      return
    }
    if (record.expiresAt && record.expiresAt < Date.now()) {
      emit({ type: 'auth-failed', peerId: peer.id })
      closePeer(peer, 'BRIDGE_UNAUTHORIZED', 'The connection token has expired.')
      return
    }
    const tokenId = fingerprint(token)
    // A reconnect on the same session replaces the stale connection, so a suspended or reloaded
    // extension tab cannot keep receiving requests. Distinct sessions stay distinct peers.
    const sessionId = peer.session ?? tokenId
    const existing = ownedSessions.get(sessionId)
    if (existing && existing !== peer) closePeer(existing, 'BRIDGE_REPLACED', 'A newer connection replaced this one.')
    peer.authenticated = true
    peer.sessionId = sessionId
    peer.tokenId = tokenId
    peer.label = typeof message.label === 'string' ? message.label.slice(0, 80) : undefined
    peer.extensionVersion = typeof message.extensionVersion === 'string' ? message.extensionVersion.slice(0, 40) : undefined
    ownedSessions.set(sessionId, peer)
    clearTimeout(peer.authTimer)
    send(peer, { type: 'ready', protocol: 1, peerId: peer.id, methods: [...methods], maxMessageBytes: MAX_MESSAGE_BYTES })
    log(`bridge peer ${peer.id} authenticated`)
    emit({ type: 'peer-authenticated', peerId: peer.id })
  }

  function findToken(token) {
    // Read through a live source so revocation and rotation take effect without a restart.
    const records = typeof options.tokens === 'function' ? options.tokens() : options.tokens ?? []
    for (const record of records) {
      if (record && safeEqual(record.token, token)) return record
    }
    return undefined
  }

  function handleResponse(peer, message) {
    const entry = pending.get(message.requestId)
    if (!entry) {
      log(`bridge peer ${peer.id} answered unknown request ${String(message.requestId).slice(0, 40)}`)
      return
    }
    if (entry.peer !== peer) {
      // A different peer must never satisfy another connection's request.
      log(`bridge request ${entry.id} was answered by the wrong peer`)
      return
    }
    clearTimeout(entry.timer)
    pending.delete(entry.id)
    peer.pending = Math.max(0, peer.pending - 1)
    if (message.ok === true) entry.resolve(message.result)
    else entry.reject(err(mapErrorCode(message.error?.code), normalizeErrorMessage(message.error)))
  }

  function handleEvent(peer, message) {
    if (!peer.authenticated) return
    emit({ type: 'peer-event', peerId: peer.id, event: message.event, data: message.data })
  }

  /** Choose the peer that should serve a request. Ambiguity is an error, never a guess. */
  function selectPeer(requestedPeerId) {
    if (requestedPeerId) {
      const peer = peers.get(requestedPeerId)
      if (!peer || !peer.authenticated) throw err('BRIDGE_OFFLINE', `The bridge peer ${requestedPeerId} is not connected.`)
      return peer
    }
    const candidates = [...peers.values()].filter(peer => peer.authenticated && !peer.closed)
    if (candidates.length === 0) throw err('BRIDGE_OFFLINE', 'No Chrome extension is connected to the bridge.')
    if (candidates.length > 1) throw err('BRIDGE_AMBIGUOUS', 'More than one Chrome extension is connected. Specify peerId.')
    return candidates[0]
  }

  /** Dispatch one method to a Chrome extension and await its response. */
  function request(method, params = {}, requestOptions = {}) {
    if (!methods.has(method)) return Promise.reject(err('BRIDGE_METHOD_NOT_ALLOWED', `The bridge does not allow the method ${method}.`))
    let peer
    try {
      peer = selectPeer(requestOptions.peerId)
    } catch (error) {
      return Promise.reject(error)
    }
    if (peer.pending >= maxPending) return Promise.reject(err('BRIDGE_BUSY', 'The Chrome extension has too many outstanding requests.'))
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs
    const id = `req-${randomUUID().slice(0, 12)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        peer.pending = Math.max(0, peer.pending - 1)
        // Tell the extension to stop working on a request nobody is waiting for any more.
        send(peer, { type: 'cancel', requestId: id })
        reject(err('BRIDGE_TIMEOUT', `The Chrome extension did not answer ${method} within ${timeoutMs} ms.`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { id, peer, method, timer, resolve, reject, startedAt: Date.now() })
      peer.pending += 1
      if (requestOptions.signal) {
        const onAbort = () => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          clearTimeout(entry.timer)
          peer.pending = Math.max(0, peer.pending - 1)
          send(peer, { type: 'cancel', requestId: id })
          reject(err('BRIDGE_ABORTED', `The bridge request for ${method} was cancelled.`))
        }
        if (requestOptions.signal.aborted) { onAbort(); return }
        requestOptions.signal.addEventListener('abort', onAbort, { once: true })
      }
      send(peer, { type: 'request', requestId: id, method, params })
    })
  }

  /** The authenticated peer ids, in connection order. */
  function peerIds() {
    return [...peers.values()].filter(peer => peer.authenticated).map(peer => peer.id)
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function closeAll(reason = 'The bridge server is shutting down.') {
    for (const peer of [...peers.values()]) closePeer(peer, 'BRIDGE_OFFLINE', reason)
  }

  return { register, handleMessage, request, status, peerIds, subscribe, closePeer, closeAll, selectPeer,
    get hasPeers() { return peerIds().length > 0 } }
}

/** Map an extension error code onto a stable bridge code. */
export function mapErrorCode(code) {
  const known = new Set([
    'ELEMENT_NOT_FOUND', 'ELEMENT_STALE', 'ELEMENT_AMBIGUOUS', 'ELEMENT_NOT_EDITABLE', 'ELEMENT_NOT_SELECT',
    'TAB_NOT_FOUND', 'TAB_UNAVAILABLE', 'FRAME_UNSUPPORTED', 'PERMISSION_DENIED', 'NAVIGATION_FAILED',
    'PAGE_UNSUPPORTED', 'INVALID_PARAMS', 'TIMEOUT', 'INTERNAL',
  ])
  const value = typeof code === 'string' ? code.toUpperCase() : ''
  if (known.has(value)) return value
  if (value.startsWith('ELEMENT_')) return 'ELEMENT_STALE'
  return 'BRIDGE_REMOTE_ERROR'
}

export function normalizeErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'The Chrome extension reported an unknown error.'
  return message.trim().replace(/\s+/g, ' ').slice(0, 500)
}
