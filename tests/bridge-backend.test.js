/**
 * Chrome Extension backend tests.
 *
 * These verify the translation layer between the tool surface and the bridge protocol: page id
 * resolution, ref-to-tab routing, capability boundaries, and error messages a model can act on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChromeBridgeBackend, isStaleReferenceError, toError } from '../src/bridge/backend.js'
import { BridgeError } from '../src/bridge/hub.js'
import { defaults } from '../src/settings.js'

const settings = { read: async () => defaults }

/** A stand-in hub that records every method call and returns scripted results. */
function fakeHub(responder = () => ({ ok: true }), status) {
  const calls = []
  const listeners = new Set()
  return {
    calls,
    status: () => status ?? { listening: true, peers: [{ id: 'bridge-1', authenticated: true, label: 'Laptop', pending: 0 }] },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: event => { for (const listener of listeners) listener(event) },
    request: async (method, params, options) => {
      calls.push({ method, params, options })
      const result = responder(method, params, options)
      if (result instanceof Error) throw result
      return result
    },
  }
}

const tabList = {
  pages: [
    { id: 'tab-11', url: 'https://example.com/', title: 'Example', active: true },
    { id: 'tab-22', url: 'https://other.example/', title: 'Other', active: false },
  ],
}

test('snapshot returns the shared structure and records ref ownership', async () => {
  const hub = fakeHub((method) => {
    if (method === 'browser.tabs') return tabList
    return {
      pageId: 'tab-11', tabId: 11, url: 'https://example.com/', title: 'Example', mode: 'form',
      headings: ['Checkout'], elements: [{ ref: 'c-abc', role: 'textbox', name: 'Email' }],
      totalInteractive: 1, candidateCount: 0, returned: 1, truncated: false,
    }
  })
  const backend = new ChromeBridgeBackend(hub, { settings })
  const snapshot = await backend.snapshot('active', 80, undefined, undefined, false, 'form')
  assert.equal(snapshot.mode, 'form')
  assert.deepEqual(snapshot.elements, [{ ref: 'c-abc', role: 'textbox', name: 'Email' }])
  // The recorded ref must remember its tab so a later action cannot drift to another tab.
  assert.equal(backend.refs.get('c-abc').tabId, 11)
})

test('a ref used as the pageId routes the action to the tab that owns it', async () => {
  const hub = fakeHub((method) => {
    if (method === 'browser.tabs') return tabList
    if (method === 'browser.snapshot') return { pageId: 'tab-22', tabId: 22, url: 'https://other.example/', title: 'Other', elements: [{ ref: 'c-xyz', role: 'button', name: 'Save' }] }
    return { ok: true }
  })
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.snapshot('tab-22')
  await backend.act('c-xyz', 'c-xyz', 'click')
  const act = hub.calls.find(call => call.method === 'browser.act')
  assert.equal(act.params.pageId, 'tab-22', 'the action must target the ref owner tab')
})

test('page ids outside the supported forms are rejected before any request', async () => {
  const hub = fakeHub()
  const backend = new ChromeBridgeBackend(hub, { settings })
  assert.equal(backend.normalizePageId('active'), 'active')
  assert.equal(backend.normalizePageId('current'), 'active')
  assert.equal(backend.normalizePageId(''), 'active')
  assert.equal(backend.normalizePageId('tab-7'), 'tab-7')
  assert.throws(() => backend.normalizePageId('page-abc'), /Unknown page id/)
  await assert.rejects(backend.snapshot('page-abc'), /Unknown page id/)
  assert.equal(hub.calls.length, 0, 'an invalid page id must not reach the bridge')
})

test('unsupported capabilities fail with an explanation instead of a silent partial action', async () => {
  const hub = fakeHub()
  const backend = new ChromeBridgeBackend(hub, { settings })
  await assert.rejects(backend.snapshot('active', 80, 'frame-1'), /iframe snapshots/)
  await assert.rejects(backend.snapshot('active', 80, undefined, '#main'), /scopeCss/)
  await assert.rejects(backend.snapshot('active', 80, undefined, undefined, false, 'nonsense'), /interactive or form/)
  await assert.rejects(backend.wait('active'), /text or url/)
  await assert.rejects(backend.act('tab-1', 'c-1', 'scroll'), /Unsupported browser action/)
  await assert.rejects(backend.act('tab-1', 'c-1', 'fill'), /requires value/)
  assert.equal(hub.calls.length, 0)
})

test('a bridge failure becomes a message a model can act on', async () => {
  const hub = fakeHub(() => new BridgeError('BRIDGE_OFFLINE', 'No Chrome extension is connected to the bridge.'))
  const backend = new ChromeBridgeBackend(hub, { settings })
  await assert.rejects(backend.snapshot('active'), error => {
    assert.match(error.message, /^\[BRIDGE_OFFLINE\]/)
    assert.match(error.message, /extension popup/)
    return true
  })
})

test('stale reference errors are recognisable so a caller knows to re-observe', () => {
  assert.equal(isStaleReferenceError(toError(new BridgeError('ELEMENT_STALE', 'gone'))), true)
  assert.equal(isStaleReferenceError(toError(new BridgeError('ELEMENT_NOT_FOUND', 'gone'))), true)
  assert.equal(isStaleReferenceError(toError(new BridgeError('BRIDGE_TIMEOUT', 'slow'))), false)
  assert.equal(isStaleReferenceError(new Error('plain')), false)
})

test('completed actions invalidate cached refs and the tab cache', async () => {
  const hub = fakeHub((method) => {
    if (method === 'browser.tabs') return tabList
    if (method === 'browser.snapshot') return { tabId: 11, elements: [{ ref: 'c-1' }] }
    return { ok: true }
  })
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.tabs('list')
  await backend.snapshot('active')
  assert.equal(backend.refs.size, 1)
  await backend.act('tab-11', 'c-1', 'click')
  assert.equal(backend.refs.size, 0, 'refs must be re-observed after an action')
  // The tab cache was invalidated, so the next list call reaches the bridge again.
  const before = hub.calls.filter(call => call.method === 'browser.tabs').length
  await backend.tabs('list')
  assert.equal(hub.calls.filter(call => call.method === 'browser.tabs').length, before + 1)
})

test('the tab list is cached briefly and invalidated on a peer change', async () => {
  const hub = fakeHub(() => tabList)
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.tabs('list')
  await backend.tabs('list')
  assert.equal(hub.calls.length, 1, 'the second list call must be served from the cache')
  hub.emit({ type: 'peer-closed' })
  await backend.tabs('list')
  assert.equal(hub.calls.length, 2, 'a peer change must invalidate the cache')
})

test('status reports disconnected, connected, and failing bridges distinctly', async () => {
  const disconnected = fakeHub()
  disconnected.status = () => ({ listening: true, peers: [] })
  assert.equal((await new ChromeBridgeBackend(disconnected, { settings }).status()).launch, 'bridge-disconnected')

  const connected = fakeHub(() => tabList)
  const status = await new ChromeBridgeBackend(connected, { settings }).status()
  assert.equal(status.launch, 'connected')
  assert.equal(status.activePages, 2)
  assert.equal(status.backend, 'chrome-extension')
  assert.equal(status.peers[0].label, 'Laptop')

  const failing = fakeHub(() => new BridgeError('BRIDGE_TIMEOUT', 'slow'))
  const failingStatus = await new ChromeBridgeBackend(failing, { settings }).status()
  assert.equal(failingStatus.launch, 'bridge-error')
  assert.match(failingStatus.pageError, /slow/)
})

test('currentUrl resolves the active tab and rejects a missing one', async () => {
  const hub = fakeHub(() => tabList)
  const backend = new ChromeBridgeBackend(hub, { settings })
  assert.equal(await backend.currentUrl('active'), 'https://example.com/')
  assert.equal(await backend.currentUrl('tab-22'), 'https://other.example/')
  await assert.rejects(backend.currentUrl('tab-99'), /not available/)
})

test('open and wait forward only the parameters the extension understands', async () => {
  const hub = fakeHub(() => ({ pageId: 'tab-11' }))
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.open('active', 'https://example.com/new')
  await backend.wait('active', 'Done', '/done')
  const open = hub.calls.find(call => call.method === 'browser.open')
  assert.deepEqual(open.params, { pageId: 'active', url: 'https://example.com/new' })
  const wait = hub.calls.find(call => call.method === 'browser.wait')
  assert.deepEqual(wait.params, { pageId: 'active', text: 'Done', url: '/done', timeoutMs: defaults.timeoutMs })
})

test('dispose clears cached state', async () => {
  const hub = fakeHub((method) => method === 'browser.tabs' ? tabList : { tabId: 11, elements: [{ ref: 'c-1' }] })
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.tabs('list')
  await backend.snapshot('active')
  await backend.dispose()
  assert.equal(backend.refs.size, 0)
  assert.equal(backend.tabCache, undefined)
  assert.equal(backend.healthCache, undefined)
})

test('health proves the connection with a real ping before tool work', async () => {
  const hub = fakeHub(() => ({ pong: true }))
  const backend = new ChromeBridgeBackend(hub, { settings })
  const report = await backend.ensureHealthy()
  assert.equal(report.healthy, true)
  assert.equal(report.peers.length, 1)
  assert.equal(typeof report.latencyMs, 'number')
  assert.deepEqual(hub.calls.map(call => call.method), ['bridge.ping'])

  // A successful probe is reused briefly so a burst of tool calls does not multiply the round trip.
  const cached = await backend.ensureHealthy()
  assert.equal(cached.cached, true)
  assert.equal(hub.calls.length, 1)
  assert.equal((await backend.ensureHealthy({ force: true })).cached, undefined)
  assert.equal(hub.calls.length, 2)
})

test('a disconnected or ambiguous extension fails before any page work', async () => {
  const offline = fakeHub(() => ({ pong: true }), { listening: true, peers: [] })
  const offlineBackend = new ChromeBridgeBackend(offline, { settings })
  await assert.rejects(offlineBackend.ensureHealthy(), error => {
    assert.equal(error.code, 'BRIDGE_OFFLINE')
    assert.match(error.message, /No Chrome extension is connected/)
    return true
  })
  assert.deepEqual(offline.calls, [], 'a missing peer must not be probed')

  const stopped = fakeHub(() => ({ pong: true }), { listening: false, peers: [] })
  assert.equal((await new ChromeBridgeBackend(stopped, { settings }).health()).code, 'BRIDGE_OFFLINE')

  const ambiguous = fakeHub(() => ({ pong: true }), {
    listening: true,
    peers: [{ id: 'bridge-1', authenticated: true }, { id: 'bridge-2', authenticated: true }],
  })
  const report = await new ChromeBridgeBackend(ambiguous, { settings }).health()
  assert.equal(report.healthy, false)
  assert.equal(report.code, 'BRIDGE_AMBIGUOUS')
  assert.equal(report.peers.length, 2)
})

test('an unresponsive extension reports its failure and is probed again next time', async () => {
  const hub = fakeHub(() => new BridgeError('BRIDGE_TIMEOUT', 'The Chrome extension did not answer bridge.ping within 5000 ms.'))
  const backend = new ChromeBridgeBackend(hub, { settings })
  const report = await backend.health()
  assert.equal(report.healthy, false)
  assert.equal(report.code, 'BRIDGE_TIMEOUT')
  assert.match(report.message, /did not answer/)

  // A failed probe must never be cached: the next call has to retry instead of reusing the failure.
  await backend.health()
  assert.equal(hub.calls.length, 2)
  await assert.rejects(backend.ensureHealthy(), error => {
    assert.equal(error.code, 'BRIDGE_TIMEOUT')
    return true
  })
})

test('a peer change invalidates a cached probe', async () => {
  const hub = fakeHub(() => ({ pong: true }))
  const backend = new ChromeBridgeBackend(hub, { settings })
  await backend.ensureHealthy()
  hub.emit({ type: 'peer-authenticated', peerId: 'bridge-1' })
  assert.equal(backend.healthCache, undefined)
  assert.equal((await backend.ensureHealthy()).cached, undefined)
  assert.equal(hub.calls.length, 2)
})
