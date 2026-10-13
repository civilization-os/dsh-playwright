/**
 * Popup controller. Everything that needs a user gesture (host permission, connect) happens here;
 * the service worker only performs operations the user has already authorised.
 */
const CHANNEL = 'dsh-chrome-bridge'

const $ = id => document.getElementById(id)
const elements = {
  dot: $('dot'), status: $('status'), form: $('form'), url: $('url'), token: $('token'), label: $('label'),
  grant: $('grant'), save: $('save'), connect: $('connect'), disconnect: $('disconnect'),
  error: $('error'), tabInfo: $('tabInfo'), peerInfo: $('peerInfo'), urlHint: $('urlHint'),
}

function send(command, payload = {}) {
  return chrome.runtime.sendMessage({ channel: CHANNEL, command, ...payload })
}

function showError(message) {
  elements.error.textContent = message || ''
  elements.error.hidden = !message
}

function render(status) {
  const value = status ?? {}
  const state = value.status ?? 'disconnected'
  elements.dot.dataset.state = state
  elements.status.textContent = value.detail || state
  elements.peerInfo.textContent = value.peerId || '–'
  if (value.bridgeUrl && !elements.url.value) elements.url.value = value.bridgeUrl
}

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) { elements.tabInfo.textContent = 'none'; return }
  const url = tab.url ?? ''
  const usable = /^https?:\/\//i.test(url)
  elements.tabInfo.textContent = usable ? `${tab.title || 'Untitled'} — ${url}`.slice(0, 160) : `${url} (not operable)`.slice(0, 160)
}

async function refresh() {
  const response = await send('status')
  render(response?.status)
  await refreshTab()
}

/**
 * Derive the host permission pattern for the typed bridge URL.
 *
 * Chrome only accepts `http`/`https` origins in a permission pattern, while the bridge is typed as
 * `ws`/`wss`. The session exchange is an ordinary HTTPS request to the same host, so the scheme is
 * translated here; the WebSocket itself needs no host permission.
 */
function permissionOriginOf(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('Enter the bridge URL first.')
  const url = new URL(raw.includes('://') ? raw : `wss://${raw}`)
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('The bridge URL must use ws:// or wss://.')
  const scheme = url.protocol === 'wss:' ? 'https:' : 'http:'
  return new URL(`${scheme}//${url.host}`).origin
}

elements.grant.addEventListener('click', async () => {
  showError('')
  try {
    const origin = permissionOriginOf(elements.url.value)
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
    if (!granted) throw new Error('Access was not granted, so the extension cannot reach the bridge.')
    elements.urlHint.textContent = `Access granted for ${origin}.`
  } catch (error) {
    showError(String(error?.message || error))
  }
})

elements.save.addEventListener('click', async () => {
  showError('')
  const response = await send('save', { bridgeUrl: elements.url.value, token: elements.token.value, label: elements.label.value })
  if (!response?.ok) { showError(response?.error || 'Could not save the settings.'); return }
  elements.token.value = ''
  elements.urlHint.textContent = 'Saved. Stored token: ' + (elements.token.value ? 'yes' : 'unchanged')
  render(response.status)
})

elements.connect.addEventListener('click', async () => {
  showError('')
  // Persist whatever is on screen first so Connect reflects the visible settings.
  const saved = await send('save', { bridgeUrl: elements.url.value, token: elements.token.value, label: elements.label.value })
  if (!saved?.ok) { showError(saved?.error || 'Could not save the settings.'); return }
  elements.token.value = ''
  const response = await send('connect')
  if (!response?.ok) showError(response?.error || 'Could not connect.')
  render(response?.status)
  setTimeout(refresh, 600)
})

elements.disconnect.addEventListener('click', async () => {
  showError('')
  const response = await send('disconnect')
  render(response?.status)
})

elements.form.addEventListener('submit', event => event.preventDefault())

chrome.runtime.onMessage.addListener(message => {
  if (message?.channel === CHANNEL && message.event === 'status') render(message.status)
})

// Load stored (non-secret) settings.
const stored = await chrome.storage.local.get({ bridgeUrl: '', label: '' })
elements.url.value = stored.bridgeUrl || ''
elements.label.value = stored.label || ''
await refresh()
setInterval(refresh, 2000)
