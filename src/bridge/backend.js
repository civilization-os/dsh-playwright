/**
 * Chrome Extension backend for the browser tools.
 *
 * This class presents the same surface as `BrowserManager` (tabs / open / snapshot / act / wait /
 * currentUrl / status) so the tool layer in `src/index.js` does not care which backend is active.
 * All page work happens inside the user's own Chrome; this side only routes requests and turns
 * remote failures into errors with stable, actionable messages.
 *
 * Page identity
 * -------------
 * A tab is addressed as `tab-<chromeTabId>`. The literal values `active` and `current` mean "the
 * tab the user is looking at right now", which is the only implicit target the extension accepts.
 * A snapshot ref may also be passed as the page id; the backend then routes to the tab that owns
 * the reference, so an action cannot silently land in a different tab after the user switches.
 */
import { BridgeError } from './hub.js'

const TAB_ID_PATTERN = /^tab-(\d+)$/
/** Shape of a page-agent reference. Used to tell a forgotten ref from a mistyped page id. */
const REFERENCE_PATTERN = /^c-[a-z0-9]+$/
const ACTIVE_ALIASES = new Set(['active', 'current'])

export function isReferenceId(value) {
  return REFERENCE_PATTERN.test(String(value ?? ''))
}
const TAB_CACHE_MS = 1000
/**
 * A successful liveness probe is trusted for this long, so a burst of tool calls in one task pays
 * for one round trip instead of one per call. A failed probe is never cached.
 */
export const HEALTH_TTL_MS = 5000
/** The probe must fail fast: a tool call should not wait for the full request timeout to learn the
 *  extension is gone. */
export const MAX_HEALTH_TIMEOUT_MS = 5000

/** Remote error codes that mean the reference itself is no longer usable. */
const STALE_CODES = new Set(['ELEMENT_STALE', 'ELEMENT_NOT_FOUND'])

export class ChromeBridgeBackend {
  constructor(hub, options = {}) {
    this.hub = hub
    this.settings = options.settings
    this.timeoutMs = options.timeoutMs ?? 30000
    this.hub.subscribe(event => {
      // A peer change invalidates every cached tab list, every remembered reference, and any
      // liveness probe that was measured against the previous peer.
      if (event.type === 'peer-closed' || event.type === 'peer-authenticated' || event.type === 'peer-connected') {
        this.tabCache = undefined
        this.healthCache = undefined
      }
    })
    this.tabCache = undefined
    this.healthCache = undefined
    this.refs = new Map()
  }

  async configuredTimeout() {
    try {
      const configured = await this.settings?.read?.()
      if (configured?.timeoutMs) return configured.timeoutMs
    } catch { /* fall back to the constructor default */ }
    return this.timeoutMs
  }

  /** Bridge connectivity, surfaced in the settings UI. */
  bridgeStatus() {
    return this.hub.status()
  }

  /** Authenticated peers currently attached, read from the hub without touching the network. */
  connectionState() {
    const status = this.hub.status()
    const peers = (status.peers ?? []).filter(peer => peer.authenticated && !peer.closed)
    return { listening: Boolean(status.listening), peers }
  }

  /**
   * Health of the extension connection, before and after tool work.
   *
   * Presence is cheap (hub state); liveness is proven with a real `bridge.ping` round trip, because
   * a socket that was never closed looks connected long after Chrome stopped answering. The result
   * is reported rather than thrown so `browser_bridge_status` and the settings UI can show it.
   */
  async health({ timeoutMs, force = false } = {}) {
    const { listening, peers } = this.connectionState()
    const summary = peers.map(peer => ({ id: peer.id, label: peer.label, extensionVersion: peer.extensionVersion, connectedAt: peer.connectedAt }))
    if (!listening) return { healthy: false, code: 'BRIDGE_OFFLINE', message: 'The Chrome Bridge listener is not running.', listening, peers: summary }
    if (peers.length === 0) return { healthy: false, code: 'BRIDGE_OFFLINE', message: 'No Chrome extension is connected to the bridge.', listening, peers: summary }
    if (peers.length > 1) return { healthy: false, code: 'BRIDGE_AMBIGUOUS', message: 'More than one Chrome extension is connected. Specify peerId.', listening, peers: summary }
    // The peer id is part of the cache key, so a reconnect is never covered by an older probe.
    if (!force && this.healthCache?.peerId === peers[0].id && Date.now() - this.healthCache.at < HEALTH_TTL_MS) {
      return { ...this.healthCache.value, cached: true }
    }
    const probeTimeoutMs = timeoutMs ?? Math.min(await this.configuredTimeout(), MAX_HEALTH_TIMEOUT_MS)
    const startedAt = Date.now()
    try {
      // The hub is called directly so a BridgeError keeps its code for the report.
      await this.hub.request('bridge.ping', {}, { timeoutMs: probeTimeoutMs })
    } catch (error) {
      this.healthCache = undefined
      return {
        healthy: false,
        code: error instanceof BridgeError ? error.code : 'BRIDGE_OFFLINE',
        message: error instanceof BridgeError ? error.message : String(error?.message ?? error),
        listening,
        peers: summary,
      }
    }
    const value = { healthy: true, listening, peers: summary, latencyMs: Date.now() - startedAt, checkedAt: Date.now() }
    this.healthCache = { at: Date.now(), peerId: peers[0].id, value }
    return value
  }

  /**
   * Verify the extension connection before a tool call and throw an actionable error when it is
   * missing, ambiguous, or unresponsive. Callers must never fall back to another backend: a missing
   * extension is a user-visible condition, not a reason to start an isolated browser.
   */
  async ensureHealthy(options = {}) {
    const report = await this.health(options)
    if (!report.healthy) throw new BridgeError(report.code, report.message)
    return report
  }

  async request(method, params = {}, requestOptions = {}) {
    const timeoutMs = requestOptions.timeoutMs ?? await this.configuredTimeout()
    try {
      return await this.hub.request(method, params, { ...requestOptions, timeoutMs })
    } catch (error) {
      throw toError(error)
    }
  }

  /** Mirrors BrowserManager.status() closely enough for the shared settings UI. */
  async status() {
    const bridge = this.hub.status()
    const peers = bridge.peers.filter(peer => peer.authenticated)
    let pages = []
    let pageError
    if (peers.length > 0) {
      try { pages = (await this.tabs('list')).pages } catch (error) { pageError = String(error?.message || error) }
    }
    return {
      backend: 'chrome-extension',
      bridge,
      launch: peers.length === 0 ? 'bridge-disconnected' : pageError ? 'bridge-error' : 'connected',
      activePages: pages.length,
      pages,
      peers: peers.map(peer => ({ id: peer.id, label: peer.label, extensionVersion: peer.extensionVersion, connectedAt: peer.connectedAt })),
      pageError,
    }
  }

  /** List the tabs the extension is willing to expose. */
  async tabs(action = 'list', pageId) {
    if (action === 'new' || action === 'close') {
      const result = await this.request('browser.tabs', { action, pageId: pageId ? this.normalizePageId(pageId) : undefined })
      this.tabCache = undefined
      return result
    }
    if (this.tabCache && Date.now() - this.tabCache.at < TAB_CACHE_MS) return this.tabCache.value
    const value = await this.request('browser.tabs', { action: 'list' })
    this.tabCache = { at: Date.now(), value }
    return value
  }

  /** Resolve the tool-facing pageId to the identifier the extension expects. */
  normalizePageId(pageId, { forRef = false } = {}) {
    // `active`/`current` are deliberate user-facing choices, so they are always allowed.
    if (ACTIVE_ALIASES.has(pageId)) return 'active'
    if (pageId === undefined || pageId === null || pageId === '') {
      // An action must name the tab it was observed in; falling back to the active tab would send
      // the action to whichever page the user happens to be looking at.
      if (forRef) throw new Error('A pageId is required when acting. Take a snapshot and pass the tab it came from.')
      return 'active'
    }
    if (TAB_ID_PATTERN.test(String(pageId))) return String(pageId)
    // A snapshot ref carries the tab it came from, so an action follows the original tab.
    const entry = this.refs.get(String(pageId))
    if (entry?.tabId !== undefined) return `tab-${entry.tabId}`
    if (forRef || isReferenceId(pageId)) {
      throw new Error(`The reference ${String(pageId).slice(0, 40)} is no longer valid for this backend. Take a new snapshot before acting.`)
    }
    throw new Error(`Unknown page id "${String(pageId).slice(0, 40)}". Use "active" or a pageId from browser_tabs.`)
  }

  async open(pageId, url) {
    const result = await this.request('browser.open', { pageId: this.normalizePageId(pageId), url })
    this.tabCache = undefined
    return result
  }

  async snapshot(pageId, limit = 80, _frameId, _scopeCss, includeCandidates = false, mode = 'interactive') {
    if (!['interactive', 'form'].includes(mode)) throw new Error('Snapshot mode must be interactive or form.')
    if (_frameId) throw new Error('The Chrome extension backend does not support iframe snapshots yet. Run the action in the top-level page or use the Playwright backend.')
    if (_scopeCss) throw new Error('The Chrome extension backend does not support scopeCss yet. Narrow the request by using a smaller limit or the Playwright backend.')
    const result = await this.request('browser.snapshot', {
      pageId: this.normalizePageId(pageId),
      limit: Math.min(Math.max(Number(limit) || 80, 1), 200),
      includeCandidates: Boolean(includeCandidates),
      mode,
    })
    // Remember which tab each ref belongs to so a later action routes to the same tab.
    for (const element of result.elements ?? []) {
      if (element?.ref) this.refs.set(element.ref, { tabId: result.tabId, createdAt: Date.now() })
    }
    this.pruneRefs()
    return result
  }

  async act(pageId, ref, action, value, _expectedText, _expectedUrl) {
    if (!['click', 'fill', 'select', 'press'].includes(action)) throw new Error('Unsupported browser action.')
    if (['fill', 'select', 'press'].includes(action) && typeof value !== 'string') throw new Error(`browser_act ${action} requires value.`)
    const result = await this.request('browser.act', {
      pageId: this.normalizePageId(pageId, { forRef: true }),
      ref,
      action,
      value,
    })
    // Any completed action may have changed the document, so refs must be re-observed.
    this.refs.clear()
    this.tabCache = undefined
    return result
  }

  async wait(pageId, text, url, _frameId, _networkIdle, _networkUrl) {
    if (!text && !url) throw new Error('The Chrome extension backend supports waiting for text or url. Network waiting requires the Playwright backend.')
    return this.request('browser.wait', {
      pageId: this.normalizePageId(pageId),
      text,
      url,
      timeoutMs: await this.configuredTimeout(),
    })
  }

  async currentUrl(pageId) {
    const result = await this.request('bridge.status').then(() => this.tabs('list')).catch(() => undefined)
    const wanted = this.normalizePageId(pageId)
    const pages = result?.pages ?? []
    const found = wanted === 'active' ? pages.find(page => page.active) : pages.find(page => page.id === wanted)
    if (!found) throw new Error('The requested tab is not available.')
    return found.url
  }

  /** Drop reference bookkeeping for tabs that no longer exist or entries past the TTL. */
  pruneRefs() {
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [ref, entry] of this.refs) if (entry.createdAt < cutoff) this.refs.delete(ref)
    while (this.refs.size > 500) this.refs.delete(this.refs.keys().next().value)
  }

  async dispose() {
    this.refs.clear()
    this.tabCache = undefined
    this.healthCache = undefined
  }
}

/** Turn a hub-level BridgeError into a message a model can act on. */
export function toError(error) {
  if (!(error instanceof BridgeError)) return error instanceof Error ? error : new Error(String(error))
  const hints = {
    BRIDGE_OFFLINE: 'Ask the user to open the DSH Chrome Bridge extension popup and connect it to the server; browser_bridge_status reports the current state.',
    BRIDGE_TIMEOUT: 'The Chrome extension did not answer in time. If the page was idle, take a new snapshot; if every call stalls, call browser_bridge_status and ask the user to reconnect the extension.',
    BRIDGE_UNAUTHORIZED: 'The extension is not authenticated. Reconnect it with a fresh pairing token.',
    BRIDGE_METHOD_NOT_ALLOWED: 'The bridge does not expose this operation.',
    BRIDGE_AMBIGUOUS: 'More than one Chrome extension is connected; call browser_bridge_status and ask the user to disconnect the extra one.',
    BRIDGE_BUSY: 'The Chrome extension is busy with too many requests.',
    BRIDGE_ABORTED: 'The operation was cancelled.',
  }
  const hint = hints[error.code]
  return new Error(`[${error.code}] ${error.message}${hint ? ` ${hint}` : ''}`)
}

/** True when the error refers to a reference the agent should re-observe. */
export function isStaleReferenceError(error) {
  const text = String(error?.message ?? '')
  for (const code of STALE_CODES) if (text.includes(`[${code}]`)) return true
  return false
}
