import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverBrowsers } from './settings.js'

export class BrowserManager {
  constructor(settings, home) {
    this.settings = settings; this.home = home; this.pages = new Map(); this.refs = new Map(); this.trajectories = new Map()
    this.frames = new Map(); this.frameIds = new WeakMap()
  }
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
    for (const frame of page.frames()) this.trackFrame(id, frame)
    page.on('frameattached', frame => this.trackFrame(id, frame))
    page.on('framenavigated', frame => this.bumpFrame(id, frame))
    page.on('framedetached', frame => this.dropFrame(frame))
    page.on('close', () => {
      this.pages.delete(id)
      for (const [ref, item] of this.refs) if (item.pageId === id) this.refs.delete(ref)
      for (const [frameId, item] of this.frames) if (item.pageId === id) this.frames.delete(frameId)
      this.trajectories.delete(id)
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
    const id = this.track(page)
    this.trajectories.set(id, { origin: new URL(page.url()).origin, path: new URL(page.url()).pathname, steps: [{ type: 'open', url: `${new URL(page.url()).origin}${new URL(page.url()).pathname}` }] })
    return { pageId: id, url: page.url(), title: await page.title() }
  }
  async snapshot(pageId, limit = 80, requestedFrameId, scopeCss, includeCandidates = false) {
    const page = await this.page(pageId)
    const id = this.track(page)
    const target = this.resolveFrame(id, page, requestedFrameId)
    const scope = scopeCss ? await this.resolveScope(target.frame, scopeCss) : target.frame.locator('body')
    const raw = await scope.evaluate((root, options) => {
      const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
      const name = element => element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || ''
      const role = element => element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'listitem', SUMMARY: 'button', LABEL: 'label' }[element.tagName] || element.tagName.toLowerCase())
      const path = element => { const parts = []; for (let node = element; node && node !== document.body; node = node.parentElement) { const siblings = [...node.parentElement.children].filter(item => item.tagName === node.tagName); parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`) } return `body>${parts.join('>')}` }
      const within = selector => root === document.body ? [...root.querySelectorAll(selector)] : [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]
      const primarySelector = 'a[href],button,input,textarea,select,[role],[contenteditable="true"],summary,label[for],[tabindex]'
      const primary = within(primarySelector).filter(visible)
      const primarySet = new Set(primary)
      const candidates = within('[onclick],li,div,span').filter(element => {
        if (!visible(element) || primarySet.has(element) || !name(element).trim()) return false
        if (element.hasAttribute('onclick')) return true
        const pointer = getComputedStyle(element).cursor === 'pointer'
        return pointer && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== 'pointer')
      })
      const all = [...new Set([...primary, ...(options.includeCandidates ? candidates : [])])]
      const elements = all.slice(0, options.max).map(element => ({ path: path(element), role: role(element), name: name(element).trim().replace(/\s+/g, ' ').slice(0, 160), disabled: Boolean(element.disabled), candidate: !primarySet.has(element), value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && element.type !== 'password' ? String(element.value).slice(0, 160) : undefined }))
      const headings = within('h1,h2,h3,[role="heading"]').filter(visible).slice(0, 20).map(element => element.innerText.trim().replace(/\s+/g, ' ').slice(0, 200))
      return { elements, headings, totalInteractive: all.length, candidateCount: candidates.length, truncated: all.length > options.max }
    }, { max: Math.min(Math.max(limit, 1), 200), includeCandidates: includeCandidates || Boolean(scopeCss) })
    const elements = raw.elements.map(item => {
      const key = `${id}:${target.id}:${target.revision}:${item.path}:${item.role}:${item.name}`
      let ref = [...this.refs].find(([, entry]) => entry.key === key)?.[0]
      if (!ref) { ref = `e-${randomUUID().slice(0, 8)}`; this.refs.set(ref, { pageId: id, frameId: target.id, frameRevision: target.revision, key, ...item }) }
      return { ref, role: item.role, name: item.name, disabled: item.disabled, ...(item.candidate ? { candidate: true } : {}), ...(item.value ? { value: item.value } : {}) }
    })
    const frames = await Promise.all(target.frame.childFrames().slice(0, 20).map(frame => this.frameSummary(id, frame)))
    return { snapshotId: `s-${randomUUID().slice(0, 8)}`, pageId: id, frameId: target.id, frameUrl: safeFrameUrl(target.frame.url()), url: page.url(), title: await page.title(), ...(scopeCss ? { scopeCss } : {}), headings: raw.headings, elements, totalInteractive: raw.totalInteractive, candidateCount: raw.candidateCount, returned: elements.length, frames, truncated: raw.truncated || target.frame.childFrames().length > 20 }
  }
  async act(pageId, ref, action, value, expectedText) {
    const page = await this.page(pageId)
    const target = this.refs.get(ref)
    if (!target || target.pageId !== pageId) throw new Error('Unknown or stale element reference.')
    const frame = this.frames.get(target.frameId)
    if (!frame || frame.pageId !== pageId || frame.revision !== target.frameRevision || frame.frame.isDetached()) throw new Error('Target frame is stale or detached.')
    const locator = frame.frame.locator(target.path)
    if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('Target is stale or ambiguous.')
    const fingerprint = await locator.evaluate(element => ({ role: element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'listitem', SUMMARY: 'button', LABEL: 'label' }[element.tagName] || element.tagName.toLowerCase()), name: (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160) }))
    if (fingerprint.role !== target.role || fingerprint.name !== target.name) throw new Error('Target semantics changed.')
    if (action === 'click') await locator.click()
    else if (action === 'fill') await locator.fill(value ?? '')
    else if (action === 'select') await locator.selectOption(value ?? '')
    else if (action === 'press') await locator.press(value ?? '')
    else throw new Error('Unsupported browser action.')
    if (expectedText) await frame.frame.getByText(expectedText).first().waitFor({ state: 'visible' })
    this.record(pageId, { type: 'act', action, role: target.role, name: target.name, frameUrl: safeFrameUrl(frame.frame.url()), requiresValue: ['fill', 'select', 'press'].includes(action), ...(expectedText ? { expectedText } : {}) })
    return { ok: true, pageId, frameId: target.frameId, frameUrl: safeFrameUrl(frame.frame.url()), url: page.url(), ...(expectedText ? { expectedText } : {}) }
  }
  async wait(pageId, text, url, requestedFrameId) {
    const page = await this.page(pageId)
    const target = this.resolveFrame(pageId, page, requestedFrameId)
    const configured = await this.settings.read()
    if (text) await target.frame.getByText(text).first().waitFor({ state: 'visible', timeout: configured.timeoutMs })
    if (url) await target.frame.waitForURL(url, { timeout: configured.timeoutMs })
    this.record(pageId, { type: 'wait', frameUrl: safeFrameUrl(target.frame.url()), ...(text ? { text } : {}), ...(url ? { url } : {}) })
    return { pageId, frameId: target.id, frameUrl: safeFrameUrl(target.frame.url()), url: page.url(), title: await page.title() }
  }
  async query(pageId, requestedFrameId, scopeCss, read, attribute) {
    const page = await this.page(pageId)
    const target = this.resolveFrame(pageId, page, requestedFrameId)
    const selector = assertCss(scopeCss)
    const locator = target.frame.locator(selector)
    let value
    if (read === 'count') {
      value = await locator.evaluateAll(elements => elements.filter(element => {
        const box = element.getBoundingClientRect(); const style = getComputedStyle(element)
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }).length)
    } else {
      if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('DOM query requires one visible target.')
      if (read === 'text') value = (await locator.innerText()).trim().replace(/\s+/g, ' ').slice(0, 4000)
      else if (read === 'checked') value = await locator.isChecked()
      else if (read === 'value') {
        if ((await locator.getAttribute('type'))?.toLocaleLowerCase() === 'password') throw new Error('Password values cannot be read.')
        value = (await locator.inputValue()).slice(0, 1000)
      }
      else if (read === 'attribute') {
        if (!/^(aria-[a-z-]+|alt|class|id|name|role|title|type)$/.test(attribute || '')) throw new Error('Unsupported attribute name.')
        value = await locator.getAttribute(attribute)
      } else throw new Error('Unsupported DOM read.')
    }
    return { pageId, frameId: target.id, frameUrl: safeFrameUrl(target.frame.url()), read, value }
  }
  async resolveScope(frame, scopeCss) {
    const locator = frame.locator(assertCss(scopeCss))
    const configured = await this.settings.read()
    await locator.first().waitFor({ state: 'visible', timeout: configured.timeoutMs })
    if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('scopeCss must identify one visible element or container.')
    return locator
  }
  trackFrame(pageId, frame) {
    const known = this.frameIds.get(frame)
    if (known) {
      const item = this.frames.get(known)
      if (item) return item
      this.frameIds.delete(frame)
    }
    const id = `frame-${randomUUID().slice(0, 8)}`
    const item = { id, pageId, frame, revision: 0 }
    this.frameIds.set(frame, id); this.frames.set(id, item)
    return item
  }
  bumpFrame(pageId, frame) {
    const item = this.trackFrame(pageId, frame)
    item.revision += 1
    for (const [ref, target] of this.refs) if (target.frameId === item.id) this.refs.delete(ref)
  }
  dropFrame(frame) {
    const id = this.frameIds.get(frame)
    if (!id) return
    this.frames.delete(id)
    this.frameIds.delete(frame)
    for (const [ref, target] of this.refs) if (target.frameId === id) this.refs.delete(ref)
  }
  resolveFrame(pageId, page, requestedFrameId) {
    const item = requestedFrameId ? this.frames.get(requestedFrameId) : this.trackFrame(pageId, page.mainFrame())
    if (!item || item.pageId !== pageId || item.frame.isDetached()) throw new Error('Unknown or detached frame id.')
    return item
  }
  async frameSummary(pageId, frame) {
    const item = this.trackFrame(pageId, frame)
    let counts = { interactiveCount: 0, candidateCount: 0 }
    try {
      counts = await frame.locator('body').evaluate(body => {
        const visible = element => {
          const box = element.getBoundingClientRect(); const style = getComputedStyle(element)
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const named = element => (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || '').trim()
        const primary = new Set([...body.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"],summary,label[for],[tabindex]')].filter(visible))
        const candidateCount = [...body.querySelectorAll('[onclick],li,div,span')].filter(element => {
          if (!visible(element) || primary.has(element) || !named(element)) return false
          if (element.hasAttribute('onclick')) return true
          return getComputedStyle(element).cursor === 'pointer' && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== 'pointer')
        }).length
        return { interactiveCount: primary.size, candidateCount }
      })
    } catch { /* frame is still loading */ }
    return { frameId: item.id, name: frame.name(), url: safeFrameUrl(frame.url()), interactiveCount: Math.min(counts.interactiveCount, 999), candidateCount: Math.min(counts.candidateCount, 999), childFrameCount: frame.childFrames().length }
  }
  trajectory(pageId) {
    const value = this.trajectories.get(pageId)
    if (!value) throw new Error('The current page has no browser trajectory.')
    return structuredClone(value)
  }
  record(pageId, step) {
    const value = this.trajectories.get(pageId)
    if (!value) return
    value.steps.push(step)
    if (value.steps.length > 100) value.steps.splice(1, value.steps.length - 100)
  }
  async screenshot(pageId) {
    const page = await this.page(pageId)
    const directory = join(this.home, 'screenshots'); await mkdir(directory, { recursive: true })
    const path = join(directory, `${Date.now()}.png`); await page.screenshot({ path, fullPage: false })
    return { pageId, path, url: page.url() }
  }
  async dispose() {
    const context = this.context
    this.context = undefined; this.pages.clear(); this.refs.clear(); this.trajectories.clear(); this.frames.clear(); this.frameIds = new WeakMap()
    if (context) await context.close()
  }
}

function safeFrameUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol }
  catch { return '' }
}

function assertCss(value) {
  const selector = String(value || '').trim()
  if (!selector || selector.length > 300 || selector.includes('\0')) throw new Error('Invalid CSS scope.')
  return selector
}

function selectBrowser(preference, browsers) {
  if (preference === 'auto') return browsers.find(item => item.id === 'chrome') ?? browsers.find(item => item.id === 'msedge')
  return browsers.find(item => item.id === preference)
}
