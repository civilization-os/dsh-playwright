import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  isPortListening,
  findRunningBrowserDevToolsActivePort,
  resolveCdpEndpoint,
  BrowserManager,
} from '../src/browser.js'
import { DynamicBrowserManager } from '../src/index.js'
import { validateSettings } from '../src/settings.js'

test('isPortListening accurately detects listening and closed ports', async t => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => new Promise(resolve => server.close(resolve)))

  const openResult = await isPortListening(port, '127.0.0.1', 300)
  assert.equal(openResult, true)

  const closedResult = await isPortListening(port + 10000 > 65535 ? port - 10000 : port + 10000, '127.0.0.1', 100)
  assert.equal(closedResult, false)
})

test('findRunningBrowserDevToolsActivePort resolves active port and constructs wsEndpoint', async t => {
  const tempDir = join(tmpdir(), `test-cdp-${randomUUID()}`)
  const chromeDataDir = join(tempDir, 'Google/Chrome/User Data')
  await mkdir(chromeDataDir, { recursive: true })
  t.after(() => rm(tempDir, { recursive: true, force: true }).catch(() => {}))

  // 1. Port file exists but server not listening -> returns null
  const deadPort = 49152
  const activePortFile = join(chromeDataDir, 'DevToolsActivePort')
  await writeFile(activePortFile, `${deadPort}\n/devtools/browser/dead-uuid-123\n`)

  const mockEnv = { LOCALAPPDATA: tempDir, HOME: tempDir }
  const deadResult = await findRunningBrowserDevToolsActivePort('chrome', mockEnv, 'win32')
  assert.equal(deadResult, null)

  // 2. Start a TCP server on an ephemeral port and write to DevToolsActivePort -> returns resolved endpoint
  const liveServer = net.createServer()
  await new Promise(resolve => liveServer.listen(0, '127.0.0.1', resolve))
  const livePort = liveServer.address().port
  t.after(() => new Promise(resolve => liveServer.close(resolve)))

  await writeFile(activePortFile, `${livePort}\n/devtools/browser/live-guid-456\n`)
  const liveResult = await findRunningBrowserDevToolsActivePort('chrome', mockEnv, 'win32')
  assert.ok(liveResult)
  assert.equal(liveResult.port, livePort)
  assert.equal(liveResult.path, '/devtools/browser/live-guid-456')
  assert.equal(liveResult.wsEndpoint, `ws://127.0.0.1:${livePort}/devtools/browser/live-guid-456`)
})

test('resolveCdpEndpoint supports custom endpoints and auto-detection', async () => {
  // Configured ws URL
  const res1 = await resolveCdpEndpoint({
    backend: 'cdp',
    cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/custom',
  })
  assert.equal(res1.source, 'configured')
  assert.equal(res1.wsEndpoint, 'ws://127.0.0.1:9222/devtools/browser/custom')

  // Configured http URL automatically upgraded to ws
  const res2 = await resolveCdpEndpoint({
    backend: 'cdp',
    cdpEndpoint: 'http://127.0.0.1:9222',
  })
  assert.equal(res2.source, 'configured')
  assert.equal(res2.wsEndpoint, 'ws://127.0.0.1:9222')
})

test('settings validation accepts backend cdp and valid cdpEndpoint', () => {
  const valid = validateSettings({
    browser: 'auto',
    headless: false,
    timeoutMs: 10000,
    width: 1280,
    height: 800,
    backend: 'cdp',
    cdpEndpoint: 'ws://127.0.0.1:9222/test',
  })
  assert.equal(valid.backend, 'cdp')
  assert.equal(valid.cdpEndpoint, 'ws://127.0.0.1:9222/test')

  // Invalid protocol
  assert.throws(() => {
    validateSettings({
      browser: 'auto',
      headless: false,
      timeoutMs: 10000,
      width: 1280,
      height: 800,
      backend: 'cdp',
      cdpEndpoint: 'ftp://127.0.0.1:9222',
    })
  }, /Invalid cdpEndpoint protocol/)
})

test('DynamicBrowserManager routes cdp backend to playwright manager', async () => {
  const fakePlaywright = { id: 'playwright' }
  const fakeBridge = { id: 'bridge' }
  const fakeSettings = {
    read: async () => ({ backend: 'cdp' }),
  }
  const dynamic = new DynamicBrowserManager(fakePlaywright, fakeBridge, fakeSettings)
  const target = await dynamic.getTarget()
  assert.equal(target, fakePlaywright)
})

test('BrowserManager.status reflects CDP availability correctly', async t => {
  const tempDir = join(tmpdir(), `test-cdp-status-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })
  t.after(() => rm(tempDir, { recursive: true, force: true }).catch(() => {}))

  // 1. Missing endpoint
  const fakeStoreMissing = {
    read: async () => ({
      backend: 'cdp',
      browser: 'chrome',
      cdpEndpoint: '',
      timeoutMs: 3000,
    }),
  }
  const managerMissing = new BrowserManager(fakeStoreMissing, tempDir)
  // Mock discover
  managerMissing.discover = async () => []
  const statusMissing = await managerMissing.status(false)
  assert.equal(statusMissing.launch, 'missing')
  assert.equal(statusMissing.cdp, null)

  // 2. Custom endpoint configured
  const fakeStoreConfigured = {
    read: async () => ({
      backend: 'cdp',
      browser: 'chrome',
      cdpEndpoint: 'ws://127.0.0.1:9876/custom',
      timeoutMs: 3000,
    }),
  }
  const managerConfigured = new BrowserManager(fakeStoreConfigured, tempDir)
  managerConfigured.discover = async () => []
  const statusConfigured = await managerConfigured.status(false)
  assert.equal(statusConfigured.launch, 'available')
  assert.equal(statusConfigured.cdp.wsEndpoint, 'ws://127.0.0.1:9876/custom')
})

