/**
 * Page agent and DOM semantics tests, executed inside a real Chromium page.
 *
 * The extension's content script is bundled and injected so `createPageAgent` and `createRefStore`
 * run exactly as they do in Chrome: real layout, real events, real `isConnected` behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { launchTestBrowser } from './browser.helper.js'
import { buildAgentBundle } from './content-bundle.helper.js'

let bundle
let bundleError

/** Build the content script once, exposing its internals for injection into the page. */
function loadBundle() {
  if (bundle !== undefined || bundleError) return bundle
  try {
    bundle = buildAgentBundle()
  } catch (error) {
    bundleError = error
    bundle = undefined
  }
  return bundle
}

/** Serve pages so the agent sees real navigable URLs. */
async function startSite(t) {
  const routes = new Map()
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const body = routes.get(path)
    if (body === undefined) { response.writeHead(404); response.end('not found'); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  t.after(() => server.close())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, set: (path, body) => routes.set(path, body) }
}

/** Launch a page with the bundled agent available, or skip when no browser exists. */
async function withAgent(t, html, path = '/') {
  const browser = await launchTestBrowser()
  if (!browser) { t.skip('no Chrome, Edge, or cached Chromium is available'); return undefined }
  t.after(() => browser.close())
  const site = await startSite(t)
  site.set(path, html)
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  await page.goto(`${site.origin}${path}`, { waitUntil: 'domcontentloaded' })
  // Install the bundled agent into the page's own world, the way a content script would, so the
  // tests exercise the same code path a real tab uses.
  const bundleSource = loadBundle()
  assert.ok(bundleSource, `the content bundle did not build: ${bundleError?.message}`)
  await page.evaluate(bundleSource)
  const installed = await page.evaluate(() => Boolean(globalThis.__dsh?.createPageAgent))
  assert.equal(installed, true, 'the page agent must be installed in the page world')
  return { browser, page, site }
}

const SAMPLE_FORM = `<!doctype html><html><head><style>
  body { font: 16px sans-serif; margin: 20px; }
  input, textarea, select, button { display: block; margin: 12px 0; width: 320px; min-height: 30px; }
  table { margin-top: 20px; border-collapse: collapse; }
  th, td { padding: 4px 10px; }
</style></head><body>
  <h1>Checkout</h1>
  <form>
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
    <input id="search" placeholder="Search products">
    <input id="generic" placeholder="请选择">
    <textarea id="note" aria-label="Delivery note"></textarea>
    <select id="speed" aria-label="Delivery speed">
      <option value="std">Standard</option>
      <option value="exp">Express</option>
    </select>
    <button id="submit" type="button">Place order</button>
  </form>
  <table><tr><th>Company tax ID</th><td><input id="tax"></td></tr></table>
  <div id="result"></div>
  <script>
    window.events = [];
    const result = document.getElementById('result');
    document.getElementById('submit').addEventListener('click', () => { result.textContent = 'clicked'; });
    document.getElementById('search').addEventListener('input', () => { result.textContent = 'search:' + document.getElementById('search').value; });
    document.getElementById('speed').addEventListener('change', () => { result.textContent = 'speed:' + document.getElementById('speed').value; });
    document.getElementById('email').addEventListener('keydown', event => { result.textContent = 'key:' + event.key; });
  </script>
</body></html>`

/**
 * Install a page agent that believes it belongs to `tabId`, mirroring what a real content script
 * learns from its service worker. The cross-tab guard is then active during every operation.
 */
const newAgent = (page, tabId = 5) => page.evaluate(id => {
  const agent = globalThis.__dsh.createPageAgent({ tabId: id })
  globalThis.__agent = agent
  return true
}, tabId)

const callAgent = (page, method, params) => page.evaluate(
  ([name, args]) => {
    try {
      return { ok: true, value: globalThis.__agent[name](args) }
    } catch (error) {
      return { ok: false, code: error.code, message: error.message }
    }
  },
  [method, params],
)

const callAgentAsync = (page, method, params) => page.evaluate(
  async ([name, args]) => {
    try {
      return { ok: true, value: await globalThis.__agent[name](args) }
    } catch (error) {
      return { ok: false, code: error.code, message: error.message }
    }
  },
  [method, params],
)

test('the bundled extension content script builds and exposes its page agent', async t => {
  const built = loadBundle()
  if (!built) { t.skip(`esbuild bundle failed: ${bundleError?.message}`); return }
  assert.match(built, /__dsh/)
  assert.equal(/require\(/.test(built), false, 'the browser bundle must not contain require calls')
})

test('a snapshot returns refs, accessible names, and form semantics from one page read', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100, tabId: 5 })
  assert.equal(snapshot.ok, true, snapshot.message)
  const { elements, title } = snapshot.value
  assert.equal(title, '')
  assert.ok(elements.length >= 6, `expected several controls, got ${elements.length}`)

  // A <label> is itself projected, so prefer the control roles over the label element.
  const control = name => elements.find(element => element.name === name && ['textbox', 'combobox', 'button', 'link', 'checkbox'].includes(element.role))
  assert.ok(control('Email address'), 'a <label for> must provide the accessible name')
  assert.equal(control('Email address').nameSource, 'label')
  assert.ok(control('Delivery note'), 'aria-label must provide the accessible name')
  assert.equal(control('Delivery note').nameSource, 'aria-label')
  assert.equal(control('Delivery speed').role, 'combobox')
  assert.ok(control('Place order'), 'button text must provide the accessible name')

  const tax = elements.find(element => element.fieldContext?.inferredLabel === 'Company tax ID')
  assert.ok(tax, 'a table header must supply the field label')
  assert.equal(tax.fieldContext.labelSource, 'table-cell')
  assert.ok(['high', 'medium'].includes(tax.fieldContext.confidence))

  for (const element of elements) assert.equal(typeof element.ref, 'string', 'every element must carry a ref')
  assert.equal(new Set(elements.map(element => element.ref)).size, elements.length, 'refs must be unique')
  for (const element of elements) {
    for (const internal of ['labelHint', 'labelHintGeneric']) {
      assert.equal(Object.hasOwn(element.fieldContext ?? {}, internal), false, `${internal} is internal and must not be returned`)
    }
  }
})

test('a region heading is not mistaken for a field label', async t => {
  const context = await withAgent(t, `<!doctype html><html><body style="font:16px sans-serif">
    <h1>Checkout</h1>
    <form>
      <input id="first" placeholder="请选择">
      <input id="second" placeholder="请输入">
    </form></body></html>`)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100 })
  const fields = snapshot.value.elements.filter(element => element.fieldContext)
  assert.equal(fields.length, 2)
  for (const element of fields) {
    assert.notEqual(element.fieldContext.inferredLabel, 'Checkout', 'a page heading must not label a field')
    assert.equal(element.fieldContext.inferredLabel, undefined)
    assert.equal(element.fieldContext.labelSource, undefined)
  }
})

test('a label belonging to another field is never borrowed', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100 })
  const search = snapshot.value.elements.find(element => element.path.includes('search'))
  assert.notEqual(search.fieldContext.inferredLabel, 'Email address', 'the preceding <label for="email"> belongs to another field')
  assert.equal(search.fieldContext.inferredLabel, 'Search products')
})

test('a generic placeholder never becomes the field name, and real context wins', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100 })
  const elements = snapshot.value.elements
  if (process.env.DSH_DEBUG_AGENT) console.error('ELEMENTS', JSON.stringify(elements, null, 1))

  // "请选择" carries no field meaning: the agent must report the field as unresolved.
  const generic = elements.find(element => element.path.includes('generic'))
  assert.ok(generic, 'the generic-placeholder input must appear in the snapshot')
  assert.equal(generic.fieldContext.inferredLabel, undefined, 'a generic placeholder must not become a label')
  assert.equal(generic.fieldContext.labelSource, undefined, 'a rejected hint must not be reported as a label source')
  assert.equal(generic.fieldContext.confidence, 'low')

  // A specific placeholder is real, if weak, evidence and is reported as such.
  const search = elements.find(element => element.path.includes('search'))
  assert.equal(search.fieldContext.inferredLabel, 'Search products')
  assert.equal(search.fieldContext.labelSource, 'placeholder')
  assert.equal(search.fieldContext.confidence, 'low')
})

test('clicking through a ref performs the action and reports the URL', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const button = snapshot.value.elements.find(element => element.name === 'Place order')
  const result = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.navigated, false)
  assert.equal(await page.textContent('#result'), 'clicked')
})

test('filling through a ref dispatches an input event that page scripts observe', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const search = snapshot.value.elements.find(element => element.path.includes('search'))
  const result = await callAgentAsync(page, 'act', { ref: search.ref, action: 'fill', value: 'socks', tabId: 5 })
  assert.equal(result.ok, true, result.message)
  assert.equal(await page.inputValue('#search'), 'socks')
  assert.equal(await page.textContent('#result'), 'search:socks')
})

test('selecting an option by text and by value both work', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const speed = snapshot.value.elements.find(element => element.name === 'Delivery speed')

  const byText = await callAgentAsync(page, 'act', { ref: speed.ref, action: 'select', value: 'Express', tabId: 5 })
  assert.equal(byText.ok, true, byText.message)
  assert.equal(byText.value.selectedValue, 'exp')
  assert.equal(await page.inputValue('#speed'), 'exp')
  assert.equal(await page.textContent('#result'), 'speed:exp')

  const byValue = await callAgentAsync(page, 'act', { ref: speed.ref, action: 'select', value: 'std', tabId: 5 })
  assert.equal(byValue.ok, true, byValue.message)
  assert.equal(await page.inputValue('#speed'), 'std')

  const unknown = await callAgentAsync(page, 'act', { ref: speed.ref, action: 'select', value: 'Teleport', tabId: 5 })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'INVALID_PARAMS')
  assert.match(unknown.message, /No option matched/)
})

test('pressing a key reaches the page and updates the value', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const email = snapshot.value.elements.find(element => element.name === 'Email address' && element.role === 'textbox')
  await callAgentAsync(page, 'act', { ref: email.ref, action: 'fill', value: 'ab', tabId: 5 })
  const pressed = await callAgentAsync(page, 'act', { ref: email.ref, action: 'press', value: 'Backspace', tabId: 5 })
  assert.equal(pressed.ok, true, pressed.message)
  assert.equal(await page.inputValue('#email'), 'a')
  assert.equal(await page.textContent('#result'), 'key:Backspace')

  const unsupported = await callAgentAsync(page, 'act', { ref: email.ref, action: 'press', value: 'F13', tabId: 5 })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.code, 'INVALID_PARAMS')
})

test('a ref to a removed element fails as stale instead of acting on a lookalike', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const button = snapshot.value.elements.find(element => element.name === 'Place order')

  // Insert a visually identical sibling: the ref must still mean the original node.
  await page.evaluate(() => {
    const clone = document.getElementById('submit').cloneNode(true)
    clone.id = 'submit-clone'
    document.body.prepend(clone)
  })
  const afterInsert = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(afterInsert.ok, true, afterInsert.message)
  assert.equal(await page.textContent('#result'), 'clicked')

  // Replacing the node invalidates the ref.
  await page.evaluate(() => {
    const original = document.getElementById('submit')
    original.replaceWith(original.cloneNode(true))
  })
  const replaced = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(replaced.ok, false)
  assert.equal(replaced.code, 'ELEMENT_STALE')
  assert.match(replaced.message, /removed or replaced/i)

  // Removing the node is also stale.
  await page.evaluate(() => document.getElementById('submit').remove())
  const removed = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'ELEMENT_STALE')
})

test('semantic change, wrong role, and wrong tab are all refused', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const email = snapshot.value.elements.find(element => element.name === 'Email address' && element.role === 'textbox')

  // A request that names another tab must be refused rather than serviced by this document.
  const wrongTab = await callAgentAsync(page, 'act', { ref: email.ref, action: 'fill', value: 'x', tabId: 99 })
  assert.equal(wrongTab.ok, false, `a cross-tab request must fail: ${JSON.stringify(wrongTab)}`)
  assert.equal(wrongTab.code, 'ELEMENT_STALE')
  assert.match(wrongTab.message, /tab 99/)

  const button = snapshot.value.elements.find(element => element.name === 'Place order')
  const notEditable = await callAgentAsync(page, 'act', { ref: button.ref, action: 'fill', value: 'x', tabId: 5 })
  assert.equal(notEditable.ok, false)
  assert.equal(notEditable.code, 'ELEMENT_NOT_EDITABLE')

  const notSelect = await callAgentAsync(page, 'act', { ref: email.ref, action: 'select', value: 'a', tabId: 5 })
  assert.equal(notSelect.ok, false)
  assert.equal(notSelect.code, 'ELEMENT_NOT_SELECT')

  // Rename the control, then the captured fingerprint no longer matches.
  await page.evaluate(() => document.querySelector('label[for="email"]').textContent = 'Primary contact')
  const renamed = await callAgentAsync(page, 'act', { ref: email.ref, action: 'fill', value: 'x', tabId: 5 })
  assert.equal(renamed.ok, false)
  assert.equal(renamed.code, 'ELEMENT_STALE')
  assert.match(renamed.message, /semantics changed/i)
})

test('a hidden or disabled target is refused', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const button = snapshot.value.elements.find(element => element.name === 'Place order')

  await page.evaluate(() => { document.getElementById('submit').disabled = true })
  const disabled = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(disabled.ok, false)
  assert.match(disabled.message, /disabled/i)

  await page.evaluate(() => {
    const element = document.getElementById('submit')
    element.disabled = false
    element.style.display = 'none'
  })
  const hidden = await callAgentAsync(page, 'act', { ref: button.ref, action: 'click', tabId: 5 })
  assert.equal(hidden.ok, false)
  assert.equal(hidden.code, 'ELEMENT_STALE')
  assert.match(hidden.message, /hidden/i)
})

test('an ambiguous field cannot be filled until it is clarified', async t => {
  const context = await withAgent(t, `<!doctype html><html><body style="font:16px sans-serif">
    <form style="position:relative;height:160px">
      <input id="ambiguous" style="position:absolute;left:220px;top:60px;width:240px">
      <span style="position:absolute;left:108px;top:66px">Account</span>
      <span style="position:absolute;left:300px;top:35px">Reference</span>
    </form></body></html>`)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100 })
  const field = snapshot.value.elements.find(element => element.fieldContext)
  assert.ok(field, 'the ambiguous input must be projected')
  assert.equal(field.fieldContext.confidence, 'ambiguous')
  assert.equal(field.fieldContext.inferredLabel, undefined, 'no label may be invented for an ambiguous field')
  assert.deepEqual(new Set(field.fieldContext.labelCandidates.map(candidate => candidate.text)), new Set(['Account', 'Reference']))

  const refused = await callAgentAsync(page, 'act', { ref: field.ref, action: 'fill', value: 'x', tabId: 5 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'ELEMENT_AMBIGUOUS')
})

test('duplicate field names are disambiguated by context instead of collapsing', async t => {
  const context = await withAgent(t, `<!doctype html><html><body style="font:16px sans-serif">
    <form>
      <table>
        <tr><th>Billing ZIP</th><td><input name="zip" placeholder="请选择"></td></tr>
        <tr><th>Shipping ZIP</th><td><input name="zip" placeholder="请输入"></td></tr>
      </table>
    </form></body></html>`)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { mode: 'form', limit: 100 })
  const fields = snapshot.value.elements.filter(element => element.fieldContext)
  const labels = fields.map(field => field.fieldContext.inferredLabel).filter(Boolean)
  assert.ok(labels.includes('Billing ZIP'), `expected the billing header to be used, got ${JSON.stringify(labels)}`)
  assert.ok(labels.includes('Shipping ZIP'), `expected the shipping header to be used, got ${JSON.stringify(labels)}`)
  assert.equal(labels.includes('请选择'), false, 'a generic placeholder must never be a label')
  assert.equal(labels.includes('请输入'), false, 'a generic placeholder must never be a label')
  for (const field of fields) assert.equal(field.fieldContext.fieldNameRepeated, true, 'the repeated name is kept as evidence')
})

test('refs expire, and navigation invalidates every outstanding ref', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  // Drive a short TTL and an injectable clock so expiry is deterministic.
  const expiredCode = await page.evaluate(async () => {
    const { createPageAgent, createRefStore } = globalThis.__dsh
    let clock = 1_000_000
    const store = createRefStore({ ttlMs: 50, now: () => clock })
    const agent = createPageAgent({ store })
    const snapshot = agent.snapshot({ limit: 100 })
    const button = snapshot.elements.find(element => element.name === 'Place order')
    clock += 100
    try { await agent.act({ ref: button.ref, action: 'click', tabId: 5 }); return 'acted' }
    catch (error) { return error.code }
  })
  assert.equal(expiredCode, 'ELEMENT_NOT_FOUND', 'an expired or unknown ref is reported as not found')

  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const button = snapshot.value.elements.find(element => element.name === 'Place order')
  const afterNavigation = await page.evaluate(async ref => {
    // A history navigation replaces the document contents; outstanding refs must not survive it.
    globalThis.__agent.invalidate()
    try { await globalThis.__agent.act({ ref, action: 'click', tabId: 5 }); return 'acted' }
    catch (error) { return `${error.code}:${error.message}` }
  }, button.ref)
  assert.match(afterNavigation, /^ELEMENT_(STALE|NOT_FOUND):/, 'an invalidated ref must be refused')
  assert.match(afterNavigation, /new snapshot/i, 'the error must tell the caller to re-observe')

  // A snapshot taken before the history navigation must not resolve after it either.
  const staleAfterInvalidate = await page.evaluate(() => {
    const store = globalThis.__dsh.createRefStore({ revision: () => globalThis.__agent.navigationId })
    const element = document.getElementById('submit')
    const ref = store.create(element, { role: 'button', name: 'Place order' })
    globalThis.__agent.invalidate()
    try { store.resolve(ref); return 'resolved' }
    catch (error) { return `${error.code}:${error.message}` }
  })
  assert.match(staleAfterInvalidate, /^ELEMENT_STALE:/)
  assert.match(staleAfterInvalidate, /navigated/i)
})

test('the wait operation resolves on text and on a URL pattern, then times out clearly', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  await newAgent(page)

  const textWait = callAgentAsync(page, 'wait', { text: 'Checkout', timeoutMs: 2000 })
  assert.equal((await textWait).ok, true)

  const urlWait = callAgentAsync(page, 'wait', { url: '/checkout$', timeoutMs: 3000 })
  await page.evaluate(() => history.pushState({}, '', '/checkout'))
  const matched = await urlWait
  assert.equal(matched.ok, true, matched.message)
  assert.equal(matched.value.matchedUrl, true)

  const timedOut = await callAgentAsync(page, 'wait', { text: 'never appears here', timeoutMs: 150 })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'TIMEOUT')

  const invalid = await callAgentAsync(page, 'wait', {})
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_PARAMS')
})

test('open shadow roots are reachable through the same ref mechanism', async t => {
  const context = await withAgent(t, `<!doctype html><html><body style="font:16px sans-serif">
    <div id="host"></div>
    <script>
      const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
      shadow.innerHTML = '<span id="lbl">Shadow Name</span><input id="shadow-input" aria-labelledby="lbl"><button id="shadow-btn">Shadow Run</button>'
    </script></body></html>`)
  if (!context) return
  const { page } = context
  await newAgent(page)
  const snapshot = await callAgentAsync(page, 'snapshot', { limit: 100 })
  const run = snapshot.value.elements.find(element => element.name === 'Shadow Run')
  assert.ok(run, 'a control inside an open shadow root must be projected')
  const field = snapshot.value.elements.find(element => element.name === 'Shadow Name')
  assert.ok(field, 'aria-labelledby inside the same shadow root must resolve')

  const filled = await callAgentAsync(page, 'act', { ref: field.ref, action: 'fill', value: 'shadow-value', tabId: 5 })
  assert.equal(filled.ok, true, filled.message)
  assert.equal(await page.evaluate(() => document.getElementById('host').shadowRoot.getElementById('shadow-input').value), 'shadow-value')

  const clicked = await callAgentAsync(page, 'act', { ref: run.ref, action: 'click', tabId: 5 })
  assert.equal(clicked.ok, true, clicked.message)
})

test('the ref store bounds its size and drops detached nodes', async t => {
  const context = await withAgent(t, SAMPLE_FORM)
  if (!context) return
  const { page } = context
  const result = await page.evaluate(() => {
    const { createRefStore } = globalThis.__dsh
    const store = createRefStore({ max: 3 })
    const nodes = []
    for (let index = 0; index < 6; index += 1) {
      const node = document.createElement('div')
      node.textContent = `n${index}`
      document.body.append(node)
      nodes.push(node)
      store.create(node, { role: 'button', name: `n${index}` })
    }
    const bounded = store.size
    nodes[5].remove()
    store.prune()
    return { bounded, afterPrune: store.size }
  })
  assert.equal(result.bounded, 3, 'the store must honour its bound')
  assert.equal(result.afterPrune, 2, 'a detached node must be dropped on prune')
})

test('isVisible rejects zero-size, hidden, and aria-hidden elements', async t => {
  const context = await withAgent(t, `<!doctype html><html><body style="font:16px sans-serif">
    <button id="ok">Visible</button>
    <div style="width:0;height:0;overflow:hidden"><button id="clipped">Clipped</button></div>
    <button id="none" style="display:none">None</button>
    <button id="hidden" hidden>Hidden</button>
    <button id="aria" aria-hidden="true">Aria</button>
    <button id="invisible" style="visibility:hidden">Invisible</button>
    <button id="offscreen" style="position:absolute;left:-9999px;top:-9999px">Offscreen</button>
  </body></html>`)
  if (!context) return
  const { page } = context
  const seen = await page.evaluate(() => {
    const { isVisible } = globalThis.__dsh
    return Object.fromEntries(['ok', 'clipped', 'none', 'hidden', 'aria', 'invisible', 'offscreen']
      .map(id => [id, isVisible(document.getElementById(id))]))
  })
  assert.deepEqual(seen, { ok: true, clipped: false, none: false, hidden: false, aria: false, invisible: false, offscreen: false })
})
