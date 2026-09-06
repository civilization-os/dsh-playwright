import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, defaults, discoverBrowsers } from '../src/settings.js'
import { createWebHandler } from '../src/web.js'
import { BrowserManager } from '../src/browser.js'
import { RunbookStore } from '../src/runbooks.js'

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

test('browser trajectory contains no form values', () => {
  const manager = new BrowserManager({}, '')
  manager.trajectories.set('page-1', { origin: 'https://example.com', path: '/', steps: [] })
  manager.record('page-1', { type: 'act', action: 'fill', role: 'textbox', name: 'Password', requiresValue: true })
  assert.equal(JSON.stringify(manager.trajectory('page-1')).includes('hunter2'), false)
})
