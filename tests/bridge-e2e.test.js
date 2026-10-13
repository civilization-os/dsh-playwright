/**
 * Full-stack bridge test.
 *
 * Wires the real pieces together: a real Chromium page running the shared page agent, a fake
 * extension that services bridge requests by delegating to that page, the real WebSocket bridge
 * server with real token authentication, and the real Chrome Extension backend on the Node side.
 *
 * This is the closest automated equivalent of loading the unpacked extension and driving a tab.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startChromeBridgeServer, createPairingToken } from '../src/bridge/server.js'
import { connectWebSocket } from '../src/bridge/websocket.js'
import { ChromeBridgeBackend } from '../src/bridge/backend.js'
import { defaults } from '../src/settings.js'
import { launchTestBrowser } from './browser.helper.js'
import { buildAgentBundle } from './content-bundle.helper.js'

const PAGE = `<!doctype html><html><head><title>Bridge E2E</title></head><body style="font:16px sans-serif">
  <h1>Checkout</h1>
  <form>
    <label for="email">Email address</label>
    <input id="email" type="email">
    <input id="generic" placeholder="请选择">
    <button id="go" type="button">Place order</button>
  </form>
  <table><tr><th>Company tax ID</th><td><input id="tax"></td></tr></table>
  <div id="out"></div>
  <script>document.getElementById('go').addEventListener('click', () => { document.getElementById('out').textContent = 'clicked' })</script>
</body></html>`

test('the real bridge drives a real page through the real backend', async t => {
  const browser = await launchTestBrowser()
  if (!browser) { t.skip('no Chrome, Edge, or cached Chromium is available'); return }
  t.after(() => browser.close())

  const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  t.after(() => site.close())
  await new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen))

  const browserPage = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await browserPage.goto(`http://127.0.0.1:${site.address().port}/`, { waitUntil: 'domcontentloaded' })
  await browserPage.evaluate(buildAgentBundle())
  // Tab 11 stands in for the Chrome tab id the extension would learn from its service worker.
  await browserPage.evaluate(() => { globalThis.__agent = globalThis.__dsh.createPageAgent({ tabId: 11 }) })

  // --- The real bridge server, with a real pairing token -------------------------------
  const tokens = [createPairingToken('e2e')]
  const bridge = await startChromeBridgeServer({ tokens: () => tokens, port: 0, logger: () => {} })
  t.after(() => bridge.close())

  const session = await fetch(`http://127.0.0.1:${bridge.port}${bridge.path}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tokens[0].token }),
  })
  assert.equal(session.status, 200)
  const cookie = session.headers.getSetCookie()[0].split(';')[0]

  // --- A fake extension that delegates page work to the real page ----------------------
  const inbox = []
  /** Ref -> owning tab, exactly as the service worker maintains it. */
  const refOwners = new Map()
  /**
   * Run one page-agent call in the browser and return a structured `{ ok, value|code, message }`.
   * A Playwright driver round-trip flattens a thrown PageActionError, so the call is wrapped in the
   * page to preserve the error code the way the real content script does.
   */
  const pageCall = (name, args) => browserPage.evaluate(async ([method, params]) => {
    try {
      return { ok: true, value: await globalThis.__agent[method](params) }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) }
    }
  }, [name, args])
  /**
   * Mirror the service worker's translation: bridge `browser.*` methods become page-agent
   * `page.*` calls, and the extension stamps the tab id onto the request and the result.
   */
  const handleBridgeMethod = async (method, params = {}) => {
    if (method === 'bridge.ping') return { pong: true, at: Date.now() }
    if (method === 'browser.tabs') {
      return { pages: [{ id: 'tab-11', url: `http://127.0.0.1:${site.address().port}/`, title: 'Bridge E2E', active: true }] }
    }
    if (method === 'browser.snapshot') {
      const outcome = await pageCall('snapshot', {
        mode: params.mode, limit: params.limit, includeCandidates: params.includeCandidates, tabId: 11,
      })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
      for (const element of outcome.value.elements ?? []) if (element?.ref) refOwners.set(element.ref, 11)
      return { ...outcome.value, pageId: 'tab-11', tabId: 11, snapshotId: 'e2e-1' }
    }
    if (method === 'browser.act') {
      const owner = refOwners.get(params.ref)
      if (owner === undefined) throw Object.assign(new Error('That snapshot reference is not known to this extension.'), { code: 'ELEMENT_NOT_FOUND' })
      if (owner !== 11) throw Object.assign(new Error(`That reference was observed in tab ${owner}, not tab 11.`), { code: 'ELEMENT_STALE' })
      const outcome = await pageCall('act', { ref: params.ref, action: params.action, value: params.value, tabId: 11 })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
      return { ...outcome.value, pageId: 'tab-11' }
    }
    if (method === 'browser.wait') {
      const outcome = await pageCall('wait', { text: params.text, url: params.url, timeoutMs: params.timeoutMs, tabId: 11 })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
      return { ...outcome.value, pageId: 'tab-11' }
    }
    if (method === 'browser.open') throw Object.assign(new Error('navigation is not exercised here'), { code: 'INVALID_PARAMS' })
    throw Object.assign(new Error(`unsupported bridge method ${method}`), { code: 'INVALID_PARAMS' })
  }

  const connection = await connectWebSocket(`ws://127.0.0.1:${bridge.port}${bridge.path}`, {
    headers: { cookie },
    onmessage: text => {
      const message = JSON.parse(text)
      inbox.push(message)
      if (message.type !== 'request') return
      void (async () => {
        try {
          const result = await handleBridgeMethod(message.method, message.params ?? {})
          connection.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result }))
        } catch (error) {
          connection.send(JSON.stringify({
            type: 'response', requestId: message.requestId, ok: false,
            error: { code: error.code ?? 'INTERNAL', message: String(error.message).slice(0, 300) },
          }))
        }
      })()
    },
  })
  t.after(() => connection.close())

  const waitFor = (predicate, label) => new Promise((resolveWait, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = inbox.find(predicate)
      if (found) { clearInterval(timer); resolveWait(found) }
      else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error(`timed out waiting for ${label}`)) }
    }, 10)
  })

  const challenge = await waitFor(message => message.type === 'challenge', 'challenge')
  assert.ok(challenge.methods.includes('browser.snapshot'))
  assert.ok(challenge.methods.includes('browser.act'))
  // Arbitrary execution is not representable on the wire.
  assert.equal(challenge.methods.some(method => /eval|exec|shell/i.test(method)), false)

  connection.send(JSON.stringify({ type: 'hello', nonce: challenge.nonce, token: tokens[0].token, label: 'E2E', extensionVersion: '0.1.0' }))
  const ready = await waitFor(message => message.type === 'ready', 'ready')
  assert.equal(ready.protocol, 1)

  // --- The real Node backend, driven exactly as the tools drive it ---------------------
  const backend = new ChromeBridgeBackend(bridge.hub, { settings: { read: async () => defaults } })

  const snapshot = await backend.snapshot('active', 80, undefined, undefined, false, 'form')
  assert.equal(snapshot.pageId, 'tab-11')
  assert.equal(snapshot.tabId, 11)

  const controls = snapshot.elements.filter(element => element.role !== 'label')
  const email = controls.find(element => element.name === 'Email address')
  assert.ok(email, 'the labelled field must be projected with its accessible name')
  const generic = snapshot.elements.find(element => String(element.path).includes('generic'))
  assert.equal(generic.fieldContext.inferredLabel, undefined, 'a generic placeholder must stay unresolved')
  const tax = snapshot.elements.find(element => element.fieldContext?.inferredLabel === 'Company tax ID')
  assert.ok(tax, 'a table header must supply the field label')

  // Fill through the ref, and confirm the real DOM changed.
  const filled = await backend.act('active', email.ref, 'fill', 'e2e@example.com')
  assert.equal(filled.ok, true)
  assert.equal(await browserPage.inputValue('#email'), 'e2e@example.com')

  // Click through the ref, and confirm the page handler ran.
  const button = snapshot.elements.find(element => element.name === 'Place order')
  const clicked = await backend.act('active', button.ref, 'click')
  assert.equal(clicked.ok, true)
  assert.equal(await browserPage.textContent('#out'), 'clicked')

  // A ref the extension never issued is refused rather than resolved against the active tab.
  await assert.rejects(backend.act('active', 'c-neverissued', 'click'), error => {
    assert.match(error.message, /\[ELEMENT_NOT_FOUND\]/)
    assert.match(error.message, /not known to this extension/)
    return true
  })
  // A ref the backend forgot about is refused before any page work happens.
  await assert.rejects(backend.act(email.ref, email.ref, 'fill', 'x'), error => {
    assert.match(error.message, /no longer valid for this backend/)
    return true
  })

  // A ref captured before the DOM changed must be refused with a stale diagnosis.
  const second = await backend.snapshot('active', 80)
  const onceMore = second.elements.find(element => element.name === 'Email address' && element.role === 'textbox')
  assert.ok(onceMore, 'the email control must be projected again')
  await browserPage.evaluate(() => {
    const original = document.getElementById('email')
    original.replaceWith(original.cloneNode(true))
  })
  await assert.rejects(backend.act('active', onceMore.ref, 'fill', 'x'), error => {
    assert.match(error.message, /\[ELEMENT_STALE\]/)
    assert.match(error.message, /removed or replaced/i)
    return true
  })

  // The backend's own status view reflects the connected extension.
  const status = await backend.status()
  assert.equal(status.launch, 'connected')
  assert.equal(status.peers[0].label, 'E2E')

  // Disconnecting the extension must fail subsequent work immediately, not hang.
  connection.close(1000, 'user disconnected')
  await new Promise(resolveWait => setTimeout(resolveWait, 80))
  await assert.rejects(backend.snapshot('active'), error => {
    assert.match(error.message, /^\[BRIDGE_OFFLINE\]/)
    assert.match(error.message, /extension popup/)
    return true
  })
})
