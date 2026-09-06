import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverBrowsers } from './settings.js'

export class BrowserManager {
  constructor(settings, home) { this.settings = settings; this.home = home; this.pages = new Map(); this.refs = new Map() }
  async status(probe = false) {
    const configured = await this.settings.read()
    const browsers = await discoverBrowsers()
    const selected = selectBrowser(configured.browser, browsers)
    let launch = selected ? 'unchecked' : 'missing'
    if (probe && selected) {
      try { const context = await this.launchContext(configured, selected, true); await context.close(); launch = 'available' }
      catch { launch = 'failed' }
    }
    return { configured, browsers, selected: selected?.id ?? '', launch, activePages: this.pages.size }
  }
  async launchContext(configured, selected, probe) {
    const userDataDir = join(this.home, probe ? 'probe' : 'profile')
    await mkdir(userDataDir, { recursive: true })
    return chromium.launchPersistentContext(userDataDir, {
      executablePath: selected.path, headless: configured.headless,
      viewport: { width: configured.width, height: configured.height }, timeout: configured.timeoutMs,
    })
  }
  async ensureContext() {
    if (this.context) return this.context
    const configured = await this.settings.read()
    const selected = selectBrowser(configured.browser, await discoverBrowsers())
    if (!selected) throw new Error('No configured Chrome or Edge installation was found.')
    this.context = await this.launchContext(configured, selected, false)
    this.context.on('page', page => this.track(page))
    for (const page of this.context.pages()) this.track(page)
    return this.context
  }
  track(page) {
    for (const [id, value] of this.pages) if (value === page) return id
    const id = `page-${randomUUID().slice(0, 8)}`
    this.pages.set(id, page)
    page.on('close', () => {
      this.pages.delete(id)
      for (const [ref, item] of this.refs) if (item.pageId === id) this.refs.delete(ref)
    })
    return id
  }
  async page(pageId) {
    await this.ensureContext()
    if (!pageId) return this.pages.values().next().value
    const page = this.pages.get(pageId)
    if (!page) throw new Error('Unknown page id.')
    return page
  }
  async tabs(action, pageId) {
    const context = await this.ensureContext()
    if (action === 'new') this.track(await context.newPage())
    if (action === 'close') {
      if (!pageId) throw new Error('pageId is required when closing a page.')
      await (await this.page(pageId)).close()
    }
    return { pages: await Promise.all([...this.pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title() }))) }
  }
  async open(pageId, url) {
    const page = await this.page(pageId)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return { pageId: this.track(page), url: page.url(), title: await page.title() }
  }
  async snapshot(pageId, limit = 80) {
    const page = await this.page(pageId)
    const id = this.track(page)
    const raw = await page.locator('body').evaluate((body, max) => {
      const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
      const name = element => element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || ''
      const role = element => element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[element.tagName] || element.tagName.toLowerCase())
      const path = element => { const parts = []; for (let node = element; node && node !== body; node = node.parentElement) { const siblings = [...node.parentElement.children].filter(item => item.tagName === node.tagName); parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`) } return `body>${parts.join('>')}` }
      const elements = [...body.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"]')].filter(visible).slice(0, max).map(element => ({ path: path(element), role: role(element), name: name(element).trim().replace(/\s+/g, ' ').slice(0, 160), disabled: Boolean(element.disabled), value: 'value' in element && element.type !== 'password' ? String(element.value).slice(0, 160) : undefined }))
      const headings = [...body.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).slice(0, 20).map(element => element.innerText.trim().replace(/\s+/g, ' ').slice(0, 200))
      return { elements, headings, truncated: elements.length >= max }
    }, Math.min(Math.max(limit, 1), 200))
    const elements = raw.elements.map(item => {
      const key = `${id}:${item.path}:${item.role}:${item.name}`
      let ref = [...this.refs].find(([, entry]) => entry.key === key)?.[0]
      if (!ref) { ref = `e-${randomUUID().slice(0, 8)}`; this.refs.set(ref, { pageId: id, key, ...item }) }
      return { ref, role: item.role, name: item.name, disabled: item.disabled, ...(item.value ? { value: item.value } : {}) }
    })
    return { snapshotId: `s-${randomUUID().slice(0, 8)}`, pageId: id, url: page.url(), title: await page.title(), headings: raw.headings, elements, truncated: raw.truncated }
  }
  async act(pageId, ref, action, value, expectedText) {
    const page = await this.page(pageId)
    const target = this.refs.get(ref)
    if (!target || target.pageId !== pageId) throw new Error('Unknown or stale element reference.')
    const locator = page.locator(target.path)
    if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('Target is stale or ambiguous.')
    const fingerprint = await locator.evaluate(element => ({ role: element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[element.tagName] || element.tagName.toLowerCase()), name: (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160) }))
    if (fingerprint.role !== target.role || fingerprint.name !== target.name) throw new Error('Target semantics changed.')
    if (action === 'click') await locator.click()
    else if (action === 'fill') await locator.fill(value ?? '')
    else if (action === 'select') await locator.selectOption(value ?? '')
    else if (action === 'press') await locator.press(value ?? '')
    else throw new Error('Unsupported browser action.')
    if (expectedText) await page.getByText(expectedText).first().waitFor({ state: 'visible' })
    return { ok: true, pageId, url: page.url(), expectedText: expectedText || undefined }
  }
  async wait(pageId, text, url) {
    const page = await this.page(pageId)
    const configured = await this.settings.read()
    if (text) await page.getByText(text).first().waitFor({ state: 'visible', timeout: configured.timeoutMs })
    if (url) await page.waitForURL(url, { timeout: configured.timeoutMs })
    return { pageId, url: page.url(), title: await page.title() }
  }
  async screenshot(pageId) {
    const page = await this.page(pageId)
    const directory = join(this.home, 'screenshots'); await mkdir(directory, { recursive: true })
    const path = join(directory, `${Date.now()}.png`); await page.screenshot({ path, fullPage: false })
    return { pageId, path, url: page.url() }
  }
  async dispose() {
    const context = this.context
    this.context = undefined; this.pages.clear(); this.refs.clear()
    if (context) await context.close()
  }
}

function selectBrowser(preference, browsers) {
  if (preference === 'auto') return browsers.find(item => item.id === 'chrome') ?? browsers.find(item => item.id === 'msedge')
  return browsers.find(item => item.id === preference)
}
