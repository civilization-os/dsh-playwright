import { access, mkdir, open, readFile, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const defaults = Object.freeze({
  browser: 'auto',
  headless: false,
  timeoutMs: 10000,
  width: 1280,
  height: 800,
  ignoreHTTPSErrors: false,
  exposeAuthFields: false,
  trustedOrigins: [],
  /**
   * Backend policy: the user's own Chrome through the Chrome Bridge extension is preferred, and the
   * isolated Playwright browser is opt-in. A tool call may still ask for `playwright`, but only when
   * the conversation makes it explicit (`userRequestedPlaywright`) or when this setting names it, so
   * a second browser process can never start by accident.
   */
  backend: 'chrome-extension',
  chromeBridge: Object.freeze({
    enabled: false,
    /** Hosting mode: 'webServer' reuses DSH's HTTP server; 'standalone' opens its own listener. */
    mode: 'webServer',
    path: '/chrome-bridge',
    host: '127.0.0.1',
    port: 0,
    /** Advertised to the extension popup. Set this once a TLS reverse proxy is in front. */
    publicUrl: '',
    tlsKeyFile: '',
    tlsCertFile: '',
    allowedOrigins: [],
    requestTimeoutMs: 30000,
  }),
})

export class SettingsStore {
  constructor(path) { this.path = path }
  async read() {
    try { return validateSettings({ ...defaults, ...JSON.parse(await readFile(this.path, 'utf8')) }) }
    catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error }
  }
  async write(value) {
    const settings = validateSettings(value)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`); await file.sync() } finally { await file.close() }
    await rename(temporary, this.path)
    return settings
  }
}

export function validateSettings(value) {
  if (!['auto', 'chrome', 'msedge'].includes(value.browser)) throw new Error('Invalid browser selection.')
  if (typeof value.headless !== 'boolean') throw new Error('Invalid headless setting.')
  for (const key of ['timeoutMs', 'width', 'height']) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > (key === 'timeoutMs' ? 120000 : 10000)) throw new Error(`Invalid ${key}.`)
  }
  if (value.ignoreHTTPSErrors !== undefined && typeof value.ignoreHTTPSErrors !== 'boolean') throw new Error('Invalid ignoreHTTPSErrors setting.')
  if (value.exposeAuthFields !== undefined && typeof value.exposeAuthFields !== 'boolean') throw new Error('Invalid exposeAuthFields setting.')
  let trustedOrigins = []
  if (value.trustedOrigins !== undefined) {
    if (!Array.isArray(value.trustedOrigins)) throw new Error('Invalid trustedOrigins setting.')
    trustedOrigins = value.trustedOrigins.map(item => {
      if (typeof item !== 'string') throw new Error('Invalid trustedOrigins item.')
      const trimmed = item.trim()
      if (!trimmed) return ''
      try {
        const url = new URL(trimmed)
        return url.origin.toLowerCase()
      } catch {
        throw new Error(`Invalid trustedOrigins entry: ${trimmed}`)
      }
    }).filter(Boolean)
  }
  return {
    browser: value.browser,
    headless: value.headless,
    timeoutMs: value.timeoutMs,
    width: value.width,
    height: value.height,
    ignoreHTTPSErrors: Boolean(value.ignoreHTTPSErrors),
    exposeAuthFields: Boolean(value.exposeAuthFields),
    trustedOrigins,
    backend: validateBackend(value.backend),
    chromeBridge: validateChromeBridge(value.chromeBridge),
  }
}

const BRIDGE_MODES = ['webServer', 'standalone']

function validateBackend(value) {
  const backend = value === undefined ? defaults.backend : value
  if (!['playwright', 'chrome-extension'].includes(backend)) throw new Error('Invalid backend selection.')
  return backend
}

/** Validate the Chrome Bridge block. Unknown keys are dropped so credentials never reach settings.json. */
export function validateChromeBridge(value) {
  const base = defaults.chromeBridge
  const input = value === undefined || value === null ? {} : value
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid chromeBridge setting.')
  const merged = { ...base, ...input }
  if (typeof merged.enabled !== 'boolean') throw new Error('Invalid chromeBridge.enabled setting.')
  if (!BRIDGE_MODES.includes(merged.mode)) throw new Error('Invalid chromeBridge.mode setting.')
  const path = String(merged.path ?? base.path).trim()
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.endsWith('/')) throw new Error('Invalid chromeBridge.path setting.')
  const host = String(merged.host ?? base.host).trim()
  if (!/^[A-Za-z0-9.:[\]_-]+$/.test(host)) throw new Error('Invalid chromeBridge.host setting.')
  const port = Number(merged.port ?? base.port)
  // Port 0 asks the OS for a free port; 1-65535 bind a specific one.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid chromeBridge.port setting.')
  const requestTimeoutMs = Number(merged.requestTimeoutMs ?? base.requestTimeoutMs)
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 300000) throw new Error('Invalid chromeBridge.requestTimeoutMs setting.')
  const publicUrl = String(merged.publicUrl ?? '').trim()
  if (publicUrl) {
    let parsed
    try { parsed = new URL(publicUrl) } catch { throw new Error('Invalid chromeBridge.publicUrl setting.') }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('chromeBridge.publicUrl must use ws:// or wss://.')
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('chromeBridge.publicUrl must not contain credentials, a query, or a fragment.')
  }
  const allowedOrigins = []
  for (const item of merged.allowedOrigins ?? []) {
    if (typeof item !== 'string') throw new Error('Invalid chromeBridge.allowedOrigins item.')
    const trimmed = item.trim().toLowerCase()
    if (!trimmed) continue
    try { allowedOrigins.push(new URL(trimmed).origin.toLowerCase()) } catch { throw new Error(`Invalid chromeBridge.allowedOrigins entry: ${trimmed}`) }
  }
  return {
    enabled: merged.enabled,
    mode: merged.mode,
    path,
    host,
    port,
    publicUrl,
    tlsKeyFile: String(merged.tlsKeyFile ?? '').trim(),
    tlsCertFile: String(merged.tlsCertFile ?? '').trim(),
    allowedOrigins,
    requestTimeoutMs,
  }
}

export async function discoverBrowsers(env = process.env, platform = process.platform) {
  const candidates = platform === 'win32' ? [
    ['chrome', join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')],
    ['chrome', join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe')],
    ['chrome', join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')],
    ['msedge', join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')],
    ['msedge', join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')],
  ] : platform === 'darwin' ? [
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ] : [['chrome', '/usr/bin/google-chrome'], ['chrome', '/usr/bin/google-chrome-stable'], ['msedge', '/usr/bin/microsoft-edge']]
  const found = []
  for (const [id, path] of candidates) {
    if (found.some(item => item.id === id)) continue
    try { await access(path, constants.X_OK); found.push({ id, path }) } catch { /* candidate absent */ }
  }
  return found
}
