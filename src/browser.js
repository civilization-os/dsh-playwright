import { chromium } from 'playwright-core'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverBrowsers } from './settings.js'
import { projectElementFingerprint, projectSnapshot } from './snapshot.js'

const MAX_REFS = 500
const REF_TTL_MS = 10 * 60 * 1000
const MAX_NETWORK_ENTRIES = 200
const MAX_NETWORK_BODY_BYTES = 128 * 1024
const MAX_NETWORK_BODY_READ_BYTES = 1024 * 1024
const SENSITIVE_HEADER = /(authorization|cookie|token|secret|api[-_]?key|session)/i
const TEXT_CONTENT_TYPE = /^(text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|graphql|x-www-form-urlencoded))(?:;|$)/i

export class BrowserManager {
  constructor(settings, home) {
    this.settings = settings; this.home = home; this.pages = new Map(); this.refs = new Map(); this.trajectories = new Map()
    this.frames = new Map(); this.frameIds = new WeakMap(); this.dialogs = []; this.downloads = []; this.lifecycleEpoch = 0; this.discover = discoverBrowsers
    this.networkEntries = new Map(); this.networkRequests = new WeakMap(); this.routes = new Map()
  }
  async status(probe = false) {
    const configured = await this.settings.read(); const browsers = await this.discover(); const selected = selectBrowser(configured.browser, browsers); const probeKey = selected ? `${JSON.stringify(configured)}:${selected.path}` : ''
    let launch = selected ? this.lastProbe?.key === probeKey ? this.lastProbe.launch : 'unchecked' : 'missing'
    if (probe && selected) {
      const probeDir = join(this.home, `probe-${randomUUID()}`)
      try { const context = await this.launchContext(configured, selected, probeDir); await context.close(); launch = 'available' }
      catch { launch = 'failed' }
      finally { await rm(probeDir, { recursive: true, force: true }).catch(() => {}) }
      this.lastProbe = { key: probeKey, launch }
    }
    return { configured, browsers, selected: selected?.id ?? '', launch, activePages: this.pages.size }
  }
  async launchContext(configured, selected, userDataDir = join(this.home, 'profile')) {
    await mkdir(userDataDir, { recursive: true })
    const context = await chromium.launchPersistentContext(userDataDir, { executablePath: selected.path, headless: configured.headless, viewport: { width: configured.width, height: configured.height }, timeout: configured.timeoutMs, ignoreHTTPSErrors: Boolean(configured.ignoreHTTPSErrors) })
    context.setDefaultTimeout(configured.timeoutMs); context.setDefaultNavigationTimeout(configured.timeoutMs)
    return context
  }
  async ensureContext() {
    if (this.context) return this.context
    if (this.contextPromise) return this.contextPromise
    const epoch = this.lifecycleEpoch
    const creating = (async () => {
      const configured = await this.settings.read(); const selected = selectBrowser(configured.browser, await this.discover())
      if (!selected) throw new Error('No configured Chrome or Edge installation was found.')
      const context = await this.launchContext(configured, selected)
      if (epoch !== this.lifecycleEpoch) { await context.close().catch(() => {}); throw new Error('Browser startup was cancelled by shutdown.') }
      this.context = context
      context.on('page', page => this.track(page)); context.on('close', () => { if (this.context === context) void this.resetContext(context) })
      for (const page of context.pages()) this.track(page)
      return context
    })()
    this.contextPromise = creating
    try { return await creating } finally { if (this.contextPromise === creating) this.contextPromise = undefined }
  }
  track(page) {
    for (const [id, value] of this.pages) if (value === page) return id
    const id = `page-${randomUUID().slice(0, 8)}`; this.pages.set(id, page)
    this.networkEntries.set(id, [])
    for (const frame of page.frames()) this.trackFrame(id, frame)
    page.on('frameattached', frame => this.trackFrame(id, frame)); page.on('framenavigated', frame => this.bumpFrame(id, frame)); page.on('framedetached', frame => this.dropFrame(frame))
    page.on('dialog', dialog => { this.dialogs.push({ pageId: id, type: dialog.type(), message: cleanText(dialog.message(), 500), defaultValuePresent: Boolean(dialog.defaultValue()) }); if (this.dialogs.length > 50) this.dialogs.shift(); void dialog.dismiss().catch(() => {}) })
    page.on('download', download => { this.downloads.push({ pageId: id, suggestedFilename: cleanText(download.suggestedFilename(), 240) }); if (this.downloads.length > 50) this.downloads.shift() })
    page.on('request', request => this.trackRequest(id, request))
    page.on('response', response => this.trackResponse(id, response))
    page.on('requestfinished', request => { void this.finishRequest(id, request) })
    page.on('requestfailed', request => this.failRequest(id, request))
    page.on('close', () => { void this.dropPage(id) })
    return id
  }
  async page(pageId) {
    const context = await this.ensureContext()
    if (!pageId) {
      if (this.pages.size === 0) return context.newPage()
      if (this.pages.size > 1) throw new Error('pageId is required when more than one page is open.')
      return this.pages.values().next().value
    }
    const page = this.pages.get(pageId); if (!page) throw new Error('Unknown page id.'); return page
  }
  async tabs(action, pageId) {
    const context = await this.ensureContext()
    if (action === 'new') this.track(await context.newPage())
    if (action === 'close') { if (!pageId) throw new Error('pageId is required when closing a page.'); await (await this.page(pageId)).close() }
    return { pages: await Promise.all([...this.pages].map(async ([id, page]) => ({ id, url: safeUrl(page.url()), title: cleanText(await page.title(), 300) }))) }
  }
  async open(pageId, url) {
    const page = await this.page(pageId); await page.goto(url, { waitUntil: 'domcontentloaded' }); const id = this.track(page); const current = new URL(page.url())
    this.trajectories.set(id, { origin: current.origin, path: current.pathname, steps: [{ type: 'open', url: safeUrl(page.url()) }] })
    return { pageId: id, url: safeUrl(page.url()), title: cleanText(await page.title(), 300) }
  }
  async snapshot(pageId, limit = 80, requestedFrameId, scopeCss, includeCandidates = false, mode = 'interactive') {
    const page = await this.page(pageId); const id = this.track(page); const target = this.resolveFrame(id, page, requestedFrameId)
    const scope = scopeCss ? await this.resolveScope(target.frame, scopeCss) : target.frame.locator('body')
    if (!['interactive', 'form'].includes(mode)) throw new Error('Snapshot mode must be interactive or form.')
    const options = { max: Math.min(Math.max(Number(limit) || 80, 1), 200), includeCandidates: includeCandidates || Boolean(scopeCss), scoped: Boolean(scopeCss), mode }
    const { raw, handles } = await evaluateSnapshot(scope, options); const elements = []
    for (let index = 0; index < raw.elements.length; index += 1) {
      const item = raw.elements[index]; const handle = handles[index]; if (!handle) continue
      const ref = `e-${randomUUID().slice(0, 8)}`
      this.refs.set(ref, { pageId: id, frameId: target.id, frameRevision: target.revision, createdAt: Date.now(), handle, ...item })
      elements.push(compactJson({ ref, role: item.role, name: item.name, nameSource: item.nameSource, disabled: item.disabled, candidate: item.candidate || undefined, scopeTarget: item.scopeTarget || undefined, valueState: item.valueState, fieldContext: item.fieldContext }))
    }
    await this.pruneRefs()
    const frames = await Promise.all(target.frame.childFrames().slice(0, 20).map(frame => this.frameSummary(id, frame)))
    return compactJson({ snapshotId: `s-${randomUUID().slice(0, 8)}`, pageId: id, frameId: target.id, frameUrl: safeUrl(target.frame.url()), url: safeUrl(page.url()), title: cleanText(await page.title(), 300), mode, scopeCss, headings: raw.headings, forms: raw.forms, elements, totalInteractive: raw.totalInteractive, candidateCount: raw.candidateCount, returned: elements.length, frames, truncated: raw.truncated || target.frame.childFrames().length > 20 })
  }
  async act(pageId, ref, action, value, expectedText, expectedUrl) {
    const page = await this.page(pageId); const target = this.refs.get(ref)
    if (!target || target.pageId !== pageId || Date.now() - target.createdAt > REF_TTL_MS) throw new Error('Unknown or stale element reference.')
    const frame = this.frames.get(target.frameId)
    if (!frame || frame.pageId !== pageId || frame.revision !== target.frameRevision || frame.frame.isDetached()) throw new Error('Target frame is stale or detached.')
    assertAction(action, value, target)
    if (!await target.handle.evaluate(element => element.isConnected).catch(() => false) || !await target.handle.isVisible().catch(() => false)) throw new Error('Target is stale or hidden.')
    const fingerprint = await target.handle.evaluate(projectElementFingerprint)
    if (fingerprint.role !== target.role || fingerprint.name !== target.name) throw new Error('Target semantics changed.')
    const configured = await this.settings.read(); const expectedLocator = expectedText ? frame.frame.getByText(expectedText).first() : undefined
    if (expectedLocator && await expectedLocator.isVisible().catch(() => false)) throw new Error('expectedText was already visible before the action.')
    const before = { pageIds: new Set(this.pages.keys()), dialogs: this.dialogs.length, downloads: this.downloads.length, url: safeUrl(page.url()) }
    if (action === 'click') await target.handle.click({ timeout: configured.timeoutMs })
    else if (action === 'fill') await target.handle.fill(value, { timeout: configured.timeoutMs })
    else if (action === 'select') await target.handle.selectOption(value, { timeout: configured.timeoutMs })
    else if (action === 'press') await target.handle.press(value, { timeout: configured.timeoutMs })
    if (expectedLocator) await expectedLocator.waitFor({ state: 'visible', timeout: configured.timeoutMs })
    if (expectedUrl) await page.waitForURL(expectedUrl, { timeout: configured.timeoutMs })
    const popupPageIds = [...this.pages.keys()].filter(id => !before.pageIds.has(id)); const dialogs = this.dialogs.slice(before.dialogs).filter(item => item.pageId === pageId); const downloads = this.downloads.slice(before.downloads).filter(item => item.pageId === pageId)
    this.record(pageId, compactJson({ type: 'act', action, role: target.role, name: target.name, frameUrl: safeUrl(frame.frame.url()), requiresValue: ['fill', 'select', 'press'].includes(action), expectsText: Boolean(expectedText) || undefined, expectsUrl: Boolean(expectedUrl) || undefined }))
    return compactJson({ ok: true, pageId, frameId: target.frameId, frameUrl: safeUrl(frame.frame.url()), url: safeUrl(page.url()), urlChanged: before.url !== safeUrl(page.url()) || undefined, expectedText, expectedUrlMatched: Boolean(expectedUrl) || undefined, dialogs, downloads, popupPageIds })
  }
  async wait(pageId, text, url, requestedFrameId) {
    if (!text && !url) throw new Error('Provide text or url to wait for.')
    const page = await this.page(pageId); const target = this.resolveFrame(pageId, page, requestedFrameId); const configured = await this.settings.read()
    if (text) await target.frame.getByText(text).first().waitFor({ state: 'visible', timeout: configured.timeoutMs }); if (url) await target.frame.waitForURL(url, { timeout: configured.timeoutMs })
    this.record(pageId, compactJson({ type: 'wait', frameUrl: safeUrl(target.frame.url()), expectsText: Boolean(text) || undefined, expectsUrl: Boolean(url) || undefined }))
    return { pageId, frameId: target.id, frameUrl: safeUrl(target.frame.url()), url: safeUrl(page.url()), title: cleanText(await page.title(), 300) }
  }
  async query(pageId, requestedFrameId, scopeCss, read, attribute) {
    const page = await this.page(pageId); const target = this.resolveFrame(pageId, page, requestedFrameId); const locator = target.frame.locator(assertCss(scopeCss)); let value
    if (read === 'count') value = await locator.evaluateAll(elements => elements.filter(element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }).length)
    else {
      if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('DOM query requires one visible target.')
      if (read === 'text') value = cleanText(await locator.innerText(), 4000)
      else if (read === 'checked') value = await locator.isChecked()
      else if (read === 'value') { if ((await locator.getAttribute('type'))?.toLocaleLowerCase() === 'password') throw new Error('Password values cannot be read.'); value = (await locator.inputValue()).slice(0, 1000) }
      else if (read === 'attribute') { if (!/^(aria-[a-z-]+|alt|class|id|name|role|title|type)$/.test(attribute || '')) throw new Error('Unsupported attribute name.'); value = await locator.getAttribute(attribute) }
      else throw new Error('Unsupported DOM read.')
    }
    return compactJson({ pageId, frameId: target.id, frameUrl: safeUrl(target.frame.url()), read, value })
  }
  async currentUrl(pageId) { return safeUrl((await this.page(pageId)).url()) }
  trackRequest(pageId, request) {
    const entries = this.networkEntries.get(pageId); if (!entries) return
    const target = networkUrl(request.url())
    const entry = {
      id: `req-${randomUUID().slice(0, 8)}`, pageId, method: request.method(), resourceType: request.resourceType(),
      url: target.url, queryKeys: target.queryKeys, startedAt: Date.now(), state: 'pending', request,
    }
    entries.push(entry); this.networkRequests.set(request, entry)
    while (entries.length > MAX_NETWORK_ENTRIES) entries.shift()
  }
  trackResponse(pageId, response) {
    const entry = this.networkRequests.get(response.request()); if (!entry || entry.pageId !== pageId) return
    entry.response = response; entry.status = response.status(); entry.statusText = cleanText(response.statusText(), 120)
    entry.contentType = cleanText(response.headers()['content-type'], 160); entry.state = 'response'
  }
  async finishRequest(pageId, request) {
    const entry = this.networkRequests.get(request); if (!entry || entry.pageId !== pageId) return
    entry.state = 'finished'; entry.durationMs = Math.max(0, Date.now() - entry.startedAt)
    const sizes = await request.sizes().catch(() => undefined)
    if (sizes) entry.transferBytes = Math.max(0, sizes.responseBodySize + sizes.responseHeadersSize)
  }
  failRequest(pageId, request) {
    const entry = this.networkRequests.get(request); if (!entry || entry.pageId !== pageId) return
    entry.state = 'failed'; entry.durationMs = Math.max(0, Date.now() - entry.startedAt); entry.failure = cleanText(request.failure()?.errorText, 300)
  }
  async network(pageId, action, requestId, limit = 50, resourceType, status, urlContains, maxBodyBytes = 64 * 1024) {
    await this.page(pageId)
    const entries = this.networkEntries.get(pageId); if (!entries) throw new Error('Unknown page id.')
    if (action === 'clear') { const cleared = entries.length; entries.length = 0; return { pageId, cleared } }
    if (action === 'list') {
      const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const needle = String(urlContains || '').toLowerCase()
      const matches = entries.filter(entry => (!resourceType || entry.resourceType === resourceType)
        && (status === undefined || entry.status === status) && (!needle || entry.url.toLowerCase().includes(needle)))
      const selected = matches.slice(-bounded).reverse()
      return { pageId, captured: entries.length, matched: matches.length, requests: selected.map(projectNetworkEntry), truncated: matches.length > selected.length }
    }
    const entry = entries.find(item => item.id === requestId)
    if (!entry) throw new Error('Unknown or expired network request id.')
    if (action === 'detail') {
      const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : {}
      const allowAuth = isAuthExposedForUrl(entry.url, configured)
      const requestHeaders = await entry.request.allHeaders().catch(() => entry.request.headers())
      const responseHeaders = entry.response ? await entry.response.allHeaders().catch(() => entry.response.headers()) : {}
      return { ...projectNetworkEntry(entry), requestHeaders: redactHeaders(requestHeaders, allowAuth), responseHeaders: redactHeaders(responseHeaders, allowAuth), hasPostData: Boolean(entry.request.postData()) }
    }
    if (action === 'body') {
      if (!entry.response) throw new Error('The network request has no response body.')
      const contentType = entry.contentType || ''
      if (!TEXT_CONTENT_TYPE.test(contentType)) throw new Error('Only textual response bodies can be read.')
      const outputLimit = Math.min(Math.max(Number(maxBodyBytes) || 64 * 1024, 1), MAX_NETWORK_BODY_BYTES)
      const declared = Number(entry.response.headers()['content-length'])
      if (Number.isFinite(declared) && declared > MAX_NETWORK_BODY_READ_BYTES) throw new Error('Response body is too large to read safely.')
      const body = await entry.response.body()
      if (body.length > MAX_NETWORK_BODY_READ_BYTES) throw new Error('Response body is too large to read safely.')
      return { ...projectNetworkEntry(entry), body: body.subarray(0, outputLimit).toString('utf8'), bytes: body.length, truncated: body.length > outputLimit }
    }
    throw new Error('Unsupported network action.')
  }
  async requestApi(pageId, requestId, url, method, headers, query, body, bodyPatch, maxBodyBytes = 64 * 1024, files, downloadPath) {
    let context
    let baseUrl = 'http://localhost'
    if (pageId) {
      const page = await this.page(pageId)
      context = page.context()
      baseUrl = page.url()
    } else {
      context = await this.ensureContext()
      const firstPage = this.pages.values().next().value
      if (firstPage) baseUrl = firstPage.url()
    }
    let template
    if (requestId) {
      if (pageId) {
        const entries = this.networkEntries.get(pageId)
        if (!entries) throw new Error('Unknown page id.')
        template = entries.find(item => item.id === requestId)
      } else {
        for (const entries of this.networkEntries.values()) {
          template = entries.find(item => item.id === requestId)
          if (template) break
        }
      }
      if (!template) throw new Error('Unknown or expired network request id.')
    }
    if (!url && !template) throw new Error('Provide url or a captured requestId.')
    const target = new URL(url || template.request.url(), baseUrl)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
    const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : {}
    const allowAuth = isAuthExposedForUrl(target.href, configured)
    for (const [name, value] of Object.entries(assertStringRecord(query, 'query'))) target.searchParams.set(name, value)
    const inherited = template ? await template.request.allHeaders().catch(() => template.request.headers()) : {}
    const requestHeaders = mergeRequestHeaders(inherited, assertStringRecord(headers, 'headers', allowAuth))
    const requestMethod = String(method || template?.method || 'GET').toUpperCase()

    let data
    let multipart
    if (files && isPlainObject(files)) {
      multipart = {}
      for (const [fieldName, fileSpec] of Object.entries(files)) {
        if (typeof fileSpec === 'string') {
          multipart[fieldName] = { name: basename(fileSpec), buffer: await readFile(fileSpec) }
        } else if (isPlainObject(fileSpec) && fileSpec.path) {
          multipart[fieldName] = {
            name: fileSpec.name || basename(fileSpec.path),
            mimeType: fileSpec.mimeType,
            buffer: await readFile(fileSpec.path),
          }
        }
      }
      if (body !== undefined) {
        const formValues = isPlainObject(body) ? body : (typeof body === 'string' ? JSON.parse(body || '{}') : {})
        for (const [k, v] of Object.entries(formValues)) {
          if (!multipart[k]) multipart[k] = String(v)
        }
      }
    } else if (body !== undefined) {
      if (isPlainObject(body) || Array.isArray(body)) {
        data = JSON.stringify(body)
        if (!Object.keys(requestHeaders).some(k => k.toLowerCase() === 'content-type')) {
          requestHeaders['content-type'] = 'application/json'
        }
      } else {
        data = String(body)
      }
    } else if (bodyPatch !== undefined) {
      if (!template) throw new Error('bodyPatch requires a captured requestId.')
      const original = JSON.parse(template.request.postData() || '{}'); const patch = JSON.parse(bodyPatch)
      if (!isPlainObject(original) || !isPlainObject(patch)) throw new Error('bodyPatch and the captured body must be JSON objects.')
      data = JSON.stringify(mergeJson(original, patch))
    } else if (template && !['GET', 'HEAD'].includes(requestMethod)) {
      data = template.request.postDataBuffer() ?? undefined
    }

    const startedAt = Date.now()
    const fetchOptions = {
      method: requestMethod,
      headers: requestHeaders,
      failOnStatusCode: false,
      timeout: configured.timeoutMs,
      ignoreHTTPSErrors: Boolean(configured.ignoreHTTPSErrors),
    }
    if (multipart) fetchOptions.multipart = multipart
    else if (data !== undefined) fetchOptions.data = data

    const response = await context.request.fetch(target.href, fetchOptions)
    const responseHeaders = response.headers()
    const contentType = cleanText(responseHeaders['content-type'], 160)
    const result = {
      pageId: pageId || undefined, requestId: requestId || undefined, method: requestMethod, url: safeUrl(response.url()), queryKeys: networkUrl(response.url()).queryKeys,
      status: response.status(), statusText: cleanText(response.statusText(), 120), ok: response.ok(), durationMs: Math.max(0, Date.now() - startedAt),
      contentType, responseHeaders: redactHeaders(responseHeaders, allowAuth),
    }
    const finish = value => {
      if (pageId) {
        this.record(pageId, compactJson({ type: 'request', method: requestMethod, origin: target.origin, path: target.pathname,
          queryKeys: [...new Set(target.searchParams.keys())].slice(0, 30), bodyKeys: jsonKeys(data), usedTemplate: Boolean(template), status: response.status() }))
      }
      return compactJson(value)
    }

    const isText = TEXT_CONTENT_TYPE.test(contentType)
    if (downloadPath || (!isText && response.status() !== 204)) {
      const buffer = await response.body()
      let savePath = downloadPath
      if (!savePath) {
        const downloadsDir = join(this.home, 'downloads')
        await mkdir(downloadsDir, { recursive: true })
        const ext = contentType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'bin'
        savePath = join(downloadsDir, `${randomUUID().slice(0, 8)}.${ext}`)
      } else {
        await mkdir(dirname(savePath), { recursive: true })
      }
      await writeFile(savePath, buffer)
      return finish({
        ...result,
        bodyAvailable: false,
        downloaded: {
          path: savePath,
          bytes: buffer.length,
          contentType,
        },
      })
    }

    if (!isText) return finish({ ...result, bodyAvailable: false })
    const outputLimit = Math.min(Math.max(Number(maxBodyBytes) || 64 * 1024, 1), MAX_NETWORK_BODY_BYTES)
    const declared = Number(responseHeaders['content-length'])
    if (Number.isFinite(declared) && declared > MAX_NETWORK_BODY_READ_BYTES) return finish({ ...result, bodyAvailable: false, bodyTooLarge: true, bytes: declared })
    const responseBody = await response.body()
    if (responseBody.length > MAX_NETWORK_BODY_READ_BYTES) return finish({ ...result, bodyAvailable: false, bodyTooLarge: true, bytes: responseBody.length })
    return finish({ ...result, bodyAvailable: true, body: responseBody.subarray(0, outputLimit).toString('utf8'), bytes: responseBody.length, truncated: responseBody.length > outputLimit })
  }
  async resolveScope(frame, scopeCss) {
    const locator = frame.locator(assertCss(scopeCss)); const configured = await this.settings.read(); await locator.first().waitFor({ state: 'visible', timeout: configured.timeoutMs })
    if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error('scopeCss must identify one visible element or container.'); return locator
  }
  trackFrame(pageId, frame) {
    const known = this.frameIds.get(frame); if (known && this.frames.has(known)) return this.frames.get(known)
    const id = `frame-${randomUUID().slice(0, 8)}`; const item = { id, pageId, frame, revision: 0 }; this.frameIds.set(frame, id); this.frames.set(id, item); return item
  }
  bumpFrame(pageId, frame) { const item = this.trackFrame(pageId, frame); item.revision += 1; void this.dropRefs(target => target.frameId === item.id) }
  dropFrame(frame) { const id = this.frameIds.get(frame); if (!id) return; this.frames.delete(id); this.frameIds.delete(frame); void this.dropRefs(target => target.frameId === id) }
  resolveFrame(pageId, page, requestedFrameId) { const item = requestedFrameId ? this.frames.get(requestedFrameId) : this.trackFrame(pageId, page.mainFrame()); if (!item || item.pageId !== pageId || item.frame.isDetached()) throw new Error('Unknown or detached frame id.'); return item }
  async frameSummary(pageId, frame) {
    const item = this.trackFrame(pageId, frame); let counts = { interactiveCount: 0, candidateCount: 0 }
    try { counts = await frame.locator('body').evaluate(body => { const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }; const named = element => (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || '').trim(); const primary = new Set([...body.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"],summary,label[for],[tabindex]')].filter(visible)); const candidateCount = [...body.querySelectorAll('[onclick],li,div,span')].filter(element => visible(element) && !primary.has(element) && named(element) && (element.hasAttribute('onclick') || getComputedStyle(element).cursor === 'pointer' && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== 'pointer'))).length; return { interactiveCount: primary.size, candidateCount } }) } catch { /* frame is still loading */ }
    return { frameId: item.id, name: cleanText(frame.name(), 160), url: safeUrl(frame.url()), interactiveCount: Math.min(counts.interactiveCount, 999), candidateCount: Math.min(counts.candidateCount, 999), childFrameCount: frame.childFrames().length }
  }
  trajectory(pageId) { const value = this.trajectories.get(pageId); if (!value) throw new Error('The current page has no browser trajectory.'); return structuredClone(value) }
  record(pageId, step) { const value = this.trajectories.get(pageId); if (!value) return; value.steps.push(step); if (value.steps.length > 100) value.steps.splice(1, value.steps.length - 100) }
  async screenshot(pageId) { const page = await this.page(pageId); const directory = join(this.home, 'screenshots'); await mkdir(directory, { recursive: true }); const path = join(directory, `${Date.now()}.png`); await page.screenshot({ path, fullPage: false }); return { pageId, path, url: safeUrl(page.url()) } }
  async pruneRefs() { const now = Date.now(); await this.dropRefs(target => now - target.createdAt > REF_TTL_MS); while (this.refs.size > MAX_REFS) { const [ref, target] = this.refs.entries().next().value; this.refs.delete(ref); await target.handle.dispose().catch(() => {}) } }
  async dropRefs(predicate) { const disposing = []; for (const [ref, target] of this.refs) if (predicate(target)) { this.refs.delete(ref); disposing.push(target.handle.dispose().catch(() => {})) }; await Promise.all(disposing) }
  async dropPage(id) { this.pages.delete(id); await this.dropRefs(item => item.pageId === id); for (const [frameId, item] of this.frames) if (item.pageId === id) this.frames.delete(frameId); this.trajectories.delete(id); this.networkEntries.delete(id) }
  async resetContext(context) { if (this.context === context) this.context = undefined; await this.dropRefs(() => true); this.pages.clear(); this.trajectories.clear(); this.frames.clear(); this.frameIds = new WeakMap(); this.networkEntries.clear(); this.networkRequests = new WeakMap(); this.routes.clear() }
  async dispose() { this.lifecycleEpoch += 1; const creating = this.contextPromise; const context = this.context; this.context = undefined; if (creating) await creating.catch(() => {}); await this.resetContext(context); if (context) await context.close().catch(() => {}) }
  async route(action, options = {}) {
    const context = await this.ensureContext()
    if (action === 'list') {
      return { routes: [...this.routes.values()].map(({ id, type, pattern, resourceTypes }) => ({ id, type, pattern, resourceTypes })) }
    }
    if (action === 'clear') {
      if (options.routeId) {
        const item = this.routes.get(options.routeId)
        if (item) {
          await context.unroute(item.pattern, item.handler).catch(() => {})
          this.routes.delete(options.routeId)
          return { cleared: 1 }
        }
        return { cleared: 0 }
      }
      const count = this.routes.size
      for (const item of this.routes.values()) {
        await context.unroute(item.pattern, item.handler).catch(() => {})
      }
      this.routes.clear()
      return { cleared: count }
    }
    if (action === 'mock') {
      if (!options.urlPattern) throw new Error('urlPattern is required for mock route.')
      const id = `route-${randomUUID().slice(0, 8)}`
      const handler = async route => {
        const bodyContent = typeof options.body === 'object' ? JSON.stringify(options.body) : String(options.body ?? '')
        await route.fulfill({
          status: Number(options.status) || 200,
          headers: options.headers || {},
          contentType: options.contentType || 'application/json',
          body: bodyContent,
        })
      }
      await context.route(options.urlPattern, handler)
      this.routes.set(id, { id, type: 'mock', pattern: options.urlPattern, handler })
      return { id, type: 'mock', pattern: options.urlPattern, status: 'active' }
    }
    if (action === 'block') {
      const pattern = options.urlPattern || '**/*'
      const resourceTypes = Array.isArray(options.resourceTypes) ? options.resourceTypes : ['image', 'media', 'font']
      const id = `route-${randomUUID().slice(0, 8)}`
      const handler = async route => {
        const type = route.request().resourceType()
        if (resourceTypes.includes(type) || (options.urlPattern && route.request().url().includes(options.urlPattern))) {
          await route.abort()
        } else {
          await route.continue()
        }
      }
      await context.route(pattern, handler)
      this.routes.set(id, { id, type: 'block', pattern, resourceTypes, handler })
      return { id, type: 'block', pattern, resourceTypes, status: 'active' }
    }
    throw new Error('Unsupported route action: must be mock, block, list, or clear.')
  }
  async cookies(action, options = {}) {
    const context = await this.ensureContext()
    const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : {}
    if (action === 'list') {
      const urls = options.urls ? (Array.isArray(options.urls) ? options.urls : [options.urls]) : undefined
      const allCookies = await context.cookies(urls)
      const sanitized = allCookies.map(cookie => {
        const allowAuth = cookie.domain ? isAuthExposedForUrl(`https://${cookie.domain.replace(/^\./, '')}`, configured) : false
        return {
          name: cookie.name,
          value: allowAuth ? cookie.value : '[redacted]',
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        }
      })
      return { count: sanitized.length, cookies: sanitized }
    }
    if (action === 'set') {
      if (!Array.isArray(options.cookies) || options.cookies.length === 0) throw new Error('cookies array is required for set action.')
      await context.addCookies(options.cookies)
      return { success: true, count: options.cookies.length }
    }
    if (action === 'clear') {
      await context.clearCookies({ name: options.name, domain: options.domain, path: options.path })
      return { success: true }
    }
    throw new Error('Unsupported cookies action: must be list, set, or clear.')
  }
}

async function evaluateSnapshot(scope, options) {
  if (typeof scope.evaluateHandle !== 'function') { const raw = await scope.evaluate(projectSnapshot, options); return { raw, handles: raw.elements.map(item => item.handle) } }
  const projection = await scope.evaluateHandle(projectSnapshot, options)
  try {
    const raw = await projection.evaluate(value => ({ ...value, elements: value.elements.map(({ node: _node, ...item }) => item) })); const array = await projection.getProperty('elements')
    try { const properties = await array.getProperties(); const handles = []; for (let index = 0; index < raw.elements.length; index += 1) { const item = properties.get(String(index)); if (!item) { handles.push(undefined); continue }; const node = await item.getProperty('node'); handles.push(node.asElement() || undefined); await item.dispose() }; return { raw, handles } }
    finally { await array.dispose() }
  } finally { await projection.dispose() }
}

function assertAction(action, value, target) {
  if (!['click', 'fill', 'select', 'press'].includes(action)) throw new Error('Unsupported browser action.')
  if (['fill', 'select', 'press'].includes(action) && typeof value !== 'string') throw new Error(`browser_act ${action} requires value.`)
  if ((action === 'fill' || action === 'select') && target.fieldContext?.confidence === 'ambiguous') throw new Error('Ambiguous form fields cannot be changed until the target is clarified.')
  if (action === 'fill' && !['textbox', 'searchbox', 'spinbutton'].includes(target.role)) throw new Error('fill requires a text-editable target.')
  if (action === 'select' && target.role !== 'combobox') throw new Error('select requires a combobox target.')
  if (action === 'click' && target.disabled) throw new Error('Disabled targets cannot be clicked.')
}

export function losslessJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map(item => losslessJson(item) ?? null)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => { const normalized = losslessJson(item); return normalized === undefined ? [] : [[key, normalized]] }))
}

function compactJson(value) { return losslessJson(value) }
function cleanText(value, max) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max) }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol } catch { return '' } }
function networkUrl(value) { try { const url = new URL(value); return { url: safeUrl(value), queryKeys: [...new Set(url.searchParams.keys())].slice(0, 30) } } catch { return { url: safeUrl(value), queryKeys: [] } } }
function projectNetworkEntry(entry) { return compactJson({ id: entry.id, pageId: entry.pageId, method: entry.method, resourceType: entry.resourceType, url: entry.url, queryKeys: entry.queryKeys, status: entry.status, statusText: entry.statusText, contentType: entry.contentType, state: entry.state, durationMs: entry.durationMs, transferBytes: entry.transferBytes, failure: entry.failure }) }
export function isAuthExposedForUrl(url, configured) {
  if (!configured?.exposeAuthFields) return false
  const origins = Array.isArray(configured.trustedOrigins) ? configured.trustedOrigins : []
  if (origins.length === 0) return true
  try {
    const origin = new URL(url).origin.toLowerCase()
    return origins.includes(origin)
  } catch {
    return false
  }
}

export function redactHeaders(headers, allowAuth = false) {
  return Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [
    name,
    !allowAuth && SENSITIVE_HEADER.test(name) ? '[redacted]' : cleanText(value, 2000),
  ]))
}

export function assertStringRecord(value, label, allowAuth = false) {
  if (value === undefined) return {}
  if (!isPlainObject(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain string values.`)
  if (label === 'headers' && !allowAuth && Object.keys(value).some(name => SENSITIVE_HEADER.test(name))) {
    throw new Error('Authentication and session headers are inherited internally and cannot be supplied as model arguments.')
  }
  return value
}
function mergeRequestHeaders(inherited, overrides) {
  const blocked = /^(cookie|host|content-length|connection|transfer-encoding|accept-encoding)$/i
  const result = Object.fromEntries(Object.entries(inherited || {}).filter(([name]) => !blocked.test(name)))
  for (const [name, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(result)) if (existing.toLowerCase() === name.toLowerCase()) delete result[existing]
    result[name] = value
  }
  return result
}
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function mergeJson(base, patch) { return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key, isPlainObject(base[key]) && isPlainObject(patch[key]) ? mergeJson(base[key], patch[key]) : Object.hasOwn(patch, key) ? patch[key] : base[key]])) }
function jsonKeys(value) { try { const parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)); return isPlainObject(parsed) ? Object.keys(parsed).slice(0, 30) : [] } catch { return [] } }
function assertCss(value) { const selector = String(value || '').trim(); if (!selector || selector.length > 300 || selector.includes('\0')) throw new Error('Invalid CSS scope.'); return selector }
function selectBrowser(preference, browsers) { return preference === 'auto' ? browsers.find(item => item.id === 'chrome') ?? browsers.find(item => item.id === 'msedge') : browsers.find(item => item.id === preference) }
