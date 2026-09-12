import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SettingsStore, defaults, discoverBrowsers } from '../src/settings.js'
import { createWebHandler } from '../src/web.js'
import { BrowserManager, isAuthExposedForUrl, redactHeaders, assertStringRecord } from '../src/browser.js'
import { RunbookStore } from '../src/runbooks.js'
import { losslessJson } from '../src/browser.js'
import { BrowserController } from '../src/client/controller.js'
import { zh, en } from '../src/client/locales.js'
import { chromium } from 'playwright-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { browserRequestParameters } from '../src/index.js'

test('browser request schema compiles with the Harness tool schema converter', () => {
  assert.doesNotThrow(() => defineTool({
    name: 'browser_request_schema_probe', description: 'Schema regression probe.', parameters: browserRequestParameters,
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: async () => ({}),
  }))
})

test('settings persist validated browser and display values', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'settings.json')
  const store = new SettingsStore(path)
  assert.deepEqual(await store.read(), defaults)
  const saved = await store.write({ browser: 'chrome', headless: true, timeoutMs: 12000, width: 1440, height: 900 })
  assert.equal(saved.browser, 'chrome')
  assert.deepEqual(await store.read(), saved)
  assert.equal((await readFile(path, 'utf8')).includes('chrome'), true)
  await assert.rejects(store.write({ ...saved, timeoutMs: 0 }))
})

test('browser discovery de-duplicates platform candidates', async () => {
  const found = await discoverBrowsers({ PROGRAMFILES: '/missing', 'PROGRAMFILES(X86)': '/missing', LOCALAPPDATA: '/missing' }, 'win32')
  assert.deepEqual(found, [])
})

test('settings RPC saves before returning refreshed status', async () => {
  const calls = []
  const settings = { write: async value => { calls.push(['write', value]) } }
  const browser = {
    dispose: async () => { calls.push(['dispose']) },
    status: async probe => ({ launch: probe ? 'available' : 'unchecked' }),
  }
  const runbooks = { catalog: async () => [] }
  const call = createWebHandler(settings, browser, runbooks)
  const signal = new AbortController().signal
  assert.equal((await call('probe', {}, signal)).value.launch, 'available')
  const saved = await call('save', { browser: 'auto', headless: false, timeoutMs: 10000, width: 1280, height: 800 }, signal)
  assert.equal(saved.ok, true)
  assert.deepEqual(calls.map(item => item[0]), ['write', 'dispose'])
})

test('tool-facing values omit undefined optional fields', async () => {
  const locator = {
    count: async () => 1, isVisible: async () => true,
    evaluate: async () => ({ role: 'button', name: 'Run' }), click: async () => {},
  }
  const manager = new BrowserManager({ read: async () => defaults }, '')
  const frame = { locator: () => locator, getByText: () => locator, isDetached: () => false, url: () => 'https://example.com/' }
  manager.page = async () => ({ url: () => 'https://example.com/' })
  manager.frames.set('frame-1', { id: 'frame-1', pageId: 'page-1', frame, revision: 0 })
  manager.refs.set('e-1', { pageId: 'page-1', frameId: 'frame-1', frameRevision: 0, createdAt: Date.now(), handle: locator, path: 'button', role: 'button', name: 'Run' })
  const result = await manager.act('page-1', 'e-1', 'click')
  assert.equal(Object.hasOwn(result, 'expectedText'), false)
  assert.equal(JSON.stringify(result).includes('undefined'), false)
})

test('settings RPC exposes grouped runbook details and creates editable revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-ui-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const runbooks = new RunbookStore(join(directory, 'runbooks.json'))
  const first = await runbooks.save({ name: 'Release', task: 'Publish release', instructions: 'Open the release page.' }, { origin: 'https://ci.example.com', path: '/releases', steps: [{ type: 'open', url: 'https://ci.example.com/releases' }] })
  const call = createWebHandler({ write: async () => {} }, { status: async () => ({ launch: 'available' }), dispose: async () => {} }, runbooks)
  const signal = new AbortController().signal
  const status = await call('status', {}, signal)
  assert.equal(status.value.runbooks[0].versionCount, 1)
  const detail = await call('runbook-detail', { id: first.id }, signal)
  assert.equal(detail.value.selectedRunbook.instructions, 'Open the release page.')
  const revised = await call('runbook-revise', { id: first.id, name: 'Release', task: 'Publish a release', instructions: 'Verify the tag first.', inputs: ['tag'], preconditions: ['Signed in'], successCriteria: 'Published package is visible.' }, signal)
  assert.equal(revised.value.selectedRunbook.version, 2)
  assert.equal(revised.value.runbooks.length, 1)
  assert.equal(revised.value.runbookVersions.length, 2)
  const enabled = await call('runbook-enable', { id: revised.value.selectedRunbook.id, enabled: true }, signal)
  assert.equal(enabled.value.selectedRunbook.enabled, true)
  assert.equal(enabled.value.runbooks[0].activeVersion, 2)
})

test('client dictionaries stay aligned and destructive UI uses an in-app dialog', async () => {
  assert.deepEqual(Object.keys(zh).toSorted(), Object.keys(en).toSorted())
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8')
  assert.equal(source.includes('window.confirm'), false)
  assert.equal(source.includes('role="alertdialog"'), true)
})

test('network records are bounded, filterable, redacted, and expose text bodies on demand', async () => {
  const listeners = new Map()
  const page = {
    frames: () => [],
    on: (event, listener) => listeners.set(event, listener),
  }
  const request = {
    url: () => 'https://api.example.com/users?token=secret&limit=10', method: () => 'POST', resourceType: () => 'fetch',
    headers: () => ({ authorization: 'Bearer secret', accept: 'application/json' }),
    allHeaders: async () => ({ authorization: 'Bearer secret', cookie: 'sid=secret', accept: 'application/json' }),
    postData: () => '{"password":"secret"}', sizes: async () => ({ responseBodySize: 9, responseHeadersSize: 20 }), failure: () => null,
  }
  const response = {
    request: () => request, status: () => 201, statusText: () => 'Created',
    headers: () => ({ 'content-type': 'application/json', 'content-length': '9', 'set-cookie': 'sid=secret' }),
    allHeaders: async () => ({ 'content-type': 'application/json', 'set-cookie': 'sid=secret' }),
    body: async () => Buffer.from('{"ok":1}\n'),
  }
  const manager = new BrowserManager({}, '')
  const pageId = manager.track(page); manager.page = async () => page
  listeners.get('request')(request); listeners.get('response')(response); await manager.finishRequest(pageId, request)
  const listed = await manager.network(pageId, 'list', undefined, 10, 'fetch', 201, '/users')
  assert.equal(listed.requests.length, 1)
  assert.equal(listed.requests[0].url, 'https://api.example.com/users')
  assert.deepEqual(listed.requests[0].queryKeys, ['token', 'limit'])
  assert.equal(JSON.stringify(listed).includes('secret'), false)
  const detail = await manager.network(pageId, 'detail', listed.requests[0].id)
  assert.equal(detail.requestHeaders.authorization, '[redacted]')
  assert.equal(detail.requestHeaders.cookie, '[redacted]')
  assert.equal(detail.responseHeaders['set-cookie'], '[redacted]')
  assert.equal(detail.hasPostData, true)
  const body = await manager.network(pageId, 'body', listed.requests[0].id, undefined, undefined, undefined, undefined, 4)
  assert.equal(body.body, '{"ok')
  assert.equal(body.truncated, true)
  assert.equal((await manager.network(pageId, 'clear')).cleared, 1)
})

test('browser-context requests share cookies and replay captured authentication internally', async t => {
  const browser = (await discoverBrowsers()).find(item => item.id === 'chrome') ?? (await discoverBrowsers()).find(item => item.id === 'msedge')
  if (!browser) return t.skip('system Chrome or Edge is unavailable')
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/login') {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=session-secret; Path=/; HttpOnly' }).end('<title>Login</title>')
      return
    }
    if (url.pathname === '/api/update') {
      let source = ''; for await (const chunk of request) source += chunk
      const input = JSON.parse(source || '{}')
      const value = {
        cookieOk: request.headers.cookie?.includes('sid=session-secret') === true,
        authorizationOk: request.headers.authorization === 'Bearer local-secret',
        csrfOk: request.headers['x-csrf-token'] === 'csrf-secret',
        hiddenBodyPreserved: input.hidden === 'body-secret', changed: input.change,
        hiddenQueryPreserved: url.searchParams.get('token') === 'query-secret', limit: url.searchParams.get('limit'),
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'updated=yes; Path=/' }).end(JSON.stringify(value))
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const browserInstance = await chromium.launch({ executablePath: browser.path, headless: true })
  t.after(() => browserInstance.close())
  const context = await browserInstance.newContext()
  const page = await context.newPage(); const manager = new BrowserManager({ read: async () => defaults }, '')
  const pageId = manager.track(page); manager.page = async () => page
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.goto(`${origin}/login`)
  manager.trajectories.set(pageId, { origin, path: '/login', steps: [] })
  await page.evaluate(async () => {
    await fetch('/api/update?token=query-secret&limit=10', {
      method: 'POST', headers: { authorization: 'Bearer local-secret', 'x-csrf-token': 'csrf-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ hidden: 'body-secret', change: 'old' }),
    })
  })
  const captured = await manager.network(pageId, 'list', undefined, 20, 'fetch')
  const template = captured.requests.find(item => item.url.endsWith('/api/update'))
  assert.ok(template)
  const result = await manager.requestApi(pageId, template.id, undefined, undefined, undefined, { limit: '20' }, undefined, '{"change":"new"}')
  assert.equal(result.status, 200)
  assert.equal(result.url, `${origin}/api/update`)
  assert.deepEqual(result.queryKeys, ['token', 'limit'])
  assert.deepEqual(JSON.parse(result.body), {
    cookieOk: true, authorizationOk: true, csrfOk: true, hiddenBodyPreserved: true,
    changed: 'new', hiddenQueryPreserved: true, limit: '20',
  })
  assert.equal(JSON.stringify(result).includes('session-secret'), false)
  assert.equal(JSON.stringify(result).includes('local-secret'), false)
  const requestStep = manager.trajectory(pageId).steps.at(-1)
  assert.deepEqual({ type: requestStep.type, method: requestStep.method, path: requestStep.path, bodyKeys: requestStep.bodyKeys, status: requestStep.status },
    { type: 'request', method: 'POST', path: '/api/update', bodyKeys: ['hidden', 'change'], status: 200 })
  assert.equal(JSON.stringify(requestStep).includes('secret'), false)
  assert.equal((await context.cookies(origin)).some(cookie => cookie.name === 'updated' && cookie.value === 'yes'), true)
})

test('snapshots expose child frame summaries and bind refs to the selected frame', async () => {
  const project = name => ({ elements: [{ path: 'body>button:nth-of-type(1)', role: 'button', name, disabled: false, candidate: false, handle: { dispose: async () => {} } }], headings: [name], totalInteractive: 1, candidateCount: 0, truncated: false })
  const makeFrame = (url, name, raw, children = []) => ({
    url: () => url, name: () => name, childFrames: () => children, isDetached: () => false,
    locator: selector => selector === 'body' ? { evaluate: async callback => callback.length === 2 ? raw : { interactiveCount: raw.totalInteractive, candidateCount: raw.candidateCount } } : { count: async () => raw.elements.length },
  })
  const child = makeFrame('https://widgets.example/frame?secret=hidden', 'widget', project('Inside frame'))
  const main = makeFrame('https://example.com/', '', project('Outside frame'), [child])
  const listeners = new Map()
  const page = { frames: () => [main, child], mainFrame: () => main, on: (event, listener) => listeners.set(event, listener), url: () => 'https://example.com/', title: async () => 'Example' }
  const manager = new BrowserManager({}, '')
  const pageId = manager.track(page)
  manager.page = async () => page
  const top = await manager.snapshot(pageId)
  assert.equal(top.frames.length, 1)
  assert.equal(top.frames[0].url, 'https://widgets.example/frame')
  assert.equal(top.frames[0].interactiveCount, 1)
  const nested = await manager.snapshot(pageId, 80, top.frames[0].frameId)
  assert.equal(nested.elements[0].name, 'Inside frame')
  assert.equal(manager.refs.get(nested.elements[0].ref).frameId, nested.frameId)
  listeners.get('framenavigated')(child)
  await assert.rejects(manager.act(pageId, nested.elements[0].ref, 'click'), /stale/i)
})

test('form snapshots infer labels from complex visible structure', async t => {
  const browser = (await discoverBrowsers()).find(item => item.id === 'chrome') ?? (await discoverBrowsers()).find(item => item.id === 'msedge')
  if (!browser) return t.skip('system Chrome or Edge is unavailable')
  const context = await chromium.launch({ executablePath: browser.path, headless: true })
  t.after(() => context.close())
  const page = await context.newPage({ viewport: { width: 1000, height: 800 } })
  await page.setContent(`
    <style>
      body { font: 16px sans-serif; }
      .grid { display: grid; grid-template-columns: 180px 360px; gap: 16px 12px; align-items: center; }
      input, textarea, select { width: 320px; min-height: 32px; }
      small { display: block; margin-top: 4px; }
      table { margin-top: 24px; } th { text-align: right; padding-right: 16px; }
    </style>
    <form>
      <h2>Checkout</h2>
      <fieldset>
        <legend>Shipping address</legend>
        <div class="grid">
          <div><span>Recipient phone</span></div>
          <div class="field"><input required autocomplete="tel"><small class="hint">Used by the courier</small></div>
          <div>Delivery note</div>
          <div><textarea></textarea></div>
          <div id="speed-label">Delivery speed</div>
          <div><select aria-labelledby="speed-label"><option>Standard</option><option>Express</option></select></div>
        </div>
      </fieldset>
      <table><tr><th>Company tax ID</th><td><input></td></tr></table>
    </form>
    <form style="position:relative;height:160px;margin-top:30px">
      <input id="ambiguous" style="position:absolute;left:220px;top:60px;width:240px">
      <span style="position:absolute;left:108px;top:66px">Account</span>
      <span style="position:absolute;left:300px;top:35px">Reference</span>
    </form>`)
  const manager = new BrowserManager({}, '')
  const pageId = manager.track(page)
  manager.page = async () => page
  const snapshot = await manager.snapshot(pageId, 80, undefined, undefined, false, 'form')
  const assertLosslessJson = value => {
    if (Array.isArray(value)) return value.forEach(assertLosslessJson)
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(item, undefined, `undefined at ${key}`)
      assertLosslessJson(item)
    }
  }
  assertLosslessJson(snapshot)
  const fields = snapshot.elements.filter(item => item.fieldContext)
  const phone = fields.find(item => item.fieldContext.inferredLabel === 'Recipient phone')
  assert.equal(phone.fieldContext.group, 'Shipping address')
  assert.equal(phone.fieldContext.required, true)
  assert.equal(phone.fieldContext.autocomplete, 'tel')
  assert.equal(phone.fieldContext.helpText, 'Used by the courier')
  assert.equal(['high', 'medium'].includes(phone.fieldContext.confidence), true)
  assert.equal(fields.some(item => item.fieldContext.inferredLabel === 'Delivery note'), true)
  assert.equal(fields.some(item => item.fieldContext.inferredLabel === 'Company tax ID'), true)
  const select = fields.find(item => item.name === 'Delivery speed')
  assert.deepEqual(select.fieldContext.options, ['Standard', 'Express'])
  assert.equal(snapshot.forms.some(item => item.name === 'Shipping address' && item.fieldCount === 3), true)
  const ambiguous = fields.find(item => manager.refs.get(item.ref).path.endsWith('input:nth-of-type(1)') && item.fieldContext.labelCandidates?.some(candidate => candidate.text === 'Account'))
  assert.equal(ambiguous.fieldContext.confidence, 'ambiguous')
  assert.equal(ambiguous.fieldContext.inferredLabel, undefined)
  assert.deepEqual(new Set(ambiguous.fieldContext.labelCandidates.map(candidate => candidate.text)), new Set(['Account', 'Reference']))

  const compact = await manager.snapshot(pageId)
  assert.equal(Object.hasOwn(compact, 'forms'), false)
  assert.equal(compact.elements.some(item => item.fieldContext?.inferredLabel === 'Recipient phone'), true)
})

test('fixed DOM queries reject ambiguous targets and password values', async () => {
  const locator = {
    count: async () => 1, isVisible: async () => true, getAttribute: async name => name === 'type' ? 'password' : null,
    inputValue: async () => 'secret', innerText: async () => 'safe text',
  }
  const frame = { locator: () => locator, isDetached: () => false, url: () => 'https://example.com/' }
  const manager = new BrowserManager({}, '')
  manager.page = async () => ({ mainFrame: () => frame })
  manager.trackFrame('page-1', frame)
  await assert.rejects(manager.query('page-1', undefined, '#password', 'value'), /Password/)
  assert.equal((await manager.query('page-1', undefined, '#message', 'text')).value, 'safe text')
  await assert.rejects(manager.query('page-1', undefined, '#message', 'attribute', 'onclick'), /attribute/)
})

test('runbooks hide drafts from model lookup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbooks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RunbookStore(join(directory, 'runbooks.json'))
  const draft = await store.save({ name: 'Create todo', task: 'Create one todo' }, {
    origin: 'https://example.com', path: '/todos',
    steps: [{ type: 'act', action: 'fill', role: 'textbox', name: 'Todo', requiresValue: true }, { type: 'act', action: 'click', role: 'button', name: 'Add' }],
  })
  assert.equal(draft.enabled, false)
  assert.deepEqual(await store.list({ url: 'https://example.com/todos', task: 'todo' }), [])
  await store.setEnabled(draft.id, true)
  assert.equal((await store.list({ url: 'https://example.com/todos', task: 'todo' }))[0].id, draft.id)
})

test('runbooks support descriptive procedures without browser steps', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-guidance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RunbookStore(join(directory, 'runbooks.json'))
  const draft = await store.save({
    name: 'Triage failures', task: 'Triage a failed build',
    instructions: 'Confirm the branch and failed job. Open the first failing step. If it is flaky, rerun once. Finish when the cause is recorded.',
  }, { origin: 'https://ci.example.com', path: '/builds', steps: [] })
  assert.equal(draft.instructions.startsWith('Confirm the branch'), true)
  assert.equal(draft.steps.length, 0)
  await store.setEnabled(draft.id, true)
  const summary = (await store.list({ url: 'https://ci.example.com/builds/42', task: 'flaky' }))[0]
  assert.equal(summary.id, draft.id)
  assert.equal(summary.instructionsPreview.includes('rerun once'), true)
  await assert.rejects(store.save({ name: 'Empty', task: 'Empty' }, { origin: 'https://example.com', path: '/', steps: [] }), /instructions or a reusable browser trajectory/)
})

test('runbooks read legacy entries without instructions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-legacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runbooks.json')
  await new RunbookStore(path).write([{ id: 'legacy', name: 'Legacy', task: 'Old task', origin: 'https://example.com', path: '/', version: 1, previousId: '', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', successCount: 0, failureCount: 0, steps: [{ type: 'act' }] }])
  assert.equal((await new RunbookStore(path).get('legacy')).instructions, '')
})

test('runbook revisions can attach a later browser trajectory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-revision-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RunbookStore(join(directory, 'runbooks.json'))
  const written = await store.save({ name: 'Deploy app', task: 'Deploy one release', instructions: 'Select the requested environment and confirm the release identifier.', inputs: ['release'], preconditions: ['Signed in'], successCriteria: 'Release appears in history.' }, { origin: 'https://deploy.example.com', path: '/releases', steps: [] })
  const revised = await store.save({ previousId: written.id }, { origin: 'https://deploy.example.com', path: '/releases/new', steps: [{ type: 'act', action: 'click', role: 'button', name: 'Deploy' }] })
  assert.equal(revised.name, written.name)
  assert.equal(revised.task, written.task)
  assert.equal(revised.instructions, written.instructions)
  assert.deepEqual(revised.inputs, ['release'])
  assert.deepEqual(revised.preconditions, ['Signed in'])
  assert.equal(revised.successCriteria, 'Release appears in history.')
  assert.equal(revised.steps.length, 1)
  assert.equal(revised.version, 2)
  assert.equal(revised.previousId, written.id)
  assert.equal(written.steps.length, 0)
  await assert.rejects(store.save({ previousId: written.id }, { origin: 'https://other.example.com', path: '/', steps: [{ type: 'act' }] }), /same site origin/)
  await store.setEnabled(written.id, true)
  const [catalog] = await store.catalog()
  assert.equal(catalog.id, revised.id)
  assert.equal(catalog.versionCount, 2)
  assert.equal(catalog.activeVersion, 1)
  assert.deepEqual((await store.versions(revised.id)).map(item => item.version), [2, 1])
  await store.delete(written.id)
  assert.equal((await store.get(revised.id, true)).previousId, '')
})

test('runbook matching ranks Chinese task intent and records outcomes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-ranking-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RunbookStore(join(directory, 'runbooks.json'))
  const deploy = await store.save({ name: '部署失败处理', task: '处理部署失败', instructions: '查看失败任务并重新部署。' }, { origin: 'https://ci.example.com', path: '/builds', steps: [] })
  const users = await store.save({ name: '用户管理', task: '修改用户资料', instructions: '打开用户详情。' }, { origin: 'https://ci.example.com', path: '/', steps: [] })
  await store.setEnabled(deploy.id, true); await store.setEnabled(users.id, true)
  const matches = await store.list({ url: 'https://ci.example.com/builds/42', task: '帮我处理这个部署失败' })
  assert.equal(matches[0].id, deploy.id)
  assert.equal(matches[0].relevance > 0, true)
  const reported = await store.report(deploy.id, false, 'Button moved')
  assert.equal(reported.failureCount, 1)
  assert.equal(reported.lastOutcome, 'Button moved')
  assert.equal(Boolean(reported.lastRunAt), true)
})

test('browser trajectory contains no form values', () => {
  const manager = new BrowserManager({}, '')
  manager.trajectories.set('page-1', { origin: 'https://example.com', path: '/', steps: [] })
  manager.record('page-1', { type: 'act', action: 'fill', role: 'textbox', name: 'Password', requiresValue: true })
  assert.equal(JSON.stringify(manager.trajectory('page-1')).includes('hunter2'), false)
})

test('element refs keep exact DOM identity and reject replacement', async t => {
  const browser = (await discoverBrowsers()).find(item => item.id === 'chrome') ?? (await discoverBrowsers()).find(item => item.id === 'msedge')
  if (!browser) return t.skip('system Chrome or Edge is unavailable')
  const context = await chromium.launch({ executablePath: browser.path, headless: true })
  t.after(() => context.close())
  const page = await context.newPage(); await page.setContent('<input id="original" aria-label="Name"><input id="second" aria-label="Other">')
  const manager = new BrowserManager({ read: async () => defaults }, '')
  const pageId = manager.track(page); manager.page = async () => page
  const snapshot = await manager.snapshot(pageId)
  const ref = snapshot.elements.find(item => item.name === 'Name').ref
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<input id="inserted" aria-label="Name">'))
  await manager.act(pageId, ref, 'fill', 'right-target')
  assert.equal(await page.locator('#original').inputValue(), 'right-target')
  assert.equal(await page.locator('#inserted').inputValue(), '')
  await page.evaluate(() => document.querySelector('#original').replaceWith(document.querySelector('#original').cloneNode(true)))
  await assert.rejects(manager.act(pageId, ref, 'fill', 'must-not-apply'), /stale|hidden/i)
})

test('browser actions validate required values, target roles, and ambiguous fields', async () => {
  const handle = { evaluate: async callback => callback.name === 'projectElementFingerprint' ? { role: 'button', name: 'Run' } : true, isVisible: async () => true, click: async () => {}, dispose: async () => {} }
  const manager = new BrowserManager({ read: async () => defaults }, '')
  const frame = { isDetached: () => false, url: () => 'https://example.com/', getByText: () => ({ first: () => ({ isVisible: async () => false, waitFor: async () => {} }) }) }
  manager.page = async () => ({ url: () => 'https://example.com/' }); manager.frames.set('frame-1', { id: 'frame-1', pageId: 'page-1', frame, revision: 0 })
  manager.refs.set('button', { pageId: 'page-1', frameId: 'frame-1', frameRevision: 0, createdAt: Date.now(), handle, role: 'button', name: 'Run' })
  await assert.rejects(manager.act('page-1', 'button', 'fill'), /requires value/)
  await assert.rejects(manager.act('page-1', 'button', 'fill', 'x'), /text-editable/)
  manager.refs.set('ambiguous', { pageId: 'page-1', frameId: 'frame-1', frameRevision: 0, createdAt: Date.now(), handle, role: 'textbox', name: '', fieldContext: { confidence: 'ambiguous' } })
  await assert.rejects(manager.act('page-1', 'ambiguous', 'fill', 'x'), /Ambiguous/)
})

test('context startup is single-flight and recovers after an unexpected close', async () => {
  const manager = new BrowserManager({ read: async () => defaults }, '')
  manager.discover = async () => [{ id: 'chrome', path: 'chrome' }]
  let launches = 0; let closeListener
  manager.launchContext = async () => {
    launches += 1
    return { pages: () => [], on: (event, listener) => { if (event === 'close') closeListener = listener }, close: async () => {}, setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} }
  }
  const [first, second] = await Promise.all([manager.ensureContext(), manager.ensureContext()])
  assert.equal(first, second); assert.equal(launches, 1)
  closeListener(); await new Promise(resolve => setImmediate(resolve))
  await manager.ensureContext(); assert.equal(launches, 2)
})

test('status polling preserves the last probe result for the same configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-probe-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const manager = new BrowserManager({ read: async () => defaults }, directory); manager.discover = async () => [{ id: 'chrome', path: 'chrome' }]
  manager.launchContext = async () => ({ close: async () => {} })
  assert.equal((await manager.status(true)).launch, 'available'); assert.equal((await manager.status(false)).launch, 'available')
})

test('shutdown cancels and closes an in-flight browser launch', async () => {
  const manager = new BrowserManager({ read: async () => defaults }, ''); manager.discover = async () => [{ id: 'chrome', path: 'chrome' }]
  let finishLaunch; let closed = 0
  manager.launchContext = () => new Promise(resolve => { finishLaunch = () => resolve({ pages: () => [], on: () => {}, close: async () => { closed += 1 } }) })
  const starting = manager.ensureContext(); await new Promise(resolve => setImmediate(resolve)); const stopping = manager.dispose(); finishLaunch()
  await assert.rejects(starting, /cancelled/); await stopping; assert.equal(closed, 1); assert.equal(manager.context, undefined)
})

test('implicit page selection creates the first page and rejects multiple pages', async () => {
  const created = { id: 'created' }; const manager = new BrowserManager({}, '')
  manager.ensureContext = async () => ({ newPage: async () => created })
  assert.equal(await manager.page(), created)
  manager.pages.set('one', {}); manager.pages.set('two', {})
  await assert.rejects(manager.page(), /more than one page/)
})

test('element ref cache evicts old handles at its fixed bound', async () => {
  const manager = new BrowserManager({}, ''); let disposed = 0
  for (let index = 0; index < 501; index += 1) manager.refs.set(`e-${index}`, { createdAt: Date.now(), handle: { dispose: async () => { disposed += 1 } } })
  await manager.pruneRefs(); assert.equal(manager.refs.size, 500); assert.equal(disposed, 1); assert.equal(manager.refs.has('e-0'), false)
})

test('runbook lookup respects path and serializes concurrent writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-path-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RunbookStore(join(directory, 'runbooks.json'))
  const [admin, checkout] = await Promise.all([
    store.save({ name: 'Admin', task: 'Manage users', instructions: 'Open a user.' }, { origin: 'https://example.com', path: '/admin/users', steps: [] }),
    store.save({ name: 'Checkout', task: 'Pay order', instructions: 'Confirm the total.' }, { origin: 'https://example.com', path: '/checkout', steps: [] }),
  ])
  await store.setEnabled(admin.id, true); await store.setEnabled(checkout.id, true)
  assert.deepEqual((await store.list({ url: 'https://example.com/checkout/confirm?order=secret#payment' })).map(item => item.id), [checkout.id])
  assert.deepEqual(await store.list({ url: 'https://example.com/admin' }), [])
  assert.equal((await store.read()).length, 2)
})

test('runbook storage recovers from backup and keeps one enabled revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-playwright-runbook-backup-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runbooks.json'); const store = new RunbookStore(path)
  const first = await store.save({ name: 'Deploy', task: 'Deploy app', instructions: 'Review release.' }, { origin: 'https://example.com', path: '/deploy', steps: [] })
  await store.setEnabled(first.id, true)
  const second = await store.save({ previousId: first.id, instructions: 'Review and confirm release.' })
  await store.setEnabled(second.id, true)
  const all = await store.list({ includeDisabled: true }); assert.equal(all.filter(item => item.enabled).length, 1); assert.equal(all.find(item => item.enabled).id, second.id)
  await writeFile(path, '{broken')
  assert.equal((await store.read()).length > 0, true)
})

test('iframe actions capture and dismiss dialogs', async t => {
  const browser = (await discoverBrowsers()).find(item => item.id === 'chrome') ?? (await discoverBrowsers()).find(item => item.id === 'msedge')
  if (!browser) return t.skip('system Chrome or Edge is unavailable')
  const context = await chromium.launch({ executablePath: browser.path, headless: true }); t.after(() => context.close())
  const page = await context.newPage()
  await page.setContent(`<iframe srcdoc="<button onclick=&quot;confirm('Continue?')&quot;>Confirm</button>"></iframe>`)
  const manager = new BrowserManager({ read: async () => defaults }, ''); const pageId = manager.track(page); manager.page = async () => page
  const top = await manager.snapshot(pageId); const nested = await manager.snapshot(pageId, 80, top.frames[0].frameId)
  const result = await manager.act(pageId, nested.elements.find(item => item.name === 'Confirm').ref, 'click')
  assert.deepEqual(result.dialogs.map(item => ({ type: item.type, message: item.message })), [{ type: 'confirm', message: 'Continue?' }])
})

test('lossless tool output removes unsupported values recursively', () => {
  assert.deepEqual(losslessJson({ missing: undefined, invalid: Number.NaN, values: [1, undefined], nested: { skip: 1n } }), { invalid: null, values: [1, null], nested: {} })
})

test('browser controller ignores an older response and protects saves from polling', async () => {
  const pending = []
  const controller = new BrowserController((endpoint) => new Promise(resolve => pending.push({ endpoint, resolve })))
  const first = controller.request('status'); const second = controller.request('probe')
  pending[1].resolve({ ok: true, value: { launch: 'available' } }); await second
  pending[0].resolve({ ok: true, value: { launch: 'missing' } }); await first
  assert.equal(controller.state.launch, 'available')
  const save = controller.request('save', defaults); assert.equal(await controller.request('status'), false)
  pending[2].resolve({ ok: true, value: { configured: defaults } }); assert.equal(await save, true)
  controller.dispose()
})

test('invalid settings do not close the active browser', async () => {
  let disposed = false
  const call = createWebHandler({ write: async () => {} }, { dispose: async () => { disposed = true } }, { list: async () => [] })
  const result = await call('save', { ...defaults, timeoutMs: 0 }, new AbortController().signal)
  assert.equal(result.ok, false); assert.equal(disposed, false)
})

test('pre-existing expected text cannot verify an action', async () => {
  let clicked = false
  const handle = { evaluate: async callback => callback.name === 'projectElementFingerprint' ? { role: 'button', name: 'Run' } : true, isVisible: async () => true, click: async () => { clicked = true } }
  const manager = new BrowserManager({ read: async () => defaults }, ''); manager.page = async () => ({ url: () => 'https://example.com/' })
  const frame = { isDetached: () => false, url: () => 'https://example.com/', getByText: () => ({ first: () => ({ isVisible: async () => true }) }) }
  manager.frames.set('frame-1', { id: 'frame-1', pageId: 'page-1', frame, revision: 0 }); manager.refs.set('e-1', { pageId: 'page-1', frameId: 'frame-1', frameRevision: 0, createdAt: Date.now(), handle, role: 'button', name: 'Run' })
  await assert.rejects(manager.act('page-1', 'e-1', 'click', undefined, 'Already here'), /already visible/); assert.equal(clicked, false)
})

test('settings persist and validate self-signed TLS trust and trusted origins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pw-trusted-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'settings.json')
  const store = new SettingsStore(path)
  const initial = await store.read()
  assert.equal(initial.ignoreHTTPSErrors, false)
  assert.equal(initial.exposeAuthFields, false)
  assert.deepEqual(initial.trustedOrigins, [])

  const saved = await store.write({
    ...defaults,
    ignoreHTTPSErrors: true,
    exposeAuthFields: true,
    trustedOrigins: ['https://localhost:8443', 'https://internal.test.local:9000/path'],
  })
  assert.equal(saved.ignoreHTTPSErrors, true)
  assert.equal(saved.exposeAuthFields, true)
  assert.deepEqual(saved.trustedOrigins, ['https://localhost:8443', 'https://internal.test.local:9000'])

  await assert.rejects(store.write({ ...defaults, ignoreHTTPSErrors: 'not-bool' }), /Invalid ignoreHTTPSErrors/)
  await assert.rejects(store.write({ ...defaults, exposeAuthFields: 123 }), /Invalid exposeAuthFields/)
  await assert.rejects(store.write({ ...defaults, trustedOrigins: 'not-array' }), /Invalid trustedOrigins/)
  await assert.rejects(store.write({ ...defaults, trustedOrigins: ['invalid-url'] }), /Invalid trustedOrigins entry/)
})

test('sensitive headers and authentication field visibility respect origin allowlist and settings', async () => {
  const defaultConf = { ...defaults }
  assert.equal(isAuthExposedForUrl('https://localhost:8443/api', defaultConf), false)

  const headers = { authorization: 'Bearer test-token', cookie: 'session=xyz', accept: 'application/json' }
  const redactedDefault = redactHeaders(headers, false)
  assert.equal(redactedDefault.authorization, '[redacted]')
  assert.equal(redactedDefault.cookie, '[redacted]')
  assert.equal(redactedDefault.accept, 'application/json')
  assert.throws(() => assertStringRecord({ authorization: 'Bearer test' }, 'headers', false), /Authentication and session headers/)

  const exposedConf = { ...defaults, exposeAuthFields: true, trustedOrigins: ['https://localhost:8443'] }
  assert.equal(isAuthExposedForUrl('https://localhost:8443/api', exposedConf), true)
  assert.equal(isAuthExposedForUrl('https://untrusted.com/api', exposedConf), false)

  const allowedExposed = redactHeaders(headers, true)
  assert.equal(allowedExposed.authorization, 'Bearer test-token')
  assert.equal(allowedExposed.cookie, 'session=xyz')
  assert.equal(allowedExposed.accept, 'application/json')
  assert.doesNotThrow(() => assertStringRecord({ authorization: 'Bearer test' }, 'headers', true))

  const globalExposedConf = { ...defaults, exposeAuthFields: true, trustedOrigins: [] }
  assert.equal(isAuthExposedForUrl('https://anywhere.local/api', globalExposedConf), true)
})

test('browser launch passes ignoreHTTPSErrors option to persistent context', async () => {
  let passedOptions = null
  const originalLaunch = chromium.launchPersistentContext
  chromium.launchPersistentContext = async (userDataDir, options) => {
    passedOptions = options
    return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, close: async () => {} }
  }
  try {
    const manager = new BrowserManager({ read: async () => defaults }, '')
    const context = await manager.launchContext({ ...defaults, ignoreHTTPSErrors: true }, { id: 'chrome', path: '/fake/chrome' }, tmpdir())
    assert.equal(passedOptions.ignoreHTTPSErrors, true)
    await context.close()
  } finally {
    chromium.launchPersistentContext = originalLaunch
  }
})

test('requestApi supports independent context requests, json payloads, file uploads, and binary downloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pw-request-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  let receivedFetch = null
  const fakeResponse = {
    status: () => 200,
    statusText: () => 'OK',
    ok: () => true,
    url: () => 'https://api.example.com/upload',
    headers: () => ({ 'content-type': 'application/pdf', 'content-length': '13' }),
    body: async () => Buffer.from('%PDF-1.4 test'),
  }

  const fakeContext = {
    request: {
      fetch: async (url, options) => {
        receivedFetch = { url, options }
        return fakeResponse
      },
    },
  }

  const manager = new BrowserManager({ read: async () => defaults }, directory)
  manager.ensureContext = async () => fakeContext

  const targetDownload = join(directory, 'result.pdf')
  const uploadSource = join(directory, 'source.txt')
  await writeFile(uploadSource, 'sample-file-content')

  const result = await manager.requestApi(
    undefined,
    undefined,
    'https://api.example.com/upload',
    'POST',
    {},
    { debug: '1' },
    { key: 'value' },
    undefined,
    undefined,
    { file: uploadSource },
    targetDownload,
  )

  assert.equal(receivedFetch.url, 'https://api.example.com/upload?debug=1')
  assert.equal(receivedFetch.options.method, 'POST')
  assert.ok(receivedFetch.options.multipart)
  assert.ok(receivedFetch.options.multipart.file)
  assert.equal(receivedFetch.options.multipart.file.name, 'source.txt')
  assert.equal(result.downloaded.path, targetDownload)
  assert.equal(result.downloaded.bytes, 13)
  assert.equal(await readFile(targetDownload, 'utf8'), '%PDF-1.4 test')
})

test('browser route supports mock, block, list, and clear actions', async () => {
  const routes = []
  const fakeContext = {
    route: async (pattern, handler) => { routes.push({ pattern, handler }) },
    unroute: async (pattern) => { const idx = routes.findIndex(r => r.pattern === pattern); if (idx !== -1) routes.splice(idx, 1) },
  }

  const manager = new BrowserManager({ read: async () => defaults }, '')
  manager.ensureContext = async () => fakeContext

  const mockRes = await manager.route('mock', { urlPattern: '**/api/v1/user', status: 200, body: { id: 1, name: 'Agent' } })
  assert.equal(mockRes.type, 'mock')
  assert.equal(mockRes.status, 'active')

  const blockRes = await manager.route('block', { resourceTypes: ['image', 'font'] })
  assert.equal(blockRes.type, 'block')

  const listed = await manager.route('list')
  assert.equal(listed.routes.length, 2)

  const clearedOne = await manager.route('clear', { routeId: mockRes.id })
  assert.equal(clearedOne.cleared, 1)

  const clearedAll = await manager.route('clear')
  assert.equal(clearedAll.cleared, 1)
})

test('browser cookies supports list, set, and clear actions with security filtering', async () => {
  let storedCookies = [
    { name: 'session_id', value: 'secret123', domain: 'example.com', path: '/' },
    { name: 'theme', value: 'dark', domain: 'example.com', path: '/' },
  ]

  const fakeContext = {
    cookies: async () => storedCookies,
    addCookies: async (cookies) => { storedCookies.push(...cookies) },
    clearCookies: async () => { storedCookies = [] },
  }

  const manager = new BrowserManager({ read: async () => defaults }, '')
  manager.ensureContext = async () => fakeContext

  const listed = await manager.cookies('list')
  assert.equal(listed.count, 2)
  assert.equal(listed.cookies.find(c => c.name === 'session_id').value, '[redacted]')
  assert.equal(listed.cookies.find(c => c.name === 'theme').value, '[redacted]')

  const added = await manager.cookies('set', { cookies: [{ name: 'lang', value: 'zh', domain: 'example.com' }] })
  assert.equal(added.success, true)
  assert.equal(added.count, 1)
  assert.equal(storedCookies.length, 3)

  const cleared = await manager.cookies('clear')
  assert.equal(cleared.success, true)
  assert.equal(storedCookies.length, 0)
})
