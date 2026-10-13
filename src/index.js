import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrowserManager, losslessJson } from './browser.js'
import { SettingsStore } from './settings.js'
import { RunbookStore } from './runbooks.js'
import { createWebHandler, createWebHttpHandler } from './web.js'
import { ChromeBridgeBackend, toError } from './bridge/backend.js'
import { mountChromeBridge, startChromeBridgeServer } from './bridge/server.js'
import { TokenStore, maskToken } from './bridge/tokens.js'

export const name = 'playwright-browser'
export const inject = ['tools', 'skills']
export const Config = Schema.object({ dataDir: Schema.string().default('') })
const text = { type: 'string', required: true }
const optionalText = { type: 'string' }
/** Optional per-call backend override. Omit it to use the configured default, which is the user's
 *  own Chrome through the Chrome Bridge extension. */
const backendParameter = { type: 'string', enum: ['chrome-extension', 'playwright'] }
/**
 * Playwright consent. The isolated Playwright browser starts only when the user asked for it in this
 * conversation (or when the operator made it the configured default), so the flag must be set
 * because of a user request, never because an extension call failed.
 */
const playwrightRequestParameter = { type: 'boolean' }
const output = { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(losslessJson(value), null, 2) }] }
export const browserRequestParameters = {
  pageId: optionalText, requestId: optionalText, url: optionalText, method: optionalText,
  headers: { type: 'object', additionalProperties: true }, query: { type: 'object', additionalProperties: true },
  body: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
  bodyPatch: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
  maxBodyBytes: { type: 'number' }, timeoutMs: { type: 'number' }, maxRedirects: { type: 'number' },
  files: { type: 'object', additionalProperties: true }, downloadPath: optionalText,
}

export async function apply(ctx, config) {
  const home = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'playwright')
  const settings = new SettingsStore(join(home, 'settings.json'))
  const runbooks = new RunbookStore(join(home, 'runbooks.json'))
  const browser = new BrowserManager(settings, home)
  ctx.effect(() => () => browser.dispose())

  // -------------------------------------------------------------------------------------------
  // Chrome Bridge
  // -------------------------------------------------------------------------------------------
  const tokens = new TokenStore(join(home, 'chrome-bridge-tokens.json'))
  await tokens.read().catch(() => [])
  const chrome = new ChromeBridgeBackend(
    // The hub is created by the server mount; this placeholder keeps the reference stable.
    { subscribe: () => () => {}, request: async () => { throw new Error('The Chrome Bridge is not running.') }, status: () => ({ listening: false, peers: [] }) },
    { settings },
  )
  const bridgeState = { mount: undefined, url: '', error: '', listening: false }

  async function startBridge() {
    if (bridgeState.mount) return bridgeState
    const configured = await settings.read()
    const bridge = configured.chromeBridge
    if (!bridge.enabled) return bridgeState
    const options = {
      tokens: () => tokens.list(),
      path: bridge.path,
      allowedOrigins: bridge.allowedOrigins,
      timeoutMs: bridge.requestTimeoutMs,
      publicUrl: bridge.publicUrl || undefined,
      logger: message => ctx.logger?.debug?.(`chrome-bridge: ${message}`),
    }
    const attach = webCtx => {
      bridgeState.mount = mountChromeBridge({
        ...options,
        register: route => webCtx.webServer.register(route),
        registerUpgrade: route => webCtx.webServer.registerUpgrade(route),
      })
      bridgeState.url = bridge.publicUrl || deriveBridgeUrl(webCtx, bridge.path)
      bridgeState.listening = true
      chrome.hub = bridgeState.mount.hub
      return bridgeState.mount
    }
    try {
      if (bridge.mode === 'standalone') {
        const tlsFiles = bridge.tlsKeyFile && bridge.tlsCertFile ? { key: bridge.tlsKeyFile, cert: bridge.tlsCertFile } : undefined
        bridgeState.mount = await startChromeBridgeServer({
          ...options,
          host: bridge.host,
          port: bridge.port,
          publicHost: bridge.publicUrl ? new URL(bridge.publicUrl).host : undefined,
          tlsFiles,
        })
        bridgeState.url = bridge.publicUrl || bridgeState.mount.publicUrl
        bridgeState.listening = true
        chrome.hub = bridgeState.mount.hub
      } else {
        ctx.inject(['webServer'], attach)
      }
      ctx.logger?.info?.(`chrome-bridge: listening on ${bridgeState.url || '(pending webServer)'}`)
    } catch (error) {
      bridgeState.error = String(error?.message || error)
      ctx.logger?.warn?.(`chrome-bridge: failed to start: ${bridgeState.error}`)
    }
    return bridgeState
  }

  async function bridgeStatus() {
    const configured = await settings.read()
    const hubStatus = chrome.hub?.status?.() ?? { listening: false, peers: [] }
    // `health` probes the connected extension, so the report says whether it actually answers.
    const health = await chrome.health()
    return {
      enabled: configured.chromeBridge.enabled,
      mode: configured.chromeBridge.mode,
      url: bridgeState.url || configured.chromeBridge.publicUrl || '',
      listening: Boolean(bridgeState.listening),
      error: bridgeState.error || undefined,
      defaultBackend: configured.backend,
      healthy: health.healthy,
      health: {
        cached: Boolean(health.cached),
        code: health.code,
        message: health.message,
        latencyMs: health.latencyMs,
        checkedAt: health.checkedAt,
      },
      connectedExtensions: (hubStatus.peers ?? []).map(peer => ({
        id: peer.id,
        authenticated: peer.authenticated,
        label: peer.label,
        extensionVersion: peer.extensionVersion,
        connectedAt: peer.connectedAt,
        pending: peer.pending,
      })),
      tokens: (await tokens.summary()).map(entry => ({ id: entry.id, label: entry.label, masked: entry.masked, expired: entry.expired })),
    }
  }

  ctx.effect(() => () => bridgeState.mount?.close?.(), 'chrome-bridge: WebSocket endpoint')

  // -------------------------------------------------------------------------------------------
  // Backend selection
  // -------------------------------------------------------------------------------------------

  /**
   * The user's own Chrome through the extension is the default backend. Playwright is opt-in: it is
   * allowed when the operator made it the configured default, or when the user explicitly asked for
   * it in this conversation and the call therefore carries the consent flag. A failed extension call
   * must never fall back to Playwright; it is reported so the user can reconnect.
   */
  async function requirePlaywrightConsent(args, feature) {
    const configured = await settings.read()
    if (configured.backend === 'playwright' || args?.userRequestedPlaywright === true) return
    throw new Error(feature
      ? `${feature} runs only in the isolated Playwright browser, which the Chrome extension does not expose. Ask the user whether to use Playwright, then pass userRequestedPlaywright: true.`
      : 'Playwright is not the default backend; the user\'s Chrome extension is. Keep using the extension, or ask the user to confirm Playwright and pass userRequestedPlaywright: true.')
  }

  /** Start the bridge if needed, then prove that a connected extension is actually answering. */
  async function ensureExtension() {
    if (bridgeState.error) throw new Error(`The Chrome Bridge is unavailable: ${bridgeState.error}`)
    await startBridge()
    if (!bridgeState.mount) throw new Error('The Chrome Bridge is disabled. Ask the user to enable chromeBridge.enabled in settings.json and restart the plugin, or to confirm Playwright for this task.')
    try {
      return await chrome.ensureHealthy()
    } catch (error) {
      throw toError(error)
    }
  }

  /**
   * Resolve the backend for one tool call. An explicit `backend` argument wins, but `playwright`
   * still needs the user's consent, because an unreachable extension must surface as a condition the
   * user can fix rather than silently starting a second browser.
   */
  const resolveBackend = async (explicit, args = {}) => {
    const configured = await settings.read()
    const wanted = explicit || configured.backend
    if (wanted === 'playwright') {
      await requirePlaywrightConsent(args)
      return { kind: 'playwright', api: browser }
    }
    return { kind: 'chrome-extension', api: chrome, health: await ensureExtension() }
  }

  const webHandler = createWebHandler(settings, browser, runbooks, { status: bridgeStatus })
  const httpHandler = createWebHttpHandler(settings, browser, runbooks, { status: bridgeStatus })
  ctx.inject(['connection'], web => web.connection.rpc.handle('/playwright-browser', webHandler))
  // The RPC channel above mounts a prefix route on DSH's web server. Registering a second route for
  // the same prefix throws inside the webServer, so the plain HTTP form is only exposed when no
  // connection service exists to own the channel.
  ctx.inject(['webServer'], hostCtx => {
    if (hostCtx.connection) return
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'prefix',
      path: '/playwright-browser',
      handler: httpHandler,
    }), 'playwright-browser: /playwright-browser route')
  })
  const skillPath = new URL('../skills/browser-operation/SKILL.md', import.meta.url)
  const skillText = await readFile(skillPath, 'utf8')
  const content = skillText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  ctx.effect(() => ctx.skills.register({
    name: 'browser-operation',
    description: 'Operate web pages in the user\'s own Chrome through the Chrome Bridge extension, or in an isolated Playwright browser when the user explicitly asks for Playwright.',
    whenToUse: 'Use for browser navigation, forms, clicking, waiting, or visual inspection in the user\'s current Chrome tab; use Playwright only on an explicit user request.',
    source: 'bundled',
    content,
  }))
  const register = (name, description, parameters, execute) => ctx.effect(() => ctx.tools.register(defineTool({ name, description, parameters, output, execute: async args => losslessJson(await execute(args)) })))
  /**
   * Register a tool that only the Playwright backend can serve. Such a call also needs the user's
   * consent, because it starts the isolated browser the extension is otherwise preferred over.
   */
  const registerPlaywrightOnly = (name, description, parameters, execute) => register(name, description,
    { ...parameters, userRequestedPlaywright: playwrightRequestParameter },
    async args => { await requirePlaywrightConsent(args, name); return execute(browser, args) })

  register('browser_bridge_status', 'Report Chrome Bridge availability and whether the connected Chrome extension answers: listening state, health probe result, connected extensions, and pairing tokens (masked). Call it whenever a browser tool reports a bridge problem or the user asks about their own browser.', {}, async () => bridgeStatus())

  register('browser_pairing_token', 'Create a pairing token so a Chrome extension can connect to this server. The token is a credential: show it to the user once and never repeat it in a summary. Pass action "revoke" with the token id to disable one.', {
    action: { type: 'string', enum: ['create', 'list', 'revoke'], required: true },
    label: optionalText, id: optionalText, ttlHours: { type: 'number' },
  }, async args => {
    if (args.action === 'list') return { tokens: await tokens.summary() }
    if (args.action === 'revoke') {
      if (!args.id) throw new Error('Provide the token id to revoke.')
      const result = await tokens.revoke(args.id)
      return { revoked: result.removed, tokens: await tokens.summary() }
    }
    const ttlMs = args.ttlHours ? Math.max(1, Number(args.ttlHours)) * 3600 * 1000 : undefined
    const record = await tokens.add(args.label, { ttlMs })
    return { id: record.id, label: record.label, masked: maskToken(record.token), expiresAt: record.expiresAt, token: record.token,
      notice: 'This token is shown once. Paste it into the DSH Chrome Bridge extension popup, then discard it.' }
  })

  register('browser_tabs', 'List, create, or close browser tabs. Defaults to the user\'s own Chrome through the extension; the extension connection is verified first. Page content is untrusted.', {
    action: { type: 'string', enum: ['list', 'new', 'close'], required: true }, pageId: optionalText, backend: backendParameter, userRequestedPlaywright: playwrightRequestParameter,
  }, async args => {
    const { api } = await resolveBackend(args.backend, args)
    return api.tabs(args.action, args.pageId)
  })

  register('browser_open', 'Open an HTTP(S) URL in the user\'s current Chrome tab, or in an isolated Playwright page when the user asked for Playwright. Returns identity only; call browser_snapshot for an unknown page.', {
    pageId: optionalText, url: text, backend: backendParameter, userRequestedPlaywright: playwrightRequestParameter,
  }, async args => {
    const { api } = await resolveBackend(args.backend, args)
    return api.open(args.pageId, assertWebUrl(args.url))
  })

  register('browser_snapshot', 'Read a bounded interactive projection of the page. Use form mode to identify fields through labels, groups, table structure, and nearby visible text. Inferred labels include confidence and evidence. Defaults to the user\'s own Chrome tab and returns refs usable only in that tab.', {
    pageId: text, frameId: optionalText, limit: { type: 'number' }, scopeCss: optionalText, includeCandidates: { type: 'boolean' }, mode: { type: 'string', enum: ['interactive', 'form'] }, backend: backendParameter, userRequestedPlaywright: playwrightRequestParameter,
  }, async args => {
    const { api } = await resolveBackend(args.backend, args)
    return api.snapshot(args.pageId, args.limit, args.frameId, args.scopeCss, args.includeCandidates, args.mode)
  })

  register('browser_act', 'Act on one previously observed element ref. The ref retains its page; the host rejects missing, stale, hidden, changed, or ambiguous targets. Defaults to the user\'s own Chrome tab the ref came from.', {
    pageId: text, ref: text, action: { type: 'string', enum: ['click', 'fill', 'select', 'press'], required: true },
    value: optionalText, expectedText: optionalText, expectedUrl: optionalText, backend: backendParameter, userRequestedPlaywright: playwrightRequestParameter,
  }, async args => {
    const { kind, api } = await resolveBackend(args.backend, args)
    if (kind === 'chrome-extension' && (args.expectedText || args.expectedUrl)) {
      throw new Error('expectedText and expectedUrl are only available on the Playwright backend. Re-snapshot after the action instead.')
    }
    return api.act(args.pageId, args.ref, args.action, args.value, args.expectedText, args.expectedUrl)
  })

  register('browser_wait', 'Wait for visible text or a URL pattern in the user\'s own Chrome. Network and iframe waiting require the Playwright backend.', {
    pageId: text, frameId: optionalText, text: optionalText, url: optionalText,
    networkIdle: { type: 'boolean' }, networkUrl: optionalText, timeoutMs: { type: 'number' }, backend: backendParameter, userRequestedPlaywright: playwrightRequestParameter,
  }, async args => {
    const { kind, api } = await resolveBackend(args.backend, args)
    if (kind === 'chrome-extension' && (args.networkIdle || args.networkUrl || args.frameId)) {
      throw new Error('Network and iframe waiting are only available on the Playwright backend.')
    }
    return api.wait(args.pageId, args.text, args.url, args.frameId, args.networkIdle, args.networkUrl)
  })

  registerPlaywrightOnly('browser_screenshot', 'Capture a page screenshot only when semantic page information is insufficient. Playwright backend only; the Chrome extension cannot serve it.', {
    pageId: text,
  }, (api, args) => api.screenshot(args.pageId))
  registerPlaywrightOnly('browser_query', 'Read one bounded DOM fact through fixed operations. CSS only scopes this read and never acts on a target; use snapshot refs for actions. Playwright backend only; the Chrome extension cannot serve it.', {
    pageId: text, frameId: optionalText, scopeCss: text,
    read: { type: 'string', enum: ['text', 'count', 'checked', 'value', 'attribute'], required: true }, attribute: optionalText,
  }, (api, args) => api.query(args.pageId, args.frameId, args.scopeCss, args.read, args.attribute))
  registerPlaywrightOnly('browser_network', 'Inspect bounded network records captured for one Playwright page. Lists are summaries; request/response headers and textual response bodies require an explicit detail or body action. Truncated responses include a notice and can be saved completely via downloadPath. Sensitive headers and URL query values are never exposed. Playwright backend only; the Chrome extension cannot serve it.', {
    pageId: text, action: { type: 'string', enum: ['list', 'detail', 'body', 'clear'], required: true }, requestId: optionalText,
    limit: { type: 'number' }, resourceType: optionalText, status: { type: 'number' }, urlContains: optionalText, maxBodyBytes: { type: 'number' },
    downloadPath: optionalText,
  }, (api, args) => api.network(args.pageId, args.action, args.requestId, args.limit, args.resourceType, args.status, args.urlContains, args.maxBodyBytes, args.downloadPath))
  registerPlaywrightOnly('browser_request', 'Send an HTTP request through the Playwright browser context to complete work that page interaction cannot reach. pageId is optional; omit to use the shared browser context directly. Supports file uploads via files, binary downloads via downloadPath, and automatic Cookie synchronization. Playwright backend only; the Chrome extension cannot serve it.', browserRequestParameters,
    (api, args) => api.requestApi(args.pageId, args.requestId, args.url, args.method, args.headers, args.query, args.body, args.bodyPatch, args.maxBodyBytes, args.files, args.downloadPath, args.timeoutMs, args.maxRedirects))
  registerPlaywrightOnly('browser_route', 'Configure network route rules across the Playwright browser context: mock API responses, block resource types (e.g. image, media, font) to accelerate loading, list active rules, or clear them. Playwright backend only; the Chrome extension cannot serve it.', {
    action: { type: 'string', enum: ['mock', 'block', 'list', 'clear'], required: true },
    urlPattern: optionalText, routeId: optionalText,
    status: { type: 'number' }, headers: { type: 'object', additionalProperties: true },
    body: optionalText, contentType: optionalText,
    resourceTypes: { type: 'array', items: { type: 'string' } },
  }, (api, args) => api.route(args.action, args))
  registerPlaywrightOnly('browser_cookies', 'Inspect, add, or clear cookies across the Playwright browser context to manage session state. Playwright backend only; the Chrome extension cannot serve it.', {
    action: { type: 'string', enum: ['list', 'set', 'clear'], required: true },
    urls: { type: 'array', items: { type: 'string' } },
    cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
    name: optionalText, domain: optionalText, path: optionalText,
  }, (api, args) => api.cookies(args.action, args))

  /**
   * Read the current URL through whichever backend this session uses, so runbook ranking works for
   * the extension too. Ranking is best-effort: an unreachable backend just yields no URL match.
   */
  async function currentPageUrl(pageId) {
    if (!pageId) return undefined
    try {
      const { api } = await resolveBackend(undefined)
      return await api.currentUrl(pageId)
    } catch { return undefined }
  }

  /**
   * Capture the verified trajectory for a runbook. The extension backend does not record actions
   * yet, so it saves the site and instructions descriptively instead of failing the request.
   */
  async function trajectoryFor(pageId) {
    const { kind, api } = await resolveBackend(undefined)
    if (kind === 'playwright') return browser.trajectory(pageId)
    const url = new URL(assertWebUrl(await api.currentUrl(pageId)))
    return { origin: url.origin, path: url.pathname, steps: [] }
  }

  register('browser_runbook_list', 'Rank enabled operation manuals for a task and site. Provide pageId to match the current tab without repeating its URL.', {
    pageId: optionalText, url: optionalText, task: optionalText,
  }, async args => runbooks.list({ url: args.pageId ? await currentPageUrl(args.pageId) : args.url, task: args.task }))
  register('browser_runbook_get', 'Load one enabled operation manual by id. Current page semantics must still be checked before every action.', {
    id: text,
  }, args => runbooks.get(args.id))
  register('browser_runbook_save', 'Create or revise a disabled site operation-manual draft with descriptive instructions and an optional current verified trajectory. Set previousId to preserve omitted fields. The Chrome extension does not record a trajectory yet, so a pageId there saves the site URL and instructions without steps. Call only after the user explicitly asks to save or update the procedure. Never include credentials or submitted values.', {
    pageId: optionalText, url: optionalText, name: optionalText, task: optionalText, instructions: optionalText, previousId: optionalText,
    inputs: { type: 'array', items: { type: 'string' } }, preconditions: { type: 'array', items: { type: 'string' } }, successCriteria: optionalText,
    userRequested: { type: 'boolean', required: true },
  }, async args => {
    if (args.userRequested !== true) throw new Error('An explicit user request is required to save a runbook.')
    if (args.pageId) return runbooks.save(args, await trajectoryFor(args.pageId))
    if (args.url) {
      const url = new URL(assertWebUrl(args.url))
      return runbooks.save(args, { origin: url.origin, path: url.pathname, steps: [] })
    }
    if (args.previousId) return runbooks.save(args)
    throw new Error('Provide pageId for the current trajectory, url for a descriptive-only runbook, or previousId to revise an existing runbook.')
  })
  register('browser_runbook_report', 'Record whether an enabled operation manual succeeded so future matching can prefer reliable guidance.', {
    id: text, succeeded: { type: 'boolean', required: true }, reason: optionalText,
  }, args => runbooks.report(args.id, args.succeeded, args.reason))

  // Start the bridge after every local binding exists, so an enabled bridge cannot observe a
  // half-initialised plugin.
  void startBridge()
}

/** Best-effort external bridge URL derived from the host web server binding. */
function deriveBridgeUrl(webCtx, path) {
  try {
    const port = webCtx.webServer.port
    const host = webCtx.webServer.host === '0.0.0.0' ? '127.0.0.1' : webCtx.webServer.host
    return `ws://${host}:${port}${path}`
  } catch {
    return path
  }
}

function assertWebUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
  return url.href
}
