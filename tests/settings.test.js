import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, defaults, discoverBrowsers } from '../src/settings.js'
import { createWebHandler } from '../src/web.js'
import { BrowserManager } from '../src/browser.js'
import { RunbookStore } from '../src/runbooks.js'
import { chromium } from 'playwright-core'

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
  const runbooks = { list: async () => [] }
  const call = createWebHandler(settings, browser, runbooks)
  const signal = new AbortController().signal
  assert.equal((await call('probe', {}, signal)).value.launch, 'available')
  const saved = await call('save', { browser: 'auto', headless: false, timeoutMs: 10000, width: 1280, height: 800 }, signal)
  assert.equal(saved.ok, true)
  assert.deepEqual(calls.map(item => item[0]), ['dispose', 'write'])
})

test('tool-facing values omit undefined optional fields', async () => {
  const locator = {
    count: async () => 1, isVisible: async () => true,
    evaluate: async () => ({ role: 'button', name: 'Run' }), click: async () => {},
  }
  const manager = new BrowserManager({}, '')
  const frame = { locator: () => locator, getByText: () => locator, isDetached: () => false, url: () => 'https://example.com/' }
  manager.page = async () => ({ url: () => 'https://example.com/' })
  manager.frames.set('frame-1', { id: 'frame-1', pageId: 'page-1', frame, revision: 0 })
  manager.refs.set('e-1', { pageId: 'page-1', frameId: 'frame-1', frameRevision: 0, path: 'button', role: 'button', name: 'Run' })
  const result = await manager.act('page-1', 'e-1', 'click')
  assert.equal(Object.hasOwn(result, 'expectedText'), false)
  assert.equal(JSON.stringify(result), '{"ok":true,"pageId":"page-1","frameId":"frame-1","frameUrl":"https://example.com/","url":"https://example.com/"}')
})

test('snapshots expose child frame summaries and bind refs to the selected frame', async () => {
  const project = name => ({ elements: [{ path: 'body>button:nth-of-type(1)', role: 'button', name, disabled: false, candidate: false }], headings: [name], totalInteractive: 1, candidateCount: 0, truncated: false })
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
  const written = await store.save({ name: 'Deploy app', task: 'Deploy one release', instructions: 'Select the requested environment and confirm the release identifier.' }, { origin: 'https://deploy.example.com', path: '/releases', steps: [] })
  const revised = await store.save({ previousId: written.id }, { origin: 'https://deploy.example.com', path: '/releases/new', steps: [{ type: 'act', action: 'click', role: 'button', name: 'Deploy' }] })
  assert.equal(revised.name, written.name)
  assert.equal(revised.task, written.task)
  assert.equal(revised.instructions, written.instructions)
  assert.equal(revised.steps.length, 1)
  assert.equal(revised.version, 2)
  assert.equal(revised.previousId, written.id)
  assert.equal(written.steps.length, 0)
  await assert.rejects(store.save({ previousId: written.id }, { origin: 'https://other.example.com', path: '/', steps: [{ type: 'act' }] }), /same site origin/)
})

test('browser trajectory contains no form values', () => {
  const manager = new BrowserManager({}, '')
  manager.trajectories.set('page-1', { origin: 'https://example.com', path: '/', steps: [] })
  manager.record('page-1', { type: 'act', action: 'fill', role: 'textbox', name: 'Password', requiresValue: true })
  assert.equal(JSON.stringify(manager.trajectory('page-1')).includes('hunter2'), false)
})
