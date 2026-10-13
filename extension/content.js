/**
 * Chrome Bridge page agent.
 *
 * Runs once per document as an isolated-world content script. It owns the DOM reference registry
 * and performs every page read and page action, mirroring the semantics of the Playwright backend:
 *
 *  - Snapshot semantics come from the shared `projectSnapshot` implementation (`src/snapshot.js`),
 *    so Playwright and Chrome Extension backends return the same structure.
 *  - A `ref` is a stable opaque identifier bound to one live DOM node plus the semantic
 *    fingerprint observed when the snapshot was taken. Nothing is located by CSS path alone.
 *  - References expire on timeout, navigation, removal, hiding, or a semantic change, and the
 *    agent reports an explicit error instead of acting on a best guess.
 *
 * The remote server can only invoke the fixed operation list below. Arbitrary JavaScript is not
 * representable in the protocol.
 */

/**
 * Shared snapshot semantics. The build step inlines this module into the packaged extension so
 * the popup never depends on relative paths escaping the extension root.
 */
import { projectSnapshot, projectElementFingerprint } from './snapshot.js'

const REF_TTL_MS = 10 * 60 * 1000
const MAX_REFS = 500
const MAX_PAGE_ACTION_TIMEOUT_MS = 30000
const MAX_SELECT_OPTIONS = 30

const ERROR_CODES = {
  ELEMENT_NOT_FOUND: 'The requested element reference is not known to this page.',
  ELEMENT_STALE: 'The element reference is stale. Take a new snapshot.',
  ELEMENT_AMBIGUOUS: 'The target field is ambiguous and must be clarified before it can be changed.',
  ELEMENT_NOT_EDITABLE: 'The target does not accept text input.',
  ELEMENT_NOT_SELECT: 'The target is not a select element.',
  TAB_UNAVAILABLE: 'The target tab is not available.',
  TIMEOUT: 'The page did not reach the requested state in time.',
  INVALID_PARAMS: 'The bridge request parameters are invalid.',
  INTERNAL: 'The page agent failed to complete the operation.',
}

export class PageActionError extends Error {
  constructor(code, message) {
    super(message || ERROR_CODES[code] || code)
    this.name = 'PageActionError'
    this.code = code
  }
}

const clean = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------
// Reference registry
// ---------------------------------------------------------------------------------------------

/**
 * Binds DOM nodes to opaque references for the lifetime of one document.
 * `nodeIds` is a WeakMap so a node replaced by an identical clone still fails verification.
 */
export function createRefStore(options = {}) {
  const ttlMs = options.ttlMs ?? REF_TTL_MS
  const max = options.max ?? MAX_REFS
  const now = options.now ?? Date.now
  const refs = new Map()
  const nodeIds = new WeakMap()

  const revisionOf = () => `${options.revision ? options.revision() : 'r0'}`

  function prune() {
    const current = now()
    for (const [ref, entry] of refs) {
      // Drop expired references and references to nodes that already left the document, so the
      // registry cannot accumulate dead entries in a long-lived tab.
      if (current - entry.createdAt > ttlMs || !entry.element?.isConnected) refs.delete(ref)
    }
    while (refs.size > max) refs.delete(refs.keys().next().value)
  }

  function create(element, meta = {}) {
    prune()
    const ref = `c-${Math.random().toString(36).slice(2, 10)}${now().toString(36).slice(-4)}`
    refs.set(ref, { ref, element, createdAt: now(), revision: revisionOf(), ...meta })
    nodeIds.set(element, ref)
    // Enforce the bound after inserting so the registry can never briefly exceed it.
    while (refs.size > max) refs.delete(refs.keys().next().value)
    return ref
  }

  function get(ref) {
    const entry = refs.get(ref)
    if (!entry) return undefined
    if (now() - entry.createdAt > ttlMs) { refs.delete(ref); return undefined }
    return entry
  }

  /**
   * Resolve a reference to a live element, or throw a precise bridge error.
   * Every failure mode the agent can hit has its own code so the model can react correctly.
   */
  function resolve(ref, expectedTabId) {
    if (typeof ref !== 'string' || ref.length === 0) throw new PageActionError('INVALID_PARAMS', 'A snapshot ref is required.')
    const entry = get(ref)
    // An unknown ref means either the snapshot was never taken, the entry expired, or the page
    // reloaded and the registry is gone. Distinguish "unknown" from "known but no longer valid".
    if (!entry) throw new PageActionError('ELEMENT_NOT_FOUND', 'The reference is unknown, expired, or belongs to a previous document. Take a new snapshot.')
    if (expectedTabId !== undefined && entry.tabId !== undefined && entry.tabId !== expectedTabId) {
      throw new PageActionError('ELEMENT_STALE', 'The reference belongs to a different tab.')
    }
    // A stale revision means the document navigated after the snapshot was taken.
    if (entry.revision !== revisionOf()) throw new PageActionError('ELEMENT_STALE', 'The page navigated after this reference was created. Take a new snapshot.')
    // Identity is checked before connectivity: a replaced node is both detached and unknown to the
    // registry, and "replaced" is the more useful diagnosis.
    // Connectivity is the primary invariant: a node that a swap or removal detached is no longer
    // a legitimate action target, whatever its fingerprint still says.
    if (!entry.element.isConnected) throw new PageActionError('ELEMENT_STALE', 'The element is no longer in the page. It was removed or replaced after this reference was created. Take a new snapshot.')
    // Identity is the secondary invariant and catches a node moved to a detached subtree.
    if (nodeIds.get(entry.element) !== ref) throw new PageActionError('ELEMENT_STALE', 'The element identity changed after this reference was created. Take a new snapshot.')
    return entry
  }

  return { create, get, resolve, prune, clear: () => refs.clear(), get size() { return refs.size } }
}

// ---------------------------------------------------------------------------------------------
// Page observation helpers
// ---------------------------------------------------------------------------------------------

/**
 * True when an ancestor with clipped overflow hides the element entirely.
 * Chrome still reports a non-zero client rect for content that is clipped away, so the rects have
 * to be intersected against every clipping ancestor's padding box.
 */
function isClippedAway(element, box) {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const clips = style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.contain === 'paint'
    if (!clips) continue
    const rect = node.getBoundingClientRect()
    const left = rect.left + node.clientLeft
    const top = rect.top + node.clientTop
    const right = left + node.clientWidth
    const bottom = top + node.clientHeight
    box = {
      left: Math.max(box.left, left),
      top: Math.max(box.top, top),
      right: Math.min(box.right, right),
      bottom: Math.min(box.bottom, bottom),
    }
    if (box.right <= box.left || box.bottom <= box.top) return true
  }
  return false
}

/**
 * True when an element can be interacted with.
 * This mirrors the standard "non-empty bounding box and not visibility:hidden" rule, plus a clip
 * check: Chrome reports a non-zero client rect for content that an ancestor clips away entirely.
 */
export function isVisible(element) {
  if (!element?.isConnected) return false
  if (element.closest('[hidden],[aria-hidden="true"]')) return false
  if (element.offsetParent === null) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const box = {
    left: Math.max(rect.left, 0),
    top: Math.max(rect.top, 0),
    right: Math.min(rect.right, viewportWidth),
    bottom: Math.min(rect.bottom, viewportHeight),
  }
  if (box.right <= box.left || box.bottom <= box.top) return false
  return !isClippedAway(element, box)
}

function isEditable(element) {
  if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') return true
  if (element.tagName === 'TEXTAREA') return true
  if (element.tagName !== 'INPUT') return false
  const type = (element.getAttribute('type') || 'text').toLowerCase()
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image', 'hidden'].includes(type)
}

function isSelect(element) {
  return element.tagName === 'SELECT'
}

/** Set a value through the prototype setter so framework state stays in sync. */
function setNativeValue(element, value) {
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  const own = Object.getOwnPropertyDescriptor(element, 'value')
  if (own?.set) own.set.call(element, value)
  else if (descriptor?.set) descriptor.set.call(element, value)
  else element.value = value
}

function dispatchInputEvents(element, { input = true, change = true } = {}) {
  if (input) element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  if (change) element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

function selectOption(element, value) {
  const wanted = clean(value, 200).toLowerCase()
  const options = [...element.options]
  const match = options.find(option => option.value.toLowerCase() === wanted)
    ?? options.find(option => clean(option.text, 200).toLowerCase() === wanted)
    ?? options.find(option => clean(option.label, 200).toLowerCase() === wanted)
    ?? options.find(option => option.value.toLowerCase().includes(wanted) && wanted.length >= 2)
  if (!match) {
    throw new PageActionError('INVALID_PARAMS', `No option matched "${clean(value, 80)}". Available: ${options.slice(0, MAX_SELECT_OPTIONS).map(option => clean(option.text, 40)).join(', ')}`)
  }
  element.value = match.value
  if (element.value !== match.value) throw new PageActionError('INVALID_PARAMS', 'The select element rejected the option value.')
  dispatchInputEvents(element)
  return { selectedValue: match.value, selectedText: clean(match.text, 120) }
}

function pressKey(element, key) {
  const definition = KEY_DEFINITIONS[String(key || '').toLowerCase()] ?? (/^[a-z0-9]$/i.test(String(key)) ? { key: String(key) } : undefined)
  if (!definition) throw new PageActionError('INVALID_PARAMS', `Unsupported key: ${clean(key, 40)}`)
  const init = { key: definition.key, code: definition.code ?? '', bubbles: true, cancelable: true, composed: true, ...definition }
  const allowed = element.dispatchEvent(new KeyboardEvent('keydown', init))
  element.dispatchEvent(new KeyboardEvent('keypress', init))
  if (allowed !== false) applyKeyValue(element, definition)
  element.dispatchEvent(new KeyboardEvent('keyup', init))
  return { pressed: definition.key }
}

const KEY_DEFINITIONS = {
  enter: { key: 'Enter', code: 'Enter' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  ' ': { key: ' ', code: 'Space' },
}

/** Apply the DOM effect of a pressed key so synthetic presses still change state. */
function applyKeyValue(element, definition) {
  if (!isEditable(element) && !element.isContentEditable) return
  const isContentEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true'
  const current = isContentEditable ? element.textContent || '' : element.value || ''
  let next = current
  if (definition.key === 'Backspace') next = current.slice(0, -1)
  else if (definition.key === 'Delete') next = current.slice(1)
  else if (definition.key.length === 1) next = current + definition.key
  else return
  if (isContentEditable) element.textContent = next
  else setNativeValue(element, next)
  dispatchInputEvents(element, { change: false })
}

// ---------------------------------------------------------------------------------------------
// Page agent
// ---------------------------------------------------------------------------------------------

export function createPageAgent(options = {}) {
  const doc = options.document ?? document
  const store = options.store ?? createRefStore({ revision: () => navigationId })
  const activeTimeouts = new Set()
  let navigationId = 0
  let lastHref = doc.location?.href ?? ''
  /**
   * This document's own Chrome tab id. Every request must name the same tab: without this check a
   * reference captured in one tab could be serviced by a different tab that happens to have a
   * similar DOM, which would silently act on the wrong page.
   */
  let tabId = typeof options.tabId === 'number' ? options.tabId : undefined
  let tabIdPromise

  function resolveTabId() {
    if (tabId !== undefined) return Promise.resolve(tabId)
    if (!tabIdPromise) {
      tabIdPromise = (async () => {
        try {
          const response = await chrome.runtime.sendMessage({ channel: 'dsh-chrome-bridge', method: 'whoami' })
          if (typeof response?.tabId === 'number') tabId = response.tabId
        } catch { /* outside an extension context: tab checks are skipped */ }
        return tabId
      })()
    }
    return tabIdPromise
  }

  /** Reject a request that names a different tab than the one this document belongs to. */
  function assertTab(params) {
    if (params.tabId === undefined) return
    // Before the id is known, resolve it so the check is never silently skipped in production.
    if (tabId === undefined) return
    if (tabId !== params.tabId) {
      throw new PageActionError('ELEMENT_STALE', `This page belongs to tab ${tabId}, not tab ${params.tabId}. Take a snapshot from the intended tab.`)
    }
  }

  const track = promise => { activeTimeouts.add(promise); promise.finally(() => activeTimeouts.delete(promise)); return promise }

  const wait = ms => {
    const promise = sleep(Math.max(0, Math.min(Number(ms) || 0, MAX_PAGE_ACTION_TIMEOUT_MS)))
    return track(promise)
  }

  /** Bump the revision when the document navigates or the history changes. */
  function checkNavigation() {
    const href = doc.location?.href ?? ''
    if (href !== lastHref) {
      lastHref = href
      navigationId += 1
      store.clear()
      return true
    }
    return false
  }

  /**
   * Check the interaction preconditions that `resolve` does not cover.
   * Element identity and connectivity are owned by `resolve`, which reports "replaced" or
   * "removed" precisely; duplicating those checks here would mask the better diagnosis.
   */
  function assertActionable(element, { requireVisible = true } = {}) {
    if (requireVisible && !isVisible(element)) throw new PageActionError('ELEMENT_STALE', 'The element is hidden, so it cannot be operated safely.')
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new PageActionError('INVALID_PARAMS', 'The element is disabled. It cannot be operated until the page enables it.')
  }

  /** Verify the semantic identity captured at snapshot time still describes this element. */
  function assertUnchanged(entry) {
    const fingerprint = projectElementFingerprint(entry.element)
    if (fingerprint.role !== entry.role || fingerprint.name !== entry.name) {
      throw new PageActionError('ELEMENT_STALE', 'The element semantics changed after this reference was created.')
    }
    return fingerprint
  }

  function snapshot(params = {}) {
    checkNavigation()
    // Prefer this document's own tab id over whatever the caller claimed, so a mis-routed request
    // stores refs that can never be validated against the wrong tab later.
    const ownerTabId = tabId ?? params.tabId
    const limit = Math.min(Math.max(Number(params.limit) || 80, 1), 200)
    const mode = params.mode === 'form' ? 'form' : 'interactive'
    const root = doc.body ?? doc.documentElement
    const raw = projectSnapshot(root, { max: limit, includeCandidates: Boolean(params.includeCandidates), scoped: false, mode })
    pruneStaleEntries()
    const elements = raw.elements.map(item => {
      const { node, ...rest } = item
      if (!node) return undefined
      const ref = store.create(node, {
        role: rest.role,
        name: rest.name,
        path: rest.path,
        fieldContext: rest.fieldContext,
        tabId: ownerTabId,
      })
      return { ref, ...rest }
    }).filter(Boolean)
    return {
      mode,
      url: doc.location?.href ?? params.url ?? '',
      title: clean(doc.title, 300),
      headings: raw.headings,
      forms: raw.forms,
      elements,
      totalInteractive: raw.totalInteractive,
      candidateCount: raw.candidateCount,
      returned: elements.length,
      truncated: Boolean(raw.truncated),
    }
  }

  /** Drop references whose nodes were removed, so the registry cannot grow without bound. */
  function pruneStaleEntries() {
    store.prune()
  }

  async function act(params = {}) {
    checkNavigation()
    assertTab(params)
    const action = params.action
    if (!['click', 'fill', 'select', 'press'].includes(action)) throw new PageActionError('INVALID_PARAMS', 'Unsupported page action.')
    const entry = store.resolve(params.ref, params.tabId)
    // Verify semantic identity before anything else: a ref whose element now means something else
    // must never be acted on, even if the action would also fail for another reason.
    assertUnchanged(entry)
    assertActionable(entry.element, { requireVisible: action !== 'press' })
    if (['fill', 'select', 'press'].includes(action) && typeof params.value !== 'string') {
      throw new PageActionError('INVALID_PARAMS', `The ${action} action requires a value.`)
    }
    // Ambiguous fields must be clarified by a narrower snapshot instead of being guessed at.
    if ((action === 'fill' || action === 'select') && entry.fieldContext?.confidence === 'ambiguous') {
      throw new PageActionError('ELEMENT_AMBIGUOUS', ERROR_CODES.ELEMENT_AMBIGUOUS)
    }
    if (action === 'fill' && !isEditable(entry.element)) throw new PageActionError('ELEMENT_NOT_EDITABLE', ERROR_CODES.ELEMENT_NOT_EDITABLE)
    if (action === 'select' && !isSelect(entry.element)) throw new PageActionError('ELEMENT_NOT_SELECT', ERROR_CODES.ELEMENT_NOT_SELECT)
    try { entry.element.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* non-layout documents */ }

    let detail = {}
    if (action === 'click') {
      entry.element.focus?.({ preventScroll: true })
      entry.element.click()
    } else if (action === 'fill') {
      const isContentEditable = entry.element.isContentEditable || entry.element.getAttribute('contenteditable') === 'true'
      entry.element.focus?.({ preventScroll: true })
      if (isContentEditable) {
        entry.element.textContent = params.value
        dispatchInputEvents(entry.element)
      } else {
        setNativeValue(entry.element, params.value)
        dispatchInputEvents(entry.element)
      }
      detail.valueLength = params.value.length
    } else if (action === 'select') {
      entry.element.focus?.({ preventScroll: true })
      detail = selectOption(entry.element, params.value)
    } else if (action === 'press') {
      entry.element.focus?.({ preventScroll: true })
      detail = pressKey(entry.element, params.value)
    }

    // A click may navigate or replace the DOM; report it so the caller knows refs are invalidated.
    await wait(0)
    const navigated = checkNavigation()
    return { ok: true, action, url: doc.location?.href ?? '', title: clean(doc.title, 300), navigated, ...detail }
  }

  async function waitForCondition(params = {}) {
    assertTab(params)
    const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 8000, 1), MAX_PAGE_ACTION_TIMEOUT_MS)
    const deadline = Date.now() + timeoutMs
    const wanted = clean(params.text, 200)
    const pattern = clean(params.url, 300)
    if (!wanted && !pattern) throw new PageActionError('INVALID_PARAMS', 'Provide text or url to wait for.')
    let matchedText = false
    let matchedUrl = false
    for (;;) {
      checkNavigation()
      if (wanted && !matchedText) {
        const body = doc.body?.innerText ?? ''
        if (body.includes(wanted)) matchedText = true
      }
      if (pattern && !matchedUrl) {
        try { matchedUrl = new RegExp(pattern).test(doc.location?.href ?? '') } catch { matchedUrl = (doc.location?.href ?? '').includes(pattern) }
      }
      if ((!wanted || matchedText) && (!pattern || matchedUrl)) {
        return { matchedText, matchedUrl, url: doc.location?.href ?? '', title: clean(doc.title, 300) }
      }
      if (Date.now() >= deadline) throw new PageActionError('TIMEOUT', `The page did not reach the requested state within ${timeoutMs} ms.`)
      await wait(150)
    }
  }

  return {
    snapshot,
    act,
    wait: waitForCondition,
    info: () => ({
      url: doc.location?.href ?? '',
      title: clean(doc.title, 300),
      readyState: doc.readyState,
      navigationId,
      tabId,
      refs: store.size,
    }),
    /** Learn and remember this document's tab id before the first operation. */
    resolveTabId,
    /** Force all outstanding references to expire, e.g. after a history navigation. */
    invalidate() {
      navigationId += 1
      lastHref = doc.location?.href ?? ''
      store.clear()
    },
    get navigationId() { return navigationId },
    dispose() { store.clear() },
  }
}

// ---------------------------------------------------------------------------------------------
// Content-script transport glue
// ---------------------------------------------------------------------------------------------

/* c8 ignore start -- exercised only inside a real Chrome content-script context */
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const agent = createPageAgent()

  // A history navigation can replace the document contents without a reload. Expire references.
  for (const eventName of ['popstate', 'hashchange']) {
    window.addEventListener(eventName, () => agent.invalidate(), true)
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== 'dsh-chrome-bridge') return false
    const respond = async () => {
      try {
        // Learn which tab this document belongs to before answering anything, so every page
        // operation can prove it is servicing the tab the server intended.
        await agent.resolveTabId()
        if (message.method === 'page.info') return { ok: true, result: agent.info() }
        if (message.method === 'page.snapshot') return { ok: true, result: agent.snapshot(message.params ?? {}) }
        if (message.method === 'page.act') return { ok: true, result: await agent.act(message.params ?? {}) }
        if (message.method === 'page.wait') return { ok: true, result: await agent.wait(message.params ?? {}) }
        return { ok: false, error: { code: 'INVALID_PARAMS', message: `Unsupported page method: ${String(message.method)}` } }
      } catch (error) {
        const code = error instanceof PageActionError ? error.code : 'INTERNAL'
        return { ok: false, error: { code, message: clean(error?.message || 'The page agent failed.', 500) } }
      }
    }
    respond().then(sendResponse).catch(() => sendResponse({ ok: false, error: { code: 'INTERNAL', message: 'The page agent failed.' } }))
    return true
  })
}
/* c8 ignore stop */
