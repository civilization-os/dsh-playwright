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
  backend: 'playwright',
  bridgePort: 8765,
  bridgeToken: '',
  cdpEndpoint: '',
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
  const backend = value.backend !== undefined ? value.backend : 'playwright'
  if (!['playwright', 'extension', 'cdp'].includes(backend)) throw new Error('Invalid backend selection.')
  const bridgePort = value.bridgePort !== undefined ? value.bridgePort : 8765
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new Error('Invalid bridgePort.')
  const bridgeToken = typeof value.bridgeToken === 'string' ? value.bridgeToken : ''
  const cdpEndpoint = typeof value.cdpEndpoint === 'string' ? value.cdpEndpoint.trim() : ''
  if (cdpEndpoint) {
    let parsedUrl
    try {
      parsedUrl = new URL(cdpEndpoint)
    } catch {
      throw new Error(`Invalid cdpEndpoint: ${cdpEndpoint}`)
    }
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid cdpEndpoint protocol.')
    }
  }
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
    backend,
    bridgePort,
    bridgeToken,
    cdpEndpoint,
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
