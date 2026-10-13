/**
 * Chrome Bridge server: the HTTP(S) + WebSocket endpoint the browser extension connects to.
 *
 * Trust model
 * -----------
 * The extension never puts its pairing token in the WebSocket URL. It exchanges the token for a
 * short-lived HttpOnly session cookie over HTTPS at `<path>/session`, then presents that cookie
 * during the upgrade. Session identifiers therefore stay out of server access logs, out of the
 * browser's extension history, and out of shell history.
 *
 * The transport never carries model-authored JavaScript: only the method allowlist in hub.js is
 * reachable, and every method addresses a snapshot reference inside one user-selected tab.
 *
 * Hosting
 * -------
 * `mountChromeBridge` attaches to an existing HTTP server, which is how the plugin reuses DSH's
 * own `webServer` (`register` / `registerUpgrade`) instead of opening another public port.
 * `startChromeBridgeServer` runs its own listener for standalone or TLS-terminating deployments.
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { handleUpgrade, readCookie, safeEqual, MAX_HEADER_BYTES } from './websocket.js'
import { MAX_MESSAGE_BYTES, createChromeBridgeHub } from './hub.js'

export const DEFAULT_BRIDGE_PATH = '/chrome-bridge'
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024
/** Reject requests whose head grows past the supported size. */
function guardRequestSize(request, socket) {
  if (!socket) return
  let size = 0
  const onData = chunk => {
    size += chunk.length
    if (size > MAX_HEADER_BYTES) {
      socket.destroy()
      request.off('data', onData)
    }
  }
  request.on('data', onData)
  request.on('close', () => request.off('data', onData))
}

function writeJson(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

async function readJsonBody(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk.toString('utf8')
    if (raw.length > MAX_BODY_BYTES) throw new Error('The request body is too large.')
  }
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

/** Short-lived session identifiers exchanged for a pairing token. Only hashes are retained. */
export function createSessionStore(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
  const sessions = new Map()
  const keyOf = value => createHash('sha256').update(value).digest('hex')
  return {
    issue(tokenId) {
      const id = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + ttlMs
      sessions.set(keyOf(id), { id, tokenId, expiresAt })
      return { id, expiresAt }
    },
    /** Resolve a session cookie value to its record, dropping it when stale. */
    resolve(value) {
      if (typeof value !== 'string' || value.length === 0) return undefined
      const key = keyOf(value)
      const record = sessions.get(key)
      if (!record) return undefined
      if (record.expiresAt < Date.now()) { sessions.delete(key); return undefined }
      return record
    },
    revoke(value) {
      if (typeof value !== 'string') return false
      return sessions.delete(keyOf(value))
    },
    revokeToken(tokenId) {
      let removed = 0
      for (const [key, record] of sessions) {
        if (record.tokenId === tokenId) { sessions.delete(key); removed += 1 }
      }
      return removed
    },
    clear() { sessions.clear() },
    get size() { return sessions.size },
    /** Drop expired sessions so a long-lived server does not grow without bound. */
    prune() {
      const now = Date.now()
      let removed = 0
      for (const [key, record] of sessions) if (record.expiresAt < now) { sessions.delete(key); removed += 1 }
      return removed
    },
  }
}

/**
 * Build the bridge from an existing HTTP server's routing primitives.
 *
 * `register(route)` and `registerUpgrade(route)` must behave like the DeepSeek Harness webServer
 * service: `register` takes `{ kind: 'prefix', path, handler }`, `registerUpgrade` takes
 * `{ path, handler }`. `publicUrl` is advertised to the extension popup and may be undefined when
 * the bridge cannot know its own externally reachable address.
 */
export function mountChromeBridge({ register, registerUpgrade, publicUrl, ...options }) {
  if (typeof register !== 'function' || typeof registerUpgrade !== 'function') {
    throw new Error('mountChromeBridge requires register and registerUpgrade functions.')
  }
  const path = options.path ?? DEFAULT_BRIDGE_PATH
  const log = options.logger ?? (() => {})
  const sessions = options.sessions ?? createSessionStore({ ttlMs: options.sessionTtlMs })
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(value => String(value).toLowerCase()))
  let listening = true

  const hub = options.hub ?? createChromeBridgeHub({
    tokens: options.tokens,
    log,
    timeoutMs: options.timeoutMs,
    methods: options.methods,
    isListening: () => listening,
  })

  const originAllowed = origin => allowedOrigins.size === 0 || (typeof origin === 'string' && allowedOrigins.has(origin.toLowerCase()))

  function validatePairingToken(value, source) {
    const token = typeof value === 'string' ? value.trim() : ''
    if (token.length < 32) return undefined
    const records = typeof source === 'function' ? source() : source ?? []
    for (const record of records) {
      if (!record || !safeEqual(record.token, token)) continue
      if (record.expiresAt && record.expiresAt < Date.now()) return undefined
      return record
    }
    return undefined
  }

  async function handler(request, response) {
    guardRequestSize(request, request.socket)
    try {
      const url = new URL(request.url ?? '/', 'http://bridge.internal')
      if (!originAllowed(request.headers.origin)) {
        writeJson(response, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'This origin is not allowed to use the bridge.' } })
        return
      }
      if (url.pathname === `${path}/health`) {
        writeJson(response, 200, { ok: true, value: { service: 'dsh-chrome-bridge', protocol: 1, tls: Boolean(options.tls), publicUrl, ...hub.status() } })
        return
      }
      if (url.pathname === `${path}/session`) {
        if (request.method === 'DELETE') {
          sessions.revoke(readCookie(request.headers.cookie, 'dsh_bridge_session'))
          writeJson(response, 200, { ok: true, value: { revoked: true } })
          return
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to create a bridge session, or DELETE to revoke one.' } })
          return
        }
        let body
        try { body = await readJsonBody(request) } catch (error) {
          writeJson(response, 400, { ok: false, error: { code: 'INVALID_BODY', message: String(error?.message || 'Invalid request body.') } })
          return
        }
        const record = validatePairingToken(body?.token, options.tokens)
        if (!record) {
          log('bridge session rejected: invalid or expired pairing token')
          writeJson(response, 401, { ok: false, error: { code: 'BRIDGE_UNAUTHORIZED', message: 'The pairing token is invalid or expired.' } })
          return
        }
        const session = sessions.issue(record.id ?? 'default')
        log(`bridge session issued for token ${record.id ?? 'default'}`)
        const maxAgeSeconds = Math.floor((options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 1000)
        // SameSite=Strict is correct here: the extension calls this endpoint itself, and the cookie
        // is only ever presented back to the bridge path.
        writeJson(response, 200, { ok: true, value: { expiresAt: session.expiresAt, path, protocol: 1 } }, {
          'set-cookie': `dsh_bridge_session=${session.id}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${maxAgeSeconds}${options.tls ? '; Secure' : ''}`,
        })
        return
      }
      writeJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not Found' } })
    } catch (error) {
      log(`bridge http error: ${String(error?.message || error)}`)
      if (!response.headersSent) writeJson(response, 500, { ok: false, error: { code: 'BRIDGE_ERROR', message: 'The bridge failed to handle the request.' } })
      else response.end()
    }
  }

  function upgradeHandler(request, socket, head) {
    let peer
    try {
      const url = new URL(request.url ?? '/', 'http://bridge.internal')
      if (url.pathname !== path) {
        socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        return
      }
      const session = sessions.resolve(readCookie(request.headers.cookie, 'dsh_bridge_session'))
      if (!session) {
        log('bridge upgrade rejected: no valid session cookie')
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        return
      }
      if (!originAllowed(request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        return
      }
      const connection = handleUpgrade(request, socket, head, {
        path,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        onmessage: text => { if (peer) hub.handleMessage(peer, text) },
        onclose: () => { if (peer) hub.closePeer(peer, 'BRIDGE_OFFLINE', 'The Chrome extension disconnected.') },
        onprotocolerror: error => log(`bridge protocol error: ${error.message}`),
      })
      if (!connection) return
      peer = hub.register(connection, { userAgent: request.headers['user-agent'], origin: request.headers.origin, session: session.id })
      peer.sessionTokenId = session.tokenId
    } catch (error) {
      log(`bridge upgrade failed: ${String(error?.message || error)}`)
      try { socket.destroy() } catch { /* already closed */ }
    }
  }

  const disposers = [
    register({ kind: 'prefix', path, handler }),
    registerUpgrade({ path, handler: upgradeHandler }),
  ]

  return {
    hub,
    sessions,
    path,
    handler,
    upgradeHandler,
    publicUrl,
    async close() {
      if (!listening) return
      listening = false
      hub.closeAll('The bridge server is shutting down.')
      sessions.clear()
      for (const dispose of disposers.reverse()) {
        try { await dispose?.() } catch { /* route owners may already be gone */ }
      }
    },
  }
}

/**
 * Start the bridge on its own listener. Use this for a standalone deployment or when the bridge
 * itself must terminate TLS. Hosting on DSH's existing webServer through `mountChromeBridge` is
 * preferred because it needs no extra port.
 */
export async function startChromeBridgeServer(options = {}) {
  const tls = options.tls ?? await loadTls(options.tlsFiles, readFile)
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }) : createHttpServer()
  // The bridge is long-lived and low-volume; a slow request must not hold the server open.
  server.requestTimeout = 20000
  server.headersTimeout = 15000
  const host = options.host ?? '127.0.0.1'
  const mount = mountChromeBridge({
    ...options,
    tls: Boolean(tls),
    // A private listener owns its whole request surface, so the prefix and upgrade routes are
    // simply installed as the server's listeners.
    register: route => {
      const listener = (request, response) => route.handler(request, response)
      server.on('request', listener)
      return () => server.off('request', listener)
    },
    registerUpgrade: route => {
      const listener = (request, socket, head) => route.handler(request, socket, head)
      server.on('upgrade', listener)
      return () => server.off('upgrade', listener)
    },
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const scheme = tls ? 'wss' : 'ws'
  const address = server.address()
  const publicHost = options.publicHost ?? `${host}:${address.port}`
  mount.publicUrl = `${scheme}://${publicHost}${mount.path}`
  mount.server = server
  mount.port = address.port
  mount.tls = Boolean(tls)
  const closeMount = mount.close
  mount.close = async () => {
    await closeMount()
    await new Promise(resolve => {
      server.close(() => resolve())
      // Idle keep-alive sockets would otherwise delay shutdown indefinitely.
      server.closeIdleConnections?.()
      setTimeout(() => { server.closeAllConnections?.(); resolve() }, 500).unref?.()
    })
  }
  return mount
}

async function loadTls(files, readFileImpl) {
  if (!files?.key || !files?.cert) return undefined
  const [key, cert] = await Promise.all([readFileImpl(files.key), readFileImpl(files.cert)])
  return { key, cert }
}

/** Generate a new pairing token record. */
export function createPairingToken(label) {
  return {
    id: `token-${randomUUID().slice(0, 8)}`,
    token: randomBytes(32).toString('base64url'),
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : 'default',
    createdAt: Date.now(),
  }
}
