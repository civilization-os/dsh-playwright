/**
 * Chrome Bridge hub and server tests.
 *
 * A fake Chrome extension drives the real bridge over a real WebSocket, so authentication,
 * request correlation, timeouts, cancellation, and disconnect handling are verified end to end
 * without needing a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startChromeBridgeServer, createPairingToken, createSessionStore, mountChromeBridge } from '../src/bridge/server.js'
import { createChromeBridgeHub, mapErrorCode, normalizeErrorMessage } from '../src/bridge/hub.js'
import { connectWebSocket } from '../src/bridge/websocket.js'

const json = async response => ({ status: response.status, body: await response.json() })

/** Bring up a bridge server plus a helper that connects authenticated fake extensions. */
async function bridgeFixture(t, options = {}) {
  const tokens = options.tokens ?? [createPairingToken('test')]
  const server = await startChromeBridgeServer({ tokens: () => tokens, port: 0, ...options })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}${server.path}`
  const wsUrl = `ws://127.0.0.1:${server.port}${server.path}`

  const openSession = async token => {
    const response = await fetch(`${base}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    })
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
    return { response, cookie }
  }

  /**
   * Connect a peer. `handler` runs for every bridge request the server sends.
   * `onmessage` is provided at construction so no frame can be missed between connect and setup.
   */
  const connectPeer = async (handler, connectOptions = {}) => {
    const inbox = []
    const connection = await connectWebSocket(wsUrl, {
      ...connectOptions,
      onmessage: text => {
        const message = JSON.parse(text)
        inbox.push(message)
        if (message.type === 'request') handler?.(message, connection)
      },
    })
    return { connection, inbox }
  }

  const waitFor = (inbox, predicate, label) => new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = inbox.find(predicate)
      if (found) { clearInterval(timer); resolve(found) }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error(`timed out waiting for ${label}`)) }
    }, 5)
  })

  /** Connect, answer the challenge, and wait for `ready`. */
  const connectAuthenticatedPeer = async (handler, connectOptions = {}) => {
    const { connection, inbox } = await connectPeer(handler, connectOptions)
    const challenge = await waitFor(inbox, message => message.type === 'challenge', 'challenge')
    connection.send(JSON.stringify({
      type: 'hello', nonce: challenge.nonce, token: tokens[0].token,
      label: connectOptions.label, extensionVersion: '0.1.0',
    }))
    const ready = await waitFor(inbox, message => message.type === 'ready', 'ready')
    return { connection, inbox, challenge, ready }
  }

  return { server, tokens, base, wsUrl, openSession, connectPeer, connectAuthenticatedPeer, waitFor }
}

test('an unauthenticated peer cannot reach the browser methods', async t => {
  const fixture = await bridgeFixture(t)
  // No session cookie at all: the upgrade is refused before any protocol traffic.
  await assert.rejects(connectWebSocket(fixture.wsUrl), /401/)
  // A valid session cookie but no challenge answer must also stay unauthenticated.
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection } = await fixture.connectPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fixture.server.hub.peerIds().length, 0)
  await assert.rejects(fixture.server.hub.request('browser.snapshot', {}), error => error.code === 'BRIDGE_OFFLINE')
})

test('session creation requires the exact pairing token and sets a scoped HttpOnly cookie', async t => {
  const fixture = await bridgeFixture(t)
  const post = token => fetch(`${fixture.base}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  })
  assert.equal((await post('too-short')).status, 401)
  assert.equal((await post('z'.repeat(43))).status, 401)
  assert.equal((await post('')).status, 401)

  const accepted = await post(fixture.tokens[0].token)
  assert.equal(accepted.status, 200)
  const setCookie = accepted.headers.getSetCookie()[0]
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, new RegExp(`Path=${fixture.server.path}`))
  assert.equal(/;\s*Secure/.test(setCookie), false, 'a plain ws:// bridge must not claim Secure')
  const body = await accepted.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.protocol, 1)
})

test('session endpoints reject an unsupported method', async t => {
  const fixture = await bridgeFixture(t)
  const response = await fetch(`${fixture.base}/session`, { method: 'GET' })
  assert.equal(response.status, 405)
  const missing = await fetch(`${fixture.base}/nope`)
  assert.equal(missing.status, 404)
})

test('a peer that answers the challenge with the right token becomes authenticated', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  assert.ok(cookie, 'a session cookie must be issued')

  const { connection, inbox } = await fixture.connectPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  const challenge = await fixture.waitFor(inbox, message => message.type === 'challenge', 'challenge')
  assert.equal(challenge.protocol, 1)
  assert.ok(challenge.methods.includes('browser.snapshot'))

  connection.send(JSON.stringify({ type: 'hello', nonce: 'wrong', token: fixture.tokens[0].token }))
  const closed = await new Promise(resolve => { connection.onclose = (code, reason) => resolve({ code, reason }) })
  assert.equal(closed.reason, 'BRIDGE_UNAUTHENTICATED')
  assert.equal(fixture.server.hub.peerIds().length, 0)
})

test('a bad token is rejected with a clear close reason', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection, inbox } = await fixture.connectPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  const challenge = await fixture.waitFor(inbox, message => message.type === 'challenge', 'challenge')
  const closed = new Promise(resolve => { connection.onclose = (code, reason) => resolve(reason) })
  connection.send(JSON.stringify({ type: 'hello', nonce: challenge.nonce, token: 'z'.repeat(43) }))
  assert.equal(await closed, 'BRIDGE_UNAUTHORIZED')
})

test('requests are matched to responses and remote errors keep their code', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection } = await fixture.connectAuthenticatedPeer((message, client) => {
    if (message.params?.fail) {
      client.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: false, error: { code: 'ELEMENT_STALE', message: 'The element was replaced.' } }))
      return
    }
    client.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: { url: 'https://example.com/', title: 'Example', echoed: message.params } }))
  }, { headers: { cookie } })
  t.after(() => connection.close())

  const result = await fixture.server.hub.request('browser.snapshot', { pageId: 'active', mode: 'form' })
  assert.deepEqual(result, { url: 'https://example.com/', title: 'Example', echoed: { pageId: 'active', mode: 'form' } })

  await assert.rejects(
    fixture.server.hub.request('browser.act', { ref: 'c-1', action: 'click', fail: true }),
    error => error.code === 'ELEMENT_STALE' && /replaced/.test(error.message),
  )

  // A response for an unknown request id must be ignored rather than crashing the hub.
  connection.send(JSON.stringify({ type: 'response', requestId: 'req-unknown', ok: true, result: {} }))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(await fixture.server.hub.request('bridge.ping', {}).then(() => 'alive'), 'alive')
})

test('a timeout rejects, reports BRIDGE_TIMEOUT, and tells the extension to cancel', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const cancels = []
  const { connection } = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  connection.onmessage = text => { const message = JSON.parse(text); if (message.type === 'cancel') cancels.push(message.requestId) }

  const started = Date.now()
  await assert.rejects(
    fixture.server.hub.request('browser.snapshot', {}, { timeoutMs: 250 }),
    error => error.code === 'BRIDGE_TIMEOUT',
  )
  assert.ok(Date.now() - started >= 240, 'the timeout must actually wait')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(cancels.length, 1)
})

test('an aborted request rejects and cancels the remote work', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const cancels = []
  const { connection } = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  connection.onmessage = text => { const message = JSON.parse(text); if (message.type === 'cancel') cancels.push(message.requestId) }

  const controller = new AbortController()
  const pending = fixture.server.hub.request('browser.snapshot', {}, { signal: controller.signal, timeoutMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 40))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'BRIDGE_ABORTED')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(cancels.length, 1)
})

test('a disconnect fails in-flight work immediately instead of waiting for the timeout', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection } = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  const pending = fixture.server.hub.request('browser.snapshot', {}, { timeoutMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 50))
  const started = Date.now()
  connection.close(1000, 'user disconnected')
  await assert.rejects(pending, error => error.code === 'BRIDGE_OFFLINE')
  assert.ok(Date.now() - started < 1000, 'the failure must be immediate')
  await assert.rejects(fixture.server.hub.request('bridge.ping', {}), error => error.code === 'BRIDGE_OFFLINE')
})

test('only allowlisted methods are reachable, so no arbitrary JavaScript is representable', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection } = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  for (const method of ['page.evaluate', 'eval', 'shell.exec', 'browser.cookies']) {
    await assert.rejects(fixture.server.hub.request(method, {}), error => error.code === 'BRIDGE_METHOD_NOT_ALLOWED')
  }
})

test('two connections sharing a token: the newer one replaces the older', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const first = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  const firstClosed = new Promise(resolve => { first.connection.onclose = (code, reason) => resolve(reason) })
  const second = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  t.after(() => second.connection.close())
  assert.equal(await firstClosed, 'BRIDGE_REPLACED')
  assert.deepEqual(fixture.server.hub.peerIds(), [second.ready.peerId])
})

test('distinct tokens keep distinct peers, and an ambiguous dispatch is refused', async t => {
  const fixture = await bridgeFixture(t, { tokens: [createPairingToken('one'), createPairingToken('two')] })
  const a = await fixture.openSession(fixture.tokens[0].token)
  const b = await fixture.openSession(fixture.tokens[1].token)
  const first = await fixture.connectAuthenticatedPeer((message, client) => {
    client.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: { from: 'one' } }))
  }, { headers: { cookie: a.cookie } })
  const second = await fixture.connectAuthenticatedPeer((message, client) => {
    client.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: { from: 'two' } }))
  }, { headers: { cookie: b.cookie } })
  t.after(() => { first.connection.close(); second.connection.close() })
  assert.equal(fixture.server.hub.peerIds().length, 2)
  await assert.rejects(fixture.server.hub.request('bridge.ping', {}), error => error.code === 'BRIDGE_AMBIGUOUS')
  // Naming the peer resolves the ambiguity and routes to that extension.
  const result = await fixture.server.hub.request('bridge.ping', {}, { peerId: second.ready.peerId })
  assert.deepEqual(result, { from: 'two' })
  // A peer id that is not connected is reported rather than silently retargeted.
  await assert.rejects(fixture.server.hub.request('bridge.ping', {}, { peerId: 'bridge-missing' }), error => error.code === 'BRIDGE_OFFLINE')
})

test('revoking a session prevents new upgrades', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const revoked = await fetch(`${fixture.base}/session`, { method: 'DELETE', headers: { cookie } })
  assert.equal((await revoked.json()).ok, true)
  await assert.rejects(connectWebSocket(fixture.wsUrl, { headers: { cookie } }), /401/)
})

test('origin allowlisting rejects a browser origin that is not listed', async t => {
  const fixture = await bridgeFixture(t, { allowedOrigins: ['chrome-extension://allowed'] })
  const blocked = await fetch(`${fixture.base}/health`, { headers: { origin: 'https://evil.example' } })
  assert.equal(blocked.status, 403)
  const allowed = await fetch(`${fixture.base}/health`, { headers: { origin: 'chrome-extension://allowed' } })
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json()).value.service, 'dsh-chrome-bridge')
})

test('health reports protocol, TLS state, and connected peers without leaking tokens', async t => {
  const fixture = await bridgeFixture(t)
  const { cookie } = await fixture.openSession(fixture.tokens[0].token)
  const { connection } = await fixture.connectAuthenticatedPeer(undefined, { headers: { cookie } })
  t.after(() => connection.close())
  const health = await fetch(`${fixture.base}/health`).then(response => response.json())
  assert.equal(health.value.protocol, 1)
  assert.equal(health.value.tls, false)
  assert.equal(health.value.peers.length, 1)
  assert.equal(health.value.peers[0].authenticated, true)
  assert.equal(JSON.stringify(health).includes(fixture.tokens[0].token), false, 'the token must never appear in a response')
})

test('mounting rejects a caller that does not provide routing hooks', () => {
  assert.throws(() => mountChromeBridge({ tokens: [] }), /register and registerUpgrade/)
})

test('the hub maps unknown remote codes to a stable bridge code', () => {
  assert.equal(mapErrorCode('element_stale'), 'ELEMENT_STALE')
  assert.equal(mapErrorCode('ELEMENT_WEIRD'), 'ELEMENT_STALE')
  assert.equal(mapErrorCode('SOMETHING_ELSE'), 'BRIDGE_REMOTE_ERROR')
  assert.equal(mapErrorCode(undefined), 'BRIDGE_REMOTE_ERROR')
  assert.equal(normalizeErrorMessage({ message: '  a   b  ' }), 'a b')
  assert.equal(normalizeErrorMessage(undefined).length > 0, true)
  assert.equal(normalizeErrorMessage({ message: 'x'.repeat(900) }).length, 500)
})

test('session store expires, prunes, and revokes by token', () => {
  let now = 1000
  const store = createSessionStore({ ttlMs: 100 })
  const original = Date.now
  Date.now = () => now
  try {
    const session = store.issue('token-a')
    assert.equal(store.resolve(session.id)?.tokenId, 'token-a')
    assert.equal(store.size, 1)
    now += 200
    assert.equal(store.resolve(session.id), undefined, 'an expired session must not resolve')
    const second = store.issue('token-a')
    const third = store.issue('token-b')
    assert.equal(store.revokeToken('token-a'), 1)
    assert.equal(store.resolve(second.id), undefined)
    assert.ok(store.resolve(third.id))
    assert.equal(store.revoke(third.id), true)
    assert.equal(store.size, 0)
    store.issue('token-c')
    now += 500
    assert.equal(store.prune(), 1)
  } finally {
    Date.now = original
  }
})

test('a hub without tokens refuses every authentication attempt', async t => {
  const hub = createChromeBridgeHub({ tokens: () => [] })
  const sent = []
  const peer = hub.register({ send: message => { sent.push(JSON.parse(message)); return true }, close: () => {} }, {})
  assert.equal(sent[0].type, 'challenge')
  hub.handleMessage(peer, JSON.stringify({ type: 'hello', nonce: sent[0].nonce, token: 'a'.repeat(43) }))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(hub.peerIds().length, 0)
})
