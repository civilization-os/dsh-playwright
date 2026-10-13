/**
 * Plugin wiring tests.
 *
 * `apply()` is executed against a mock Cordis context so route registration, tool registration, and
 * the Chrome Bridge mount are verified without starting a real Harness. The webserver mock throws on
 * a duplicate `(kind, path)` pair exactly like the real `@deepseek-ai/dsh-host-webserver`, which is
 * what makes the double-registration regression detectable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal Cordis context: effects, a service registry, and the three services the plugin uses. */
function createMockContext(options = {}) {
  const registered = { tools: [], skills: [], routes: [], upgrades: [] }
  const disposers = []
  const services = {
    tools: { register: tool => { registered.tools.push(tool); return () => {} } },
    skills: { register: skill => { registered.skills.push(skill); return () => {} } },
    webServer: {
      port: options.port ?? 3080,
      host: options.host ?? '127.0.0.1',
      register(route) {
        // The real implementation keys routes by both kind and path and throws on a collision.
        const key = `${route.kind}:${route.path}`
        if (registered.routes.some(existing => existing.key === key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        registered.routes.push({ key, ...route })
        return () => {}
      },
      registerUpgrade(route) {
        const key = `upgrade:${route.path}`
        if (registered.upgrades.some(existing => existing.key === key)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
        registered.upgrades.push({ key, ...route })
        return () => {}
      },
    },
  }
  if (options.withConnection !== false) {
    services.connection = { rpc: { handle: (channel, handler) => { registered.rpcChannel = { channel, handler } } } }
  }
  if (options.withWebServer === false) delete services.webServer
  // Cordis exposes only available services; an absent one must read as undefined, not throw.
  const connectionService = services.connection

  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    effect(body) {
      const disposer = typeof body === 'function' ? body() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject(names, callback) {
      const available = names.filter(name => services[name])
      // A Cordis injection only fires when every requested service is present.
      if (available.length === names.length) callback(ctx)
      return () => {}
    },
    get tools() { return services.tools },
    get skills() { return services.skills },
    get webServer() { return services.webServer },
    get connection() { return connectionService },
  }
  return { ctx, registered, services, disposeAll: async () => { for (const dispose of disposers.reverse()) await dispose() } }
}

async function withPluginDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function loadPlugin() {
  // Import through a fresh query so module-level state never leaks between tests.
  return import(`../src/index.js?case=${Math.random().toString(36).slice(2)}`)
}

/**
 * Wait for an observable condition instead of sleeping a fixed number of milliseconds. `apply()`
 * finishes its bridge mount asynchronously, and a fixed sleep is a race under a loaded test runner.
 */
async function waitFor(condition, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('apply registers every tool, the skill, and the RPC channel exactly once', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })

  assert.equal(registered.tools.length, 17, `expected 17 tools, got ${registered.tools.map(tool => tool.name).join(', ')}`)
  const names = registered.tools.map(tool => tool.name)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const expected of ['browser_tabs', 'browser_snapshot', 'browser_act', 'browser_bridge_status', 'browser_pairing_token']) {
    assert.ok(names.includes(expected), `${expected} must be registered`)
  }
  assert.equal(registered.skills.length, 1)
  assert.equal(registered.skills[0].name, 'browser-operation')
  assert.equal(registered.rpcChannel.channel, '/playwright-browser')
})

test('the HTTP fallback route is not registered while the RPC channel owns the path', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  // Registering both would throw "duplicate prefix route" in the real webServer, so reaching the
  // end of apply() without an exception is itself the regression check.
  await plugin.apply(ctx, { dataDir: directory })
  const prefixes = registered.routes.filter(route => route.path === '/playwright-browser')
  assert.equal(prefixes.length, 0, 'the RPC channel already mounts this prefix; a second route would throw')
})

test('the HTTP fallback route is registered when no connection service exists', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext({ withConnection: false })
  await plugin.apply(ctx, { dataDir: directory })
  const prefixes = registered.routes.filter(route => route.path === '/playwright-browser')
  assert.equal(prefixes.length, 1, 'without the RPC channel the HTTP route must be exposed')
  assert.equal(prefixes[0].kind, 'prefix')
  assert.equal(typeof prefixes[0].handler, 'function')
})

test('the Chrome Bridge upgrade route is registered on the DSH web server when enabled', async t => {
  const directory = await withPluginDirectory(t)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    chromeBridge: { enabled: true, mode: 'webServer', path: '/chrome-bridge', publicUrl: 'wss://dsh.example.com/chrome-bridge' },
  }))
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  await waitFor(() => registered.upgrades.length > 0, { label: 'the bridge upgrade route' })

  assert.deepEqual(registered.upgrades.map(route => route.path), ['/chrome-bridge'], 'no extra port may be opened in webServer mode')
  const http = registered.routes.filter(route => route.path === '/chrome-bridge')
  assert.equal(http.length, 1, 'the session and health endpoints need an HTTP prefix route')
  assert.equal(http[0].kind, 'prefix')

  // The bridge health endpoint answers and reports protocol 1.
  const response = { headersSent: false, writeHead() { this.headersSent = true }, end(body) { this.body = body } }
  await http[0].handler({ method: 'GET', url: '/chrome-bridge/health', headers: {}, socket: undefined, signal: undefined }, response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.service, 'dsh-chrome-bridge')
  assert.equal(payload.value.publicUrl, 'wss://dsh.example.com/chrome-bridge')
})

test('a disabled Chrome Bridge registers no route at all', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(registered.upgrades.length, 0)
  assert.equal(registered.routes.some(route => route.path === '/chrome-bridge'), false)
})

test('standalone mode starts its own listener and closes it on dispose', async t => {
  const directory = await withPluginDirectory(t)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    chromeBridge: { enabled: true, mode: 'standalone', host: '127.0.0.1', port: 0 },
  }))
  const plugin = await loadPlugin()
  const { ctx, registered, disposeAll } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const statusTool = registered.tools.find(tool => tool.name === 'browser_bridge_status')
  // Standalone mode publishes its own URL once the listener is up.
  await waitFor(async () => /^ws:\/\/127\.0\.0\.1:\d+\/chrome-bridge$/.test((await statusTool.execute({}, {})).url), { label: 'the standalone bridge listener' })
  // Standalone mode must not touch the DSH web server.
  assert.equal(registered.upgrades.length, 0)

  const status = await statusTool.execute({}, {})
  assert.equal(status.enabled, true)
  assert.equal(status.mode, 'standalone')
  assert.match(status.url, /^ws:\/\/127\.0\.0\.1:\d+\/chrome-bridge$/)

  // Disposal must release the listener so the port does not leak.
  await disposeAll()
})

test('a chrome-extension call fails clearly while the bridge is disabled', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const tabs = registered.tools.find(tool => tool.name === 'browser_tabs')
  await assert.rejects(
    tabs.execute({ action: 'list', backend: 'chrome-extension' }, {}),
    /Chrome Bridge is disabled|No Chrome extension is connected/,
  )
})

test('browser tools prefer the extension and never fall back to Playwright', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const tabs = registered.tools.find(tool => tool.name === 'browser_tabs')

  // No backend argument at all: the configured default is the extension, so the call must report the
  // bridge state instead of quietly launching the isolated Playwright browser.
  await assert.rejects(tabs.execute({ action: 'list' }, {}), /Chrome Bridge is disabled/)

  // The consent flag alone must not reroute a call that did not select Playwright.
  await assert.rejects(tabs.execute({ action: 'list', userRequestedPlaywright: true }, {}), /Chrome Bridge is disabled/)
})

test('Playwright is refused unless the user explicitly asked for it', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const tool = name => registered.tools.find(entry => entry.name === name)

  await assert.rejects(
    tool('browser_tabs').execute({ action: 'list', backend: 'playwright' }, {}),
    /userRequestedPlaywright/,
  )
  // Playwright-only capabilities need the same consent, and the message must say which one it is.
  await assert.rejects(
    tool('browser_screenshot').execute({ pageId: 'page-1' }, {}),
    /browser_screenshot[\s\S]*userRequestedPlaywright/,
  )
  await assert.rejects(
    tool('browser_network').execute({ pageId: 'page-1', action: 'list' }, {}),
    /browser_network[\s\S]*userRequestedPlaywright/,
  )
})

test('a configured Playwright default is used without a per-call consent flag', async t => {
  const directory = await withPluginDirectory(t)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ backend: 'playwright' }))
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const save = registered.tools.find(entry => entry.name === 'browser_runbook_save')

  // Reaching the Playwright backend is the point: trajectory() then rejects because no page was
  // opened, which proves the consent gate was not what stopped the call.
  await assert.rejects(
    save.execute({ userRequested: true, pageId: 'page-1', name: 'Checkout', task: 'Pay', instructions: 'Steps' }, {}),
    /no browser trajectory/,
  )
})

test('bridge status reports whether the extension answers the probe', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const status = await registered.tools.find(tool => tool.name === 'browser_bridge_status').execute({}, {})
  assert.equal(status.enabled, false)
  assert.equal(status.healthy, false)
  assert.equal(status.health.code, 'BRIDGE_OFFLINE')
  assert.equal(status.defaultBackend, 'chrome-extension')
})

test('the pairing token tool creates, lists, and revokes without re-exposing the token', async t => {
  const directory = await withPluginDirectory(t)
  const plugin = await loadPlugin()
  const { ctx, registered } = createMockContext()
  await plugin.apply(ctx, { dataDir: directory })
  const tokenTool = registered.tools.find(tool => tool.name === 'browser_pairing_token')

  const created = await tokenTool.execute({ action: 'create', label: 'laptop' }, {})
  assert.equal(created.label, 'laptop')
  assert.ok(created.token.length >= 32)
  assert.match(created.masked, /…/)

  const listed = await tokenTool.execute({ action: 'list' }, {})
  assert.equal(listed.tokens.length, 1)
  assert.equal(JSON.stringify(listed).includes(created.token), false, 'a listing must never return the token')

  const revoked = await tokenTool.execute({ action: 'revoke', id: created.id }, {})
  assert.equal(revoked.revoked, 1)
  assert.deepEqual(revoked.tokens, [])

  await assert.rejects(tokenTool.execute({ action: 'revoke' }, {}), /token id/)
})
