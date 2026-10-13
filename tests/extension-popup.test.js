/**
 * Popup integration tests.
 *
 * The built `dist/extension/popup.html` is loaded into a real Chromium page with a stubbed
 * `chrome.*` API. This executes the actual popup bundle, so a runtime or protocol error in the
 * popup cannot hide behind the service worker tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser.helper.js'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const extensionDirectory = join(root, 'dist', 'extension')

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }

/**
 * `file://` blocks ES modules, and the popup is an ES module, so the built directory is served
 * over HTTP for the test. This is the same document the extension loads in its popup window.
 */
async function serveExtension(t) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    const file = join(extensionDirectory, path === '/' ? 'popup.html' : path)
    if (!file.startsWith(extensionDirectory)) { response.writeHead(403); response.end(); return }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404); response.end('not found')
    }
  })
  t.after(() => server.close())
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  return `http://127.0.0.1:${server.address().port}`
}

/**
 * Install the `chrome.*` stub every test needs. Defined as a string so Playwright evaluates it in
 * the page before any extension script runs.
 */
const CHROME_STUB = `
  globalThis.__calls = [];
  globalThis.__listener = undefined;
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        globalThis.__calls.push(message);
        return { ok: true, status: { status: 'connected', detail: 'Connected to the DSH bridge.', peerId: 'bridge-1', bridgeUrl: 'wss://host.example/chrome-bridge' } };
      },
      onMessage: { addListener: listener => { globalThis.__listener = listener } },
    },
    tabs: { query: async () => ([{ id: 11, url: 'https://example.com/checkout', title: 'Checkout', active: true }]) },
    permissions: { request: async ({ origins }) => { globalThis.__calls.push({ command: 'permissions.request', origins }); return true } },
    storage: {
      local: {
        get: async defaults => Object.assign({}, defaults, { bridgeUrl: 'wss://stored.example/chrome-bridge', label: 'Stored label' }),
        set: async value => { globalThis.__calls.push({ command: 'storage.set', value }) },
      },
    },
  };
`

/**
 * Load the built popup into a page. Top-level `await` in the bundle needs a parser that accepts it,
 * which `addScriptTag` provides because the script is served as a module.
 */
async function withPopup(t, prepare) {
  if (!existsSync(join(extensionDirectory, 'popup.html'))) {
    t.skip('run `pnpm build:extension` first')
    return undefined
  }
  const browser = await launchTestBrowser()
  if (!browser) { t.skip('no Chrome, Edge, or cached Chromium is available'); return undefined }
  t.after(() => browser.close())
  const origin = await serveExtension(t)
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)))
  await page.addInitScript({ content: CHROME_STUB })
  await page.goto(`${origin}/popup.html`)
  // The bundle awaits storage and the initial refresh before settling.
  await new Promise(resolveWait => setTimeout(resolveWait, 300))
  if (prepare) await prepare(page)
  return { browser, page, pageErrors, origin }
}

test('the built popup renders and asks the worker for status', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context

  const state = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    dot: document.getElementById('dot').dataset.state,
    url: document.getElementById('url').value,
    label: document.getElementById('label').value,
    tabInfo: document.getElementById('tabInfo').textContent,
    error: document.getElementById('error').hidden,
    calls: globalThis.__calls,
  }))

  assert.deepEqual(context.pageErrors, [], `the popup must not throw: ${context.pageErrors.join('; ')}`)
  assert.equal(state.url, 'wss://stored.example/chrome-bridge', 'stored settings must populate the form')
  assert.equal(state.label, 'Stored label')
  assert.equal(state.label, 'Stored label')
  assert.match(state.tabInfo, /Checkout/, 'the active tab must be described')
  // The popup must address the worker on the shared channel with a known command.
  assert.ok(state.calls.some(call => call.channel === 'dsh-chrome-bridge' && call.command === 'status'), `expected a status request, saw ${JSON.stringify(state.calls)}`)
})

test('the popup surfaces the worker status and peer id', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context
  // Push a status event the way the worker does, and confirm the popup reacts.
  await page.evaluate(() => globalThis.__listener({ channel: 'dsh-chrome-bridge', event: 'status', status: { status: 'connected', detail: 'Connected to the DSH bridge.', peerId: 'bridge-42' } }))
  await new Promise(resolveWait => setTimeout(resolveWait, 50))
  const state = await page.evaluate(() => ({
    dot: document.getElementById('dot').dataset.state,
    status: document.getElementById('status').textContent,
    peer: document.getElementById('peerInfo').textContent,
  }))
  assert.equal(state.dot, 'connected')
  assert.match(state.status, /Connected to the DSH bridge/)
  assert.equal(state.peer, 'bridge-42')
})

test('Connect saves the visible settings before connecting', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context
  await page.fill('#url', 'wss://new.example/chrome-bridge')
  await page.fill('#token', 'k'.repeat(43))
  await page.fill('#label', 'Desk')
  await page.click('#connect')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))

  const calls = await page.evaluate(() => globalThis.__calls)
  const save = calls.find(call => call.command === 'save')
  const connect = calls.find(call => call.command === 'connect')
  assert.ok(save, 'Connect must persist the visible settings first')
  assert.equal(save.bridgeUrl, 'wss://new.example/chrome-bridge')
  assert.equal(save.token, 'k'.repeat(43))
  assert.equal(save.label, 'Desk')
  assert.ok(connect, 'Connect must then ask the worker to connect')
  // The token must be cleared from the field after it is handed to the worker.
  assert.equal(await page.inputValue('#token'), '')
})

test('Grant access requests only the bridge origin', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context
  await page.fill('#url', 'wss://host.example/chrome-bridge')
  await page.click('#grant')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  const calls = await page.evaluate(() => globalThis.__calls)
  const request = calls.find(call => call.command === 'permissions.request')
  assert.ok(request, 'Grant access must request a host permission')
  // Chrome accepts only http(s) patterns, so the wss:// address is translated.
  assert.deepEqual(request.origins, ['https://host.example/*'], 'only the bridge origin may be requested')
  assert.match(await page.textContent('#urlHint'), /Access granted/)
})

test('an invalid bridge URL is reported instead of silently ignored', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context
  await page.fill('#url', 'https://host.example/chrome-bridge')
  await page.click('#grant')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  const state = await page.evaluate(() => ({
    hidden: document.getElementById('error').hidden,
    text: document.getElementById('error').textContent,
    calls: globalThis.__calls.filter(call => call.command === 'permissions.request').length,
  }))
  assert.equal(state.hidden, false, 'the error area must be shown')
  assert.match(state.text, /ws:\/\/ or wss:\/\//)
  assert.equal(state.calls, 0, 'no permission may be requested for an invalid URL')
})

test('a worker failure is shown to the user', async t => {
  const context = await withPopup(t)
  if (!context) return
  const { page } = context
  await page.evaluate(() => {
    globalThis.chrome.runtime.sendMessage = async message => {
      globalThis.__calls.push(message)
      if (message.command === 'save') return { ok: false, error: 'The pairing token was rejected.' }
      return { ok: true, status: { status: 'disconnected', detail: 'idle' } }
    }
  })
  await page.fill('#url', 'wss://host.example/chrome-bridge')
  await page.click('#save')
  await new Promise(resolveWait => setTimeout(resolveWait, 120))
  const text = await page.textContent('#error')
  assert.match(text, /pairing token was rejected/, 'a worker error must reach the user')
})
