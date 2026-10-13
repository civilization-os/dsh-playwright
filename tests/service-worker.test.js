/**
 * Service worker tests.
 *
 * The MV3 worker is exercised against a stub of the Chrome extension APIs and a stub WebSocket, so
 * the routing, tab selection, session handshake, and error reporting are verified without a
 * browser. The `whoami` reply and the cross-tab guard together are what stop a request aimed at one
 * tab from being serviced by another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------------------------
// Chrome API stubs. These must exist before the worker module is imported.
// ---------------------------------------------------------------------------------------------

function createChromeStub(options = {}) {
  const listeners = { runtime: [], action: [], alarms: [] }
  const calls = { sendMessage: [], tabsUpdate: [], tabsCreate: [], tabsRemove: [], executeScript: [], permissionsRequest: [], storage: [], badge: [] }
  const stored = { ...(options.stored ?? {}) }
  const session = { ...(options.session ?? {}) }
  const tabs = options.tabs ?? []
  const responses = options.responses ?? {}
  const granted = new Set(options.granted ?? [])

  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: { addListener: listener => listeners.runtime.push(listener) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: async (message, ...rest) => {
        calls.sendMessage.push(message)
        const responder = options.onSendMessage
        if (responder) return responder(message, ...rest)
        return undefined
      },
    },
    action: {
      setBadgeText: async value => { calls.badge.push(['text', value]) },
      setBadgeBackgroundColor: async value => { calls.badge.push(['color', value]) },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: listener => listeners.alarms.push(listener) },
    },
    storage: {
      local: {
        get: async defaults => {
          const result = { ...defaults }
          for (const key of Object.keys(defaults ?? {})) if (key in stored) result[key] = stored[key]
          return result
        },
        set: async value => { calls.storage.push(value); Object.assign(stored, value) },
      },
      session: {
        get: async defaults => {
          const result = { ...defaults }
          for (const key of Object.keys(defaults ?? {})) if (key in session) result[key] = session[key]
          return result
        },
        set: async value => { calls.storage.push(value); Object.assign(session, value) },
      },
    },
    permissions: {
      contains: async ({ origins }) => origins.every(origin => granted.has(origin)),
      request: async ({ origins }) => { calls.permissionsRequest.push(origins); for (const origin of origins) granted.add(origin); return true },
    },
    tabs: {
      query: async query => tabs.filter(tab => (query.active === undefined || tab.active === query.active) && (query.lastFocusedWindow === undefined || tab.windowId === 1)),
      get: async id => {
        const tab = tabs.find(item => item.id === id)
        if (!tab) throw new Error(`No tab with id ${id}`)
        return tab
      },
      create: async value => { calls.tabsCreate.push(value); const tab = { id: 900, url: value.url ?? 'about:blank', title: '', active: false, windowId: 1 }; tabs.push(tab); return tab },
      remove: async id => { calls.tabsRemove.push(id); const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1) },
      update: async (id, value) => { calls.tabsUpdate.push([id, value]); const tab = tabs.find(item => item.id === id); Object.assign(tab, value); return tab },
      sendMessage: async (tabId, message) => {
        const responder = responses[tabId] ?? options.onTabMessage
        if (!responder) throw new Error('Could not establish connection. Receiving end does not exist.')
        return responder(message, tabId)
      },
    },
    scripting: {
      executeScript: async value => { calls.executeScript.push(value); return [] },
    },
  }
  return { chrome, listeners, calls, stored, session, tabs, granted }
}

/** Minimal WebSocket double that records frames and can be driven from the test. */
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  send(data) { this.sent.push(JSON.parse(data)) }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason })
  }

  /** Simulate the socket opening. */
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatch('open', {}) }

  /** Simulate a frame arriving from the bridge. */
  receive(message) { this.dispatch('message', { data: JSON.stringify(message) }) }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** Import the worker once per (stubbed) environment. */
async function loadWorker(stubOptions = {}) {
  const stub = createChromeStub(stubOptions)
  globalThis.chrome = stub.chrome
  globalThis.WebSocket = FakeWebSocket
  globalThis.fetch = stubOptions.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { expiresAt: Date.now() + 1000, protocol: 1 } }) }))
  FakeWebSocket.instances = []
  // A unique query string defeats the module cache so each test gets fresh worker state.
  const module = await import(`../extension/service-worker.js?case=${Math.random().toString(36).slice(2)}`)
  // Let the module-level connect() settle so assertions start from a known state.
  await new Promise(resolve => setTimeout(resolve, 10))
  return { module, stub }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

function activeTab(overrides = {}) {
  return { id: 11, url: 'https://example.com/', title: 'Example', active: true, windowId: 1, ...overrides }
}

// ---------------------------------------------------------------------------------------------

test('normalizeBridgeUrl accepts ws and wss and rejects unsafe forms', async () => {
  const { module } = await loadWorker()
  assert.equal(module.normalizeBridgeUrl('wss://host.example/chrome-bridge').websocketUrl, 'wss://host.example/chrome-bridge')
  assert.equal(module.normalizeBridgeUrl('host.example/chrome-bridge').websocketUrl, 'wss://host.example/chrome-bridge')
  assert.equal(module.normalizeBridgeUrl('ws://127.0.0.1:3080/chrome-bridge').origin, 'ws://127.0.0.1:3080')
  assert.throws(() => module.normalizeBridgeUrl(''), /Enter the bridge URL/)
  assert.throws(() => module.normalizeBridgeUrl('https://host.example/x'), /must use ws:\/\/ or wss:\/\//)
  assert.throws(() => module.normalizeBridgeUrl('wss://user:pass@host.example/x'), /must not contain credentials/)
})

test('a plain ws:// bridge is refused unless it is loopback', async () => {
  const { module, stub } = await loadWorker({ granted: ['http://192.168.1.10:3080/*'], stored: { bridgeUrl: 'ws://192.168.1.10:3080/chrome-bridge' }, session: { pairingToken: 'a'.repeat(43) } })
  const status = await module.connect()
  assert.equal(status.status, 'error')
  assert.match(status.detail, /Refusing a non-TLS bridge address/)
  assert.equal(stub.calls.sendMessage.length >= 0, true)
})

test('a missing host permission produces an actionable error, not a silent failure', async () => {
  const { module } = await loadWorker({ stored: { bridgeUrl: 'wss://host.example/chrome-bridge' }, session: { pairingToken: 'a'.repeat(43) } })
  const status = await module.connect()
  assert.equal(status.status, 'error')
  assert.match(status.detail, /Grant access/)
})

test('the session handshake posts the token as a JSON body, never as a URL query', async () => {
  const requests = []
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'secret-token-value'.repeat(3) },
    fetch: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { protocol: 1 } }) }
    },
  })
  assert.equal(requests.length, 1, `expected exactly one session request, saw ${requests.length}`)
  assert.equal(requests[0].url, 'https://host.example/chrome-bridge/session', 'the wss origin is translated for fetch')
  assert.equal(requests[0].url.includes('secret-token'), false, 'the token must never appear in a URL')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.credentials, 'include')
  assert.equal(JSON.parse(requests[0].init.body).token, 'secret-token-value'.repeat(3))
})

test('an unauthenticated WebSocket close is reported as terminal, not retried', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.dispatch('close', { code: 1000, reason: 'BRIDGE_UNAUTHORIZED' })
  await flush()
  const status = module.statusSnapshot()
  assert.equal(status.status, 'error')
  assert.match(status.detail, /BRIDGE_UNAUTHORIZED/)
})

test('the challenge is answered with the stored token and the protocol version', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge', label: 'Work laptop' },
    session: { pairingToken: 't'.repeat(43) },
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'nonce-value', protocol: 1 })
  await flush()
  const hello = socket.sent.find(message => message.type === 'hello')
  assert.ok(hello, 'the worker must answer the challenge')
  assert.equal(hello.nonce, 'nonce-value')
  assert.equal(hello.token, 't'.repeat(43))
  assert.equal(hello.label, 'Work laptop')
  assert.equal(hello.extensionVersion, '0.1.0')

  socket.receive({ type: 'ready', peerId: 'bridge-1', protocol: 1 })
  await flush()
  assert.equal(module.statusSnapshot().status, 'connected')
  assert.equal(module.statusSnapshot().peerId, 'bridge-1')
})

test('tabs reports the tabs of the focused window with stable page ids', async () => {
  const { module } = await loadWorker({ tabs: [activeTab(), { id: 22, url: 'https://other.example/page', title: 'Other', active: false, windowId: 1 }, { id: 33, url: 'chrome://settings', title: 'Settings', active: false, windowId: 1 }] })
  const result = await module.handleRequest('browser.tabs', { action: 'list' })
  assert.deepEqual(result.pages, [
    { id: 'tab-11', url: 'https://example.com/', title: 'Example', active: true },
    { id: 'tab-22', url: 'https://other.example/page', title: 'Other', active: false },
  ], 'internal Chrome pages must not be exposed')
})

test('only the active tab, or an explicit tab id, is ever targeted', async () => {
  const seen = []
  const { module } = await loadWorker({
    tabs: [activeTab(), { id: 22, url: 'https://other.example/', title: 'Other', active: false, windowId: 1 }],
    onTabMessage: (message, tabId) => {
      seen.push({ tabId, method: message.method, params: message.params })
      if (message.method === 'page.snapshot') return { ok: true, result: { url: 'https://example.com/', title: 'Example', elements: [] } }
      return { ok: true, result: { ok: true } }
    },
  })
  await module.handleRequest('browser.snapshot', { pageId: 'active', tabId: 11 })
  await module.handleRequest('browser.snapshot', { pageId: 'tab-22' })
  await module.handleRequest('browser.open', { pageId: 'tab-22', url: 'https://navigated.example/' })
  assert.equal(seen[0].tabId, 11)
  assert.equal(seen[1].tabId, 22)
  // The snapshot request stamps the resolved tab id so the page agent can verify it.
  assert.equal(seen[0].params.tabId, 11)
  assert.equal(seen[1].params.tabId, 22)
})

test('an invalid page id or action never reaches a tab', async () => {
  const touched = []
  const { module } = await loadWorker({
    tabs: [activeTab()],
    onTabMessage: message => { touched.push(message.method); return { ok: true, result: {} } },
  })
  const expectCode = async (label, promise, code) => {
    try {
      await promise
      assert.fail(`${label}: expected ${code}, but the request resolved`)
    } catch (error) {
      if (error?.code === 'ERR_ASSERTION') throw error
      assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`)
    }
  }

  await expectCode('missing tab', module.handleRequest('browser.snapshot', { pageId: 'tab-999' }), 'TAB_NOT_FOUND')
  await expectCode('unknown page id', module.handleRequest('browser.snapshot', { pageId: 'page-abc' }), 'INVALID_PARAMS')
  await expectCode('malformed tab id', module.handleRequest('browser.snapshot', { pageId: 'tab-notanumber' }), 'INVALID_PARAMS')
  await expectCode('unsupported action', module.handleRequest('browser.act', { pageId: 'tab-11', ref: 'c-1', action: 'scroll' }), 'INVALID_PARAMS')
  await expectCode('missing value', module.handleRequest('browser.act', { pageId: 'tab-11', ref: 'c-1', action: 'fill' }), 'INVALID_PARAMS')
  await expectCode('non-http url', module.handleRequest('browser.open', { pageId: 'tab-11', url: 'file:///etc/passwd' }), 'INVALID_PARAMS')
  // Arbitrary JavaScript and shell execution have no representation in the protocol at all.
  await expectCode('arbitrary js', module.handleRequest('page.evaluate', { code: '1+1' }), 'INVALID_PARAMS')
  await expectCode('shell', module.handleRequest('shell.exec', { command: 'id' }), 'INVALID_PARAMS')

  assert.deepEqual(touched, [], 'a rejected request must never be forwarded to a page agent')
})

test('a missing content script triggers one injection and then succeeds', async () => {
  const { module, stub } = await loadWorker({ tabs: [activeTab()] })
  // First call fails to reach the page, the worker injects, the retry succeeds.
  let injected = false
  globalThis.chrome.tabs.sendMessage = async () => {
    if (!injected) throw new Error('Could not establish connection. Receiving end does not exist.')
    return { ok: true, result: { url: 'https://example.com/', title: 'Example', elements: [] } }
  }
  globalThis.chrome.scripting.executeScript = async value => { injected = true; stub.calls.executeScript.push(value); return [] }
  const result = await module.handleRequest('browser.snapshot', { pageId: 'active' })
  assert.equal(stub.calls.executeScript.length, 1)
  assert.deepEqual(stub.calls.executeScript[0].files, ['content.js'])
  assert.equal(result.pageId, 'tab-11')
})

test('a page that cannot be injected reports PERMISSION_DENIED instead of hanging', async () => {
  const { module } = await loadWorker({ tabs: [activeTab()] })
  globalThis.chrome.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.') }
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page') }
  await assert.rejects(module.handleRequest('browser.snapshot', { pageId: 'active' }), error => error.code === 'PERMISSION_DENIED')
})

test('a restricted page is reported as unsupported rather than operated', async () => {
  const { module } = await loadWorker({ tabs: [activeTab({ url: 'chrome://extensions', title: 'Extensions' })] })
  await assert.rejects(module.handleRequest('browser.snapshot', { pageId: 'active' }), error => error.code === 'PAGE_UNSUPPORTED')
})

test('the popup commands save settings, connect, and disconnect through the worker', async () => {
  const { module, stub } = await loadWorker({ tabs: [activeTab()], granted: ['https://host.example/*'] })
  const listener = stub.listeners.runtime.at(-1)
  const ask = message => new Promise(resolve => { listener(message, {}, resolve) })

  const saved = await ask({ channel: 'dsh-chrome-bridge', command: 'save', bridgeUrl: 'wss://host.example/chrome-bridge', token: 'k'.repeat(43), label: 'Desk' })
  assert.equal(saved.ok, true)
  assert.equal(stub.stored.bridgeUrl, 'wss://host.example/chrome-bridge')
  assert.equal(stub.stored.label, 'Desk')
  // The token is a credential: it must live in session storage, not on disk.
  assert.equal(stub.session.pairingToken, 'k'.repeat(43))
  assert.equal(stub.stored.pairingToken, undefined)

  const rejected = await ask({ channel: 'dsh-chrome-bridge', command: 'save', bridgeUrl: 'https://host.example/' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /ws:\/\/ or wss:\/\//)

  const connected = await ask({ channel: 'dsh-chrome-bridge', command: 'connect' })
  assert.equal(connected.ok, true)
  assert.equal(stub.stored.autoConnect, true)

  const disconnected = await ask({ channel: 'dsh-chrome-bridge', command: 'disconnect' })
  assert.equal(disconnected.ok, true)
  assert.equal(disconnected.status.status, 'disconnected')
  assert.equal(stub.stored.autoConnect, false)
})

test('the worker answers whoami with the sender tab so the page can verify routing', async () => {
  const { stub } = await loadWorker()
  const listener = stub.listeners.runtime.at(-1)
  const reply = await new Promise(resolve => { listener({ channel: 'dsh-chrome-bridge', method: 'whoami' }, { tab: { id: 77 }, frameId: 0 }, resolve) })
  assert.deepEqual(reply, { ok: true, tabId: 77, frameId: 0 })
})

test('a request is only answered after the bridge authenticates the socket', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab()],
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  // A request before the challenge must not be dispatched.
  socket.receive({ type: 'request', requestId: 'req-1', method: 'browser.tabs', params: {} })
  await flush()
  const early = socket.sent.filter(message => message.type === 'response')
  assert.equal(early.length, 1, 'a pre-auth request must be answered with an explicit refusal')
  assert.equal(early[0].ok, false)
  assert.equal(early[0].error.code, 'BRIDGE_UNAUTHENTICATED')

  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-2', method: 'browser.tabs', params: {} })
  await flush()
  const response = socket.sent.filter(message => message.type === 'response' && message.requestId === 'req-2')[0]
  assert.ok(response, 'an authenticated request must be answered')
  assert.equal(response.ok, true)
})

test('a page error is serialized back with its code intact', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab()],
    onTabMessage: message => {
      // A snapshot issues the ref; the later action reports a page error.
      if (message.method === 'page.snapshot') return { ok: true, result: { url: 'https://example.com/', title: 'Example', elements: [{ ref: 'c-1', role: 'button', name: 'Go' }] } }
      return { ok: false, error: { code: 'ELEMENT_STALE', message: 'The element is no longer in the page.' } }
    },
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  // The ref must be issued by this extension before an action may use it.
  socket.receive({ type: 'request', requestId: 'req-3a', method: 'browser.snapshot', params: { pageId: 'tab-11' } })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-3', method: 'browser.act', params: { pageId: 'tab-11', ref: 'c-1', action: 'click' } })
  await flush()
  const response = socket.sent.find(message => message.type === 'response' && message.requestId === 'req-3')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'ELEMENT_STALE')
  assert.match(response.error.message, /no longer in the page/)
})

test('an action with a ref this extension never issued is refused before any page work', async () => {
  const touched = []
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab()],
    onTabMessage: message => { touched.push(message.method); return { ok: true, result: {} } },
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-6', method: 'browser.act', params: { pageId: 'tab-11', ref: 'c-unknown', action: 'click' } })
  await flush()
  const response = socket.sent.find(message => message.type === 'response' && message.requestId === 'req-6')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'ELEMENT_NOT_FOUND')
  assert.deepEqual(touched, [], 'an unknown ref must not reach the page agent')
  assert.equal(module.statusSnapshot().trackedRefs, 0)
})

test('a ref observed in one tab is refused when the request names another tab', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab(), { id: 22, url: 'https://other.example/', title: 'Other', active: false, windowId: 1 }],
    onTabMessage: message => {
      if (message.method === 'page.snapshot') return { ok: true, result: { url: 'https://example.com/', title: 'Example', elements: [{ ref: 'c-9', role: 'button', name: 'Go' }] } }
      return { ok: true, result: { ok: true } }
    },
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-7', method: 'browser.snapshot', params: { pageId: 'tab-11' } })
  await flush()
  // Wait for the snapshot response so the ref is recorded before the mismatched action.
  await new Promise(resolveWait => setTimeout(resolveWait, 30))
  assert.equal(module.statusSnapshot().trackedRefs, 1, 'the snapshot ref must be tracked')

  socket.receive({ type: 'request', requestId: 'req-8', method: 'browser.act', params: { pageId: 'tab-22', ref: 'c-9', action: 'click' } })
  await flush()
  const response = socket.sent.find(message => message.type === 'response' && message.requestId === 'req-8')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'ELEMENT_STALE')
  assert.match(response.error.message, /observed in tab 11/)
})

test('a bridge cancel releases the pending request', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab()],
    // A page request that never settles on its own.
    onTabMessage: () => new Promise(() => {}),
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-4', method: 'browser.snapshot', params: { pageId: 'tab-11' } })
  await flush()
  assert.equal(module.statusSnapshot().pending, 1)
  socket.receive({ type: 'cancel', requestId: 'req-4' })
  await flush()
  assert.equal(module.statusSnapshot().pending, 0, 'a cancelled request must not stay pending')
})

test('disconnecting closes the socket and clears every pending request', async () => {
  const { module } = await loadWorker({
    granted: ['https://host.example/*'],
    stored: { bridgeUrl: 'wss://host.example/chrome-bridge' },
    session: { pairingToken: 'a'.repeat(43) },
    tabs: [activeTab()],
    onTabMessage: () => new Promise(() => {}),
  })
  await module.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket.open()
  socket.receive({ type: 'challenge', nonce: 'n' })
  await flush()
  socket.receive({ type: 'ready', peerId: 'bridge-1' })
  await flush()
  socket.receive({ type: 'request', requestId: 'req-5', method: 'browser.snapshot', params: { pageId: 'tab-11' } })
  await flush()
  assert.equal(module.statusSnapshot().pending, 1)
  const status = await module.disconnect()
  await flush()
  assert.equal(status.status, 'disconnected')
  assert.equal(module.statusSnapshot().pending, 0)
})
