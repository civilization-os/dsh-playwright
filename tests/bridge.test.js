import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { ChromeBridgeServer } from '../src/bridge/server.js'
import { ChromeBridgeManager } from '../src/bridge/manager.js'
import { DynamicBrowserManager } from '../src/index.js'
import { defaults } from '../src/settings.js'

test('bridge server manages client lifecycle and authentication', async t => {
  const port = 8791
  const server = new ChromeBridgeServer({ port, token: 'secret-token-123' })
  await server.start()
  t.after(() => server.stop())

  assert.equal(server.getStatus().connected, false)

  // 1. Connection with invalid token handshake is closed
  const badClient = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise(resolve => badClient.on('open', resolve))

  badClient.send(JSON.stringify({ type: 'auth', token: 'wrong-token' }))
  const closeEvent = await new Promise(resolve => badClient.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  assert.equal(closeEvent.code, 4001)

  // 2. Connection with valid query token succeeds
  const goodClient = new WebSocket(`ws://127.0.0.1:${port}?token=secret-token-123`)
  await new Promise(resolve => goodClient.on('open', resolve))
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.equal(server.getStatus().connected, true)
  goodClient.close()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(server.getStatus().connected, false)
})

test('bridge server dispatches requests and receives responses via requestId', async t => {
  const port = 8792
  const server = new ChromeBridgeServer({ port, token: '' })
  await server.start()
  t.after(() => server.stop())

  const mockClient = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise(resolve => mockClient.on('open', resolve))

  mockClient.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'request' && msg.method === 'browser.snapshot') {
      mockClient.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        ok: true,
        result: {
          snapshotId: 's-mock-1',
          url: 'https://example.com',
          title: 'Example Domain',
          elements: [
            { ref: 'e-1', role: 'button', name: 'Submit' },
          ],
        },
      }))
    }
  })

  // Wait for client to be recognized
  await new Promise(resolve => setTimeout(resolve, 50))

  const snapshot = await server.sendRequest('browser.snapshot', { mode: 'interactive' }, 3000)
  assert.equal(snapshot.snapshotId, 's-mock-1')
  assert.equal(snapshot.elements[0].name, 'Submit')

  mockClient.close()
})

test('bridge server handles client errors, timeouts and disconnections', async t => {
  const port = 8793
  const server = new ChromeBridgeServer({ port, token: '', timeoutMs: 300 })
  await server.start()
  t.after(() => server.stop())

  // 1. Not connected error
  await assert.rejects(
    server.sendRequest('browser.tabs'),
    err => err.code === 'BRIDGE_NOT_CONNECTED',
  )

  const mockClient = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise(resolve => mockClient.on('open', resolve))
  await new Promise(resolve => setTimeout(resolve, 50))

  // 2. Client returns structured error
  mockClient.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.method === 'browser.act') {
      mockClient.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        ok: false,
        error: { code: 'ELEMENT_STALE', message: 'Element is stale' },
      }))
    }
  })

  await assert.rejects(
    server.sendRequest('browser.act', { ref: 'e-stale', action: 'click' }),
    err => err.code === 'ELEMENT_STALE',
  )

  // 3. Request timeout
  await assert.rejects(
    server.sendRequest('browser.slow', {}, 100),
    err => err.code === 'BRIDGE_TIMEOUT',
  )

  // 4. In-flight request rejected on client disconnect
  const inFlight = server.sendRequest('browser.hang', {}, 5000)
  mockClient.close()
  await assert.rejects(
    inFlight,
    err => err.code === 'BRIDGE_DISCONNECTED',
  )
})

test('ChromeBridgeManager and DynamicBrowserManager switch backends seamlessly', async t => {
  const port = 8794
  const settingsMock = {
    state: { ...defaults, backend: 'extension', bridgePort: port, bridgeToken: '' },
    async read() { return this.state },
    async write(v) { this.state = v; return v },
  }

  const bridgeManager = new ChromeBridgeManager(settingsMock, '')
  t.after(() => bridgeManager.dispose())

  const mockPlaywright = {
    disposed: false,
    async status() { return { backend: 'playwright', launch: 'available' } },
    async snapshot() { return { source: 'playwright' } },
    async dispose() { this.disposed = true },
  }

  const dynamicManager = new DynamicBrowserManager(mockPlaywright, bridgeManager, settingsMock)
  t.after(() => dynamicManager.dispose())

  // In extension mode, without client connected
  const status1 = await dynamicManager.status()
  assert.equal(status1.backend, 'extension')
  assert.equal(status1.connected, false)
  assert.equal(status1.launch, 'missing')

  // Calling snapshot without extension connected throws clear guidance error
  await assert.rejects(
    dynamicManager.snapshot(),
    err => err.code === 'BRIDGE_NOT_CONNECTED',
  )

  // Switch to Playwright backend
  settingsMock.state.backend = 'playwright'
  const status2 = await dynamicManager.status()
  assert.equal(status2.backend, 'playwright')
  const snap = await dynamicManager.snapshot()
  assert.equal(snap.source, 'playwright')
})
