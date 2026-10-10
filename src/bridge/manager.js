import { ChromeBridgeServer } from './server.js'
import { randomUUID } from 'node:crypto'
import { discoverBrowsers } from '../settings.js'

export class ChromeBridgeManager {
  constructor(settings, home) {
    this.settings = settings
    this.home = home
    this.server = null
    this.trajectories = new Map()
    this.cachedStatus = null
  }

  async ensureServer() {
    if (this.server) return this.server
    const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : {}
    const port = Number(configured.bridgePort) || 8765
    const token = configured.bridgeToken || ''
    const timeoutMs = Number(configured.timeoutMs) || 15000

    this.server = new ChromeBridgeServer({
      port,
      token,
      timeoutMs,
    })
    await this.server.start()
    return this.server
  }

  async status(probe = false) {
    const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : {}
    await this.ensureServer()
    const serverStatus = this.server.getStatus()

    let launch = serverStatus.connected ? 'available' : 'missing'

    let activePages = 0
    let activeTab = null
    if (serverStatus.connected) {
      try {
        const tabsResult = await this.server.sendRequest('browser.tabs', { action: 'list' }, probe ? 3000 : 1500)
        activePages = tabsResult?.pages?.length || 0
        activeTab = tabsResult?.pages?.[0] || null
      } catch {
        if (probe) launch = 'failed'
      }
    }

    const browsers = await discoverBrowsers().catch(() => [])

    return {
      configured,
      backend: 'extension',
      launch,
      connected: serverStatus.connected,
      bridgePort: serverStatus.port,
      tokenConfigured: serverStatus.tokenConfigured,
      clientInfo: serverStatus.clientInfo,
      activePages,
      activeTab,
      browsers,
      selected: 'extension',
    }
  }

  async tabs(action, pageId) {
    await this.ensureServer()
    return await this.server.sendRequest('browser.tabs', { action, pageId })
  }

  async open(pageId, url) {
    await this.ensureServer()
    const result = await this.server.sendRequest('browser.open', { pageId, url })
    const targetPageId = result.pageId || 'active'
    try {
      const parsed = new URL(result.url)
      this.trajectories.set(targetPageId, {
        origin: parsed.origin,
        path: parsed.pathname,
        steps: [{ type: 'open', url: result.url }],
      })
    } catch {}
    return result
  }

  async snapshot(pageId = 'active', limit = 80, requestedFrameId, scopeCss, includeCandidates = false, mode = 'interactive') {
    await this.ensureServer()
    if (!['interactive', 'form'].includes(mode)) throw new Error('Snapshot mode must be interactive or form.')
    const result = await this.server.sendRequest('browser.snapshot', {
      pageId,
      limit: Math.min(Math.max(Number(limit) || 80, 1), 200),
      frameId: requestedFrameId,
      scopeCss,
      includeCandidates: includeCandidates || Boolean(scopeCss),
      mode,
    })
    return result
  }

  async act(pageId = 'active', ref, action, value, expectedText, expectedUrl) {
    await this.ensureServer()
    if (!['click', 'fill', 'select', 'press'].includes(action)) throw new Error('Unsupported browser action.')
    if (['fill', 'select', 'press'].includes(action) && typeof value !== 'string') {
      throw new Error(`browser_act ${action} requires value.`)
    }

    const result = await this.server.sendRequest('browser.act', {
      pageId,
      ref,
      action,
      value,
      expectedText,
      expectedUrl,
    })

    this.record(pageId, {
      type: 'act',
      action,
      ref,
      requiresValue: ['fill', 'select', 'press'].includes(action),
      expectsText: Boolean(expectedText) || undefined,
      expectsUrl: Boolean(expectedUrl) || undefined,
    })

    return result
  }

  async wait(pageId = 'active', text, url, requestedFrameId, networkIdle, networkUrl) {
    await this.ensureServer()
    if (!text && !url && !networkIdle && !networkUrl) {
      throw new Error('Provide text, url, networkIdle, or networkUrl to wait for.')
    }
    const result = await this.server.sendRequest('browser.wait', {
      pageId,
      text,
      url,
      frameId: requestedFrameId,
      networkIdle,
      networkUrl,
    })
    this.record(pageId, {
      type: 'wait',
      expectsText: Boolean(text) || undefined,
      expectsUrl: Boolean(url) || undefined,
      networkIdle: Boolean(networkIdle) || undefined,
      networkUrl: networkUrl || undefined,
    })
    return result
  }

  async query(pageId = 'active', requestedFrameId, scopeCss, read, attribute) {
    await this.ensureServer()
    return await this.server.sendRequest('browser.query', {
      pageId,
      frameId: requestedFrameId,
      scopeCss,
      read,
      attribute,
    })
  }

  async screenshot(pageId = 'active') {
    await this.ensureServer()
    return await this.server.sendRequest('browser.screenshot', { pageId })
  }

  async currentUrl(pageId = 'active') {
    await this.ensureServer()
    const result = await this.server.sendRequest('browser.tabs', { action: 'list' })
    const matched = result?.pages?.find(p => p.id === pageId) || result?.pages?.[0]
    return matched?.url || ''
  }

  trajectory(pageId) {
    const value = this.trajectories.get(pageId) || this.trajectories.get('active')
    if (!value) throw new Error('The current page has no browser trajectory.')
    return structuredClone(value)
  }

  record(pageId, step) {
    const key = pageId || 'active'
    let value = this.trajectories.get(key)
    if (!value) {
      value = { origin: '', path: '', steps: [] }
      this.trajectories.set(key, value)
    }
    value.steps.push(step)
    if (value.steps.length > 100) value.steps.splice(1, value.steps.length - 100)
  }

  async dispose() {
    if (this.server) {
      await this.server.stop()
      this.server = null
    }
    this.trajectories.clear()
  }
}
