/**
 * DSH Chrome Bridge service worker.
 *
 * Responsibilities:
 *  1. Establish an authenticated session with the remote bridge (pairing token -> session cookie).
 *  2. Hold the WebSocket to the bridge, answer its challenge, and reconnect with backoff.
 *  3. Route bridge requests to the Chrome APIs and to the page agent in the selected tab.
 *
 * Security posture:
 *  - The pairing token lives in `chrome.storage.session` (memory only, cleared when Chrome exits).
 *  - Requests only ever address one tab: an explicit tab id, or the user's current active tab.
 *  - Only the operation list in `handleRequest` is reachable. The server cannot ask this extension
 *    to evaluate a JavaScript string, read arbitrary storage, or touch another tab implicitly.
 */

const CHANNEL = 'dsh-chrome-bridge'
const PROTOCOL = 1
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000
const KEEPALIVE_MS = 20000
const PING_TIMEOUT_MS = 8000

const state = {
  socket: undefined,
  status: 'disconnected',
  detail: 'Not connected.',
  bridgeUrl: '',
  peerId: '',
  connectedAt: 0,
  attempts: 0,
  reconnectTimer: undefined,
  connectPromise: undefined,
  keepaliveTimer: undefined,
  pingTimer: undefined,
  pending: new Map(),
  /**
   * Reference -> owning tab id. The server-side backend also tracks this, but the extension must
   * enforce it too: it is the component that actually chooses which tab receives a page action, so
   * it cannot rely on the caller having done the check.
   */
  refs: new Map(),
  authenticated: false,
  lastNonce: '',
  lastError: '',
}

const now = () => Date.now()
const log = (...args) => console.log('[dsh-bridge]', ...args)

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

async function readSettings() {
  const stored = await chrome.storage.local.get({ bridgeUrl: '', autoConnect: true, label: '' })
  return { bridgeUrl: String(stored.bridgeUrl || '').trim(), autoConnect: stored.autoConnect !== false, label: String(stored.label || '').slice(0, 80) }
}

async function readToken() {
  try {
    const stored = await chrome.storage.session.get({ pairingToken: '' })
    return String(stored.pairingToken || '')
  } catch {
    // Chrome below 102 has no storage.session; fall back to a local value rather than failing.
    const stored = await chrome.storage.local.get({ pairingToken: '' })
    return String(stored.pairingToken || '')
  }
}

async function writeToken(token) {
  const value = String(token || '').trim()
  try { await chrome.storage.session.set({ pairingToken: value }) } catch { await chrome.storage.local.set({ pairingToken: value }) }
  return value
}

/** Normalise a user-entered bridge URL into a concrete WebSocket URL plus its origin. */
export function normalizeBridgeUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('Enter the bridge URL shown by the DSH server.')
  const url = new URL(raw.includes('://') ? raw : `wss://${raw}`)
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('The bridge URL must use ws:// or wss://.')
  if (url.username || url.password) throw new Error('The bridge URL must not contain credentials.')
  return { websocketUrl: url.href, origin: url.origin, secure: url.protocol === 'wss:', path: url.pathname }
}

/**
 * Minimal-permission model
 * ------------------------
 * The extension declares no broad `content_scripts` and no all-URL host permissions. It reaches a
 * page only through `activeTab` (granted when the user opens the popup and connects) or through
 * host access the user explicitly grants in the popup. Pages the extension has not been granted
 * access to produce an explicit PERMISSION_DENIED error instead of a silent partial action.
 */
/**
 * Chrome accepts only http(s) origins in a permission pattern, while the bridge is addressed as
 * ws(s). The session exchange is an ordinary HTTPS request to the same host, so the scheme is
 * translated here. The WebSocket itself needs no host permission.
 */
export function permissionOriginOf(origin) {
  return String(origin).replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
}

async function ensureHostPermission(origin) {
  const pattern = `${permissionOriginOf(origin)}/*`
  if (await chrome.permissions.contains({ origins: [pattern] })) return true
  return false
}

// ---------------------------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------------------------

const TAB_ID_PATTERN = /^tab-(\d+)$/

/**
 * Resolve a bridge `pageId` to a Chrome tab.
 * `active`, `current` and an empty value all mean "the tab the user is looking at right now",
 * which is the only implicit target the extension ever accepts.
 */
async function resolveTab(pageId) {
  if (pageId === undefined || pageId === null || pageId === '' || pageId === 'active' || pageId === 'current') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab) throw new TabError('TAB_NOT_FOUND', 'No active tab is available.')
    return tab
  }
  const match = TAB_ID_PATTERN.exec(String(pageId))
  if (!match) throw new TabError('INVALID_PARAMS', `Unknown page id "${String(pageId).slice(0, 40)}". Use "active" or a tab id from browser_tabs.`)
  const tabId = Number(match[1])
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab) throw new TabError('TAB_NOT_FOUND', 'The requested tab no longer exists.')
    return tab
  } catch (error) {
    if (error instanceof TabError) throw error
    throw new TabError('TAB_NOT_FOUND', 'The requested tab no longer exists.')
  }
}

export class TabError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TabError'
    this.code = code
  }
}

function isRestrictedUrl(url) {
  return !/^https?:\/\//i.test(String(url || ''))
}

/** Ask the page agent in a tab, injecting the content script on demand. */
async function pageRequest(tab, method, params = {}, attempt = 0) {
  if (isRestrictedUrl(tab.url)) {
    throw new TabError('PAGE_UNSUPPORTED', `The tab cannot be operated because its URL is not an HTTP(S) page (${String(tab.url || '').slice(0, 60)}).`)
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { channel: CHANNEL, method, params })
  } catch (error) {
    // The content script is absent after installation or a Chrome-side reload. Inject and retry once.
    if (attempt === 0) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files: ['content.js'] })
      } catch (injectionError) {
        throw new TabError('PERMISSION_DENIED', `The extension cannot operate this tab: ${String(injectionError?.message || injectionError).slice(0, 200)}`)
      }
      return pageRequest(tab, method, params, 1)
    }
    throw new TabError('TAB_UNAVAILABLE', `The page agent did not answer in this tab: ${String(error?.message || error).slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------------------------

function requireRecord(params) {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) throw new TabError('INVALID_PARAMS', 'Request params must be an object.')
  return params
}

export async function handleRequest(method, rawParams) {
  const params = requireRecord(rawParams)
  switch (method) {
    case 'bridge.ping':
      return { pong: true, at: now() }
    case 'bridge.status':
      return statusSnapshot()
    case 'browser.tabs':
      return tabs(params)
    case 'browser.open':
      return openUrl(params)
    case 'browser.snapshot':
      return snapshot(params)
    case 'browser.act':
      return act(params)
    case 'browser.wait':
      return waitFor(params)
    default:
      throw new TabError('INVALID_PARAMS', `Unsupported bridge method: ${String(method)}`)
  }
}

export function statusSnapshot() {
  return {
    status: state.status,
    detail: state.detail,
    bridgeUrl: state.bridgeUrl,
    peerId: state.peerId,
    connectedAt: state.connectedAt || undefined,
    pending: state.pending.size,
    trackedRefs: state.refs.size,
    lastError: state.lastError || undefined,
    protocol: PROTOCOL,
  }
}

async function tabs(params) {
  const action = params.action === undefined ? 'list' : params.action
  if (action === 'new') {
    const tab = await chrome.tabs.create({ url: 'about:blank' })
    return { pages: await listTabs(), created: `tab-${tab.id}` }
  }
  if (action === 'close') {
    const tab = await resolveTab(params.pageId)
    await chrome.tabs.remove(tab.id)
    return { pages: await listTabs(), closed: `tab-${tab.id}` }
  }
  if (action !== 'list') throw new TabError('INVALID_PARAMS', `Unsupported tabs action: ${String(action)}`)
  return { pages: await listTabs() }
}

async function listTabs() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true })
  return tabs
    .filter(tab => !isRestrictedUrl(tab.url))
    .map(tab => ({
      id: `tab-${tab.id}`,
      url: safeUrl(tab.url),
      title: String(tab.title || '').slice(0, 300),
      active: active ? tab.id === active.id : false,
    }))
}

function safeUrl(value) {
  try {
    const url = new URL(String(value))
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol
  } catch { return '' }
}

async function openUrl(params) {
  const url = new URL(String(params.url || ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TabError('INVALID_PARAMS', 'Use an HTTP(S) URL without embedded credentials.')
  }
  const tab = await resolveTab(params.pageId)
  await chrome.tabs.update(tab.id, { url: url.href })
  const updated = await chrome.tabs.get(tab.id)
  return { pageId: `tab-${updated.id}`, url: safeUrl(updated.url), title: String(updated.title || '').slice(0, 300) }
}

async function snapshot(params) {
  const tab = await resolveTab(params.pageId)
  const response = await pageRequest(tab, 'page.snapshot', {
    mode: params.mode === 'form' ? 'form' : 'interactive',
    limit: params.limit,
    includeCandidates: Boolean(params.includeCandidates),
    tabId: tab.id,
  })
  if (!response?.ok) throw new TabError(response?.error?.code ?? 'INTERNAL', response?.error?.message ?? 'The page snapshot failed.')
  const result = response.result
  for (const element of result.elements ?? []) {
    if (element?.ref) state.refs.set(element.ref, tab.id)
  }
  // Bound the map so a long session cannot grow it without limit.
  while (state.refs.size > 500) state.refs.delete(state.refs.keys().next().value)
  const [fresh] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return {
    ...result,
    snapshotId: `cs-${Math.random().toString(36).slice(2, 10)}`,
    pageId: `tab-${tab.id}`,
    tabId: tab.id,
    title: result.title || String(tab.title || '').slice(0, 300),
    url: safeUrl(result.url || tab.url),
    isActiveTab: fresh ? fresh.id === tab.id : false,
    frames: [],
  }
}

async function act(params) {
  const actions = ['click', 'fill', 'select', 'press']
  // Validate at this boundary so an unsupported action is refused before any page is touched.
  if (!actions.includes(params.action)) throw new TabError('INVALID_PARAMS', `Unsupported page action: ${String(params.action)}`)
  if (params.action !== 'click' && typeof params.value !== 'string') throw new TabError('INVALID_PARAMS', `The ${params.action} action requires a value.`)
  if (typeof params.ref !== 'string' || params.ref.length === 0) throw new TabError('INVALID_PARAMS', 'A snapshot ref is required.')
  const ownerTabId = state.refs.get(params.ref)
  if (ownerTabId === undefined) {
    throw new TabError('ELEMENT_NOT_FOUND', 'That snapshot reference is not known to this extension. Take a new snapshot before acting.')
  }
  const tab = await resolveTab(params.pageId)
  // A reference belongs to the tab it was observed in; refusing a mismatch stops an action from
  // landing in whichever tab happens to be active now.
  if (ownerTabId !== tab.id) {
    throw new TabError('ELEMENT_STALE', `That reference was observed in tab ${ownerTabId}, not tab ${tab.id}. Take a snapshot from the intended tab.`)
  }
  const response = await pageRequest(tab, 'page.act', {
    ref: params.ref,
    action: params.action,
    value: params.value,
    tabId: tab.id,
  })
  if (!response?.ok) throw new TabError(response?.error?.code ?? 'INTERNAL', response?.error?.message ?? 'The page action failed.')
  const after = await chrome.tabs.get(tab.id).catch(() => tab)
  return { ...response.result, pageId: `tab-${tab.id}`, url: safeUrl(response.result?.url || after.url), title: response.result?.title ?? String(after.title || '').slice(0, 300) }
}

async function waitFor(params) {
  const tab = await resolveTab(params.pageId)
  const response = await pageRequest(tab, 'page.wait', {
    text: params.text,
    url: params.url,
    timeoutMs: params.timeoutMs,
  })
  if (!response?.ok) throw new TabError(response?.error?.code ?? 'INTERNAL', response?.error?.message ?? 'The page wait failed.')
  const after = await chrome.tabs.get(tab.id).catch(() => tab)
  return { ...response.result, pageId: `tab-${tab.id}`, url: safeUrl(response.result?.url || after.url), title: response.result?.title ?? String(after.title || '').slice(0, 300) }
}

// ---------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------

function setStatus(status, detail) {
  state.status = status
  state.detail = detail
  if (status === 'error') state.lastError = detail
  chrome.action.setBadgeText({ text: status === 'connected' ? 'ON' : status === 'connecting' ? '…' : '' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: status === 'connected' ? '#1f7a3f' : '#8a6d1f' }).catch(() => {})
  broadcastStatus()
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ channel: CHANNEL, event: 'status', status: statusSnapshot() }).catch(() => {})
}

/**
 * Exchange the pairing token for a session cookie.
 * The cookie is HttpOnly and path-scoped, so it is stored by Chrome itself and is never exposed
 * to this worker; it is presented automatically on the WebSocket upgrade.
 */
async function establishSession(bridgeUrl, token) {
  const { origin, path, secure } = normalizeBridgeUrl(bridgeUrl)
  const isLoopback = /^(?:https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)
  // Transport security is checked before host access so the message explains the real problem.
  if (!secure && !isLoopback) {
    throw new Error('Refusing a non-TLS bridge address that is not loopback. Use wss:// for a remote host.')
  }
  if (!(await ensureHostPermission(origin))) {
    throw new Error(`Access to ${origin} has not been granted. Open this popup and press "Grant access".`)
  }
  // fetch() only speaks HTTP(S), so the WebSocket origin is translated for this one call.
  const httpOrigin = origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
  const endpoint = new URL(`${path.replace(/\/$/, '')}/session`, httpOrigin)
  const response = await fetch(endpoint.href, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (response.status === 401) throw new Error('The pairing token was rejected. Generate a new token on the DSH server.')
  if (!response.ok) throw new Error(`The bridge session request failed with HTTP ${response.status}.`)
  const body = await response.json().catch(() => ({}))
  if (!body?.ok) throw new Error(String(body?.error?.message || 'The bridge refused to create a session.'))
  return body.value
}

export async function connect({ manual = false } = {}) {
  // Concurrent callers (startup, an alarm, and the popup) must share one attempt, otherwise two
  // sockets race and the bridge replaces one of them immediately.
  if (state.connectPromise) return state.connectPromise
  const attempt = connectOnce({ manual }).finally(() => {
    if (state.connectPromise === attempt) state.connectPromise = undefined
  })
  state.connectPromise = attempt
  return attempt
}

async function connectOnce({ manual = false } = {}) {
  const settings = await readSettings()
  if (!settings.bridgeUrl) {
    setStatus('disconnected', 'No bridge URL configured.')
    return statusSnapshot()
  }
  if (state.status === 'connected' && state.socket) return statusSnapshot()
  clearTimeout(state.reconnectTimer)
  if (state.socket) { try { state.socket.close() } catch { /* already closing */ } state.socket = undefined }
  setStatus('connecting', `Connecting to ${settings.bridgeUrl}…`)
  const token = await readToken()
  if (!token) {
    setStatus('disconnected', 'No pairing token stored. Paste one in this popup.')
    return statusSnapshot()
  }
  try {
    await establishSession(settings.bridgeUrl, token)
    const { websocketUrl } = normalizeBridgeUrl(settings.bridgeUrl)
    const socket = new WebSocket(websocketUrl)
    state.socket = socket
    socket.addEventListener('open', () => { state.attempts = 0; log('socket open') })
    socket.addEventListener('message', event => { void onSocketMessage(event.data) })
    socket.addEventListener('close', event => { void onSocketClose(event) })
    socket.addEventListener('error', () => { log('socket error') })
    state.detail = 'Authenticating with the bridge…'
  } catch (error) {
    state.socket = undefined
    setStatus('error', String(error?.message || error))
    scheduleReconnect()
  }
  return statusSnapshot()
}

async function onSocketMessage(raw) {
  let message
  try { message = JSON.parse(raw) } catch { return }
  if (!message || typeof message !== 'object') return
  if (message.type === 'challenge') {
    state.lastNonce = String(message.nonce || '')
    const token = await readToken()
    const settings = await readSettings()
    sendFrame({ type: 'hello', nonce: state.lastNonce, token, label: settings.label || undefined, extensionVersion: chrome.runtime.getManifest().version })
    return
  }
  if (message.type === 'ready') {
    state.authenticated = true
    state.peerId = String(message.peerId || '')
    state.connectedAt = now()
    setStatus('connected', 'Connected to the DSH bridge.')
    startKeepalive()
    log('authenticated as', state.peerId)
    return
  }
  if (message.type === 'request') {
    void dispatchRequest(message)
    return
  }
  if (message.type === 'cancel') {
    state.pending.get(String(message.requestId))?.cancel(new TabError('TIMEOUT', 'The bridge cancelled this request.'))
  }
}

function sendFrame(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return false
  state.socket.send(JSON.stringify(message))
  return true
}

async function dispatchRequest(message) {
  const requestId = String(message.requestId || '')
  if (!requestId) return
  // The bridge only authenticates this socket once it answers the challenge with `ready`.
  // Anything received before that is refused rather than executed.
  if (!state.authenticated) {
    sendFrame({ type: 'response', requestId, ok: false, error: { code: 'BRIDGE_UNAUTHENTICATED', message: 'The bridge connection is not authenticated yet.' } })
    return
  }
  // Bound concurrent page work so a runaway caller cannot spin up unbounded DOM operations.
  if (state.pending.size >= 32) {
    sendFrame({ type: 'response', requestId, ok: false, error: { code: 'INTERNAL', message: 'Too many outstanding bridge requests.' } })
    return
  }
  let cancelled = false
  let rejectCancelled
  const cancellation = new Promise((_, reject) => { rejectCancelled = reject })
  state.pending.set(requestId, { cancel: reason => { cancelled = true; rejectCancelled(reason) } })
  try {
    // Race the actual work against a cancellation signal so a late cancel never lands mid-action.
    const result = await Promise.race([handleRequest(String(message.method || ''), message.params), cancellation])
    if (cancelled) return
    sendFrame({ type: 'response', requestId, ok: true, result: normalizeResult(result) })
  } catch (error) {
    if (cancelled && error instanceof TabError && error.code === 'TIMEOUT') return
    sendFrame({ type: 'response', requestId, ok: false, error: { code: error?.code ?? 'INTERNAL', message: String(error?.message || error).slice(0, 500) } })
  } finally {
    state.pending.delete(requestId)
  }
}

/** Strip undefined values so `JSON.stringify` never produces a partial object. */
function normalizeResult(value) {
  if (Array.isArray(value)) return value.map(normalizeResult)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = normalizeResult(item)
    return normalized === undefined ? [] : [[key, normalized]]
  }))
}

function startKeepalive() {
  stopKeepalive()
  // An active WebSocket keeps the MV3 worker alive; the ping proves the far end is still there.
  state.keepaliveTimer = setInterval(() => {
    if (!sendFrame({ type: 'event', event: 'heartbeat', data: { at: now() } })) return
    clearTimeout(state.pingTimer)
    state.pingTimer = setTimeout(() => { log('bridge did not answer the heartbeat'); state.socket?.close() }, PING_TIMEOUT_MS)
    state.pingTimer.unref?.()
  }, KEEPALIVE_MS)
  state.keepaliveTimer.unref?.()
}

function stopKeepalive() {
  clearInterval(state.keepaliveTimer)
  clearTimeout(state.pingTimer)
  state.keepaliveTimer = undefined
  state.pingTimer = undefined
}

async function onSocketClose(event) {
  stopKeepalive()
  state.socket = undefined
  state.authenticated = false
  const reason = String(event?.reason || '').slice(0, 120)
  const code = Number(event?.code || 1006)
  // Anything the server was still waiting on can never complete now, so fail it immediately
  // instead of leaving the caller to wait out its own timeout.
  for (const [, pending] of state.pending) pending.cancel(new TabError('BRIDGE_OFFLINE', 'The bridge connection closed before the request completed.'))
  state.pending.clear()
  state.refs.clear()
  // A protocol-level close code from the server is a terminal condition, not a network blip.
  if (['BRIDGE_UNAUTHORIZED', 'BRIDGE_UNAUTHENTICATED'].includes(reason)) {
    setStatus('error', `The bridge rejected this connection: ${reason}`)
    return
  }
  setStatus('disconnected', code === 1000 ? `Disconnected${reason ? `: ${reason}` : '.'}` : `The bridge connection dropped (code ${code}). Reconnecting…`)
  const settings = await readSettings()
  if (settings.autoConnect) scheduleReconnect()
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer)
  state.attempts += 1
  const delay = Math.min(RECONNECT_MIN_MS * 2 ** Math.min(state.attempts, 5), RECONNECT_MAX_MS)
  state.reconnectTimer = setTimeout(() => { void connect() }, delay)
  // A pending retry must never keep a Node test process alive; in Chrome the worker is suspended.
  state.reconnectTimer.unref?.()
}

export async function disconnect({ reason = 'Disconnected by the user.' } = {}) {
  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = undefined
  stopKeepalive()
  state.attempts = 0
  const socket = state.socket
  state.socket = undefined
  if (socket) {
    try { socket.close(1000, reason.slice(0, 120)) } catch { /* already closed */ }
  }
  await chrome.storage.local.set({ autoConnect: false })
  setStatus('disconnected', reason)
  return statusSnapshot()
}

// ---------------------------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== CHANNEL) return false
  // A page agent asks which tab it belongs to, so it can refuse requests aimed at another tab.
  if (message.method === 'whoami') {
    sendResponse({ ok: true, tabId: sender?.tab?.id, frameId: sender?.frameId ?? 0 })
    return false
  }
  if (message.command === undefined) return false
  const respond = async () => {
    try {
      if (message.command === 'status') return { ok: true, status: statusSnapshot() }
      if (message.command === 'connect') {
        await chrome.storage.local.set({ autoConnect: true })
        return { ok: true, status: await connect({ manual: true }) }
      }
      if (message.command === 'disconnect') return { ok: true, status: await disconnect() }
      if (message.command === 'save') {
        const bridgeUrl = String(message.bridgeUrl || '').trim()
        normalizeBridgeUrl(bridgeUrl)
        await chrome.storage.local.set({ bridgeUrl, label: String(message.label || '').slice(0, 80) })
        if (message.token) await writeToken(message.token)
        return { ok: true, status: statusSnapshot() }
      }
      if (message.command === 'test') {
        const token = await readToken()
        if (!token) return { ok: false, error: 'No pairing token stored.' }
        await establishSession(String(message.bridgeUrl || ''), token)
        return { ok: true, status: statusSnapshot() }
      }
      return { ok: false, error: `Unsupported command: ${String(message.command)}` }
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 400) }
    }
  }
  respond().then(sendResponse)
  return true
})

chrome.runtime.onInstalled.addListener(() => { void connect() })
chrome.runtime.onStartup.addListener(() => { void connect() })
// A periodic wake-up re-establishes the link after Chrome suspends the worker.
chrome.alarms?.create('dsh-bridge-keepalive', { periodInMinutes: 1 })
chrome.alarms?.onAlarm.addListener(() => {
  void (async () => {
    const settings = await readSettings()
    if (settings.autoConnect && state.status !== 'connected') await connect()
  })()
})
void connect()
