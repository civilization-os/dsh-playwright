/**
 * DSH Chrome Bridge - Content Script
 * Executes DOM snapshot, element identification, and safe page actions.
 */

(() => {
  if (window.__DSH_BRIDGE_LOADED__) return
  window.__DSH_BRIDGE_LOADED__ = true

  if (!window.__DSH_REFS__) {
    window.__DSH_REFS__ = new Map()
  }

  // --- Snapshot Engine (Adapted directly from src/snapshot.js) ---
  function projectSnapshot(root, options = {}) {
    const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 200)
    const visible = element => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const text = element => normalize(element?.innerText || element?.textContent)
    const referencedText = value => normalize(String(value || '').split(/\s+/).map(id => text(document.getElementById(id))).filter(Boolean).join(' '))
    const semantics = element => {
      const ariaLabel = normalize(element.getAttribute('aria-label'))
      if (ariaLabel) return { name: ariaLabel, source: 'aria-label' }
      const labelled = referencedText(element.getAttribute('aria-labelledby'))
      if (labelled) return { name: labelled, source: 'aria-labelledby' }
      const labels = normalize([...element.labels || []].map(text).filter(Boolean).join(' '))
      if (labels) return { name: labels, source: 'label' }
      const placeholder = normalize(element.getAttribute('placeholder'))
      if (placeholder) return { name: placeholder, source: 'placeholder' }
      const inputValue = element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase()) ? normalize(element.value) : ''
      if (inputValue) return { name: inputValue, source: 'value' }
      const ownText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : text(element)
      if (ownText) return { name: ownText, source: 'content' }
      const title = normalize(element.getAttribute('title'))
      if (title) return { name: title, source: 'title' }
      return { name: '', source: '' }
    }
    const regionName = element => {
      const ariaLabel = normalize(element?.getAttribute('aria-label'))
      if (ariaLabel) return ariaLabel
      const labelled = referencedText(element?.getAttribute('aria-labelledby'))
      if (labelled) return labelled
      const legend = element?.matches('fieldset') ? element.querySelector(':scope > legend') : undefined
      if (legend && text(legend)) return text(legend)
      const heading = element?.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > [role="heading"]')
      return text(heading)
    }
    const role = element => {
      const explicit = element.getAttribute('role')
      if (explicit) return explicit
      if (element.tagName === 'INPUT') return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', file: 'button' })[(element.type || 'text').toLowerCase()] || 'textbox'
      return ({ A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'listitem', SUMMARY: 'button', LABEL: 'label' }[element.tagName] || element.tagName.toLowerCase())
    }
    const path = element => {
      const parts = []
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const siblings = [...node.parentElement.children].filter(item => item.tagName === node.tagName)
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`)
      }
      return `body>${parts.join('>')}`
    }
    const within = selector => root === document.body ? [...root.querySelectorAll(selector)] : [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]
    const isField = element => element.matches('input:not([type="hidden"]),textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[role="spinbutton"]')
    const confidence = (score, margin, hasSecond) => score >= 84 && (!hasSecond || margin >= 10) ? 'high' : score >= 64 && (!hasSecond || margin >= 6) ? 'medium' : hasSecond && margin < 6 ? 'ambiguous' : 'low'
    const groupName = element => {
      const fieldset = element.closest('fieldset')
      if (fieldset && regionName(fieldset)) return regionName(fieldset)
      const group = element.closest('[role="group"],[role="radiogroup"],[role="form"]')
      if (group && regionName(group)) return regionName(group)
      const section = element.closest('section,form,[role="dialog"]')
      return regionName(section)
    }
    const candidateElements = within('label,legend,th,td,dt,p,span,div,strong,b,small,h1,h2,h3,h4,h5,h6')
      .filter(element => visible(element) && !element.matches('[aria-hidden="true"]'))
      .filter(element => {
        const value = text(element)
        if (!value || value.length > 160) return false
        const controls = element.querySelectorAll('input,textarea,select,[contenteditable="true"]')
        return controls.length === 0
      })
    const inferField = element => {
      const direct = semantics(element)
      const result = {
        labelSource: direct.source || undefined,
        confidence: direct.source === 'placeholder' ? 'low' : direct.name ? 'high' : undefined,
        group: groupName(element) || undefined,
        helpText: referencedText(element.getAttribute('aria-describedby')) || undefined,
        required: element.matches('[required],[aria-required="true"]') || undefined,
        inputType: element.tagName === 'INPUT' ? (element.getAttribute('type') || 'text').toLowerCase() : element.tagName.toLowerCase(),
        autocomplete: element.getAttribute('autocomplete') || undefined,
        fieldName: element.getAttribute('name') || undefined,
      }
      if (direct.name) {
        result.inferredLabel = direct.name
        if (element.tagName === 'SELECT' && options.mode === 'form') result.options = [...element.options].slice(0, 30).map(option => normalize(option.text)).filter(Boolean)
        return result
      }

      const scored = []
      const add = (candidate, score, source) => {
        const value = text(candidate)
        if (!value || value.length > 160 || candidate.matches('style,script,noscript,template')) return
        if (candidate.contains(element) || element.contains(candidate)) return
        if (candidate.querySelector('input,textarea,select,[contenteditable="true"]')) return
        const existing = scored.find(item => item.text === value)
        if (!existing || score > existing.score) {
          if (existing) scored.splice(scored.indexOf(existing), 1)
          scored.push({ text: value, score, source })
        }
      }
      const cell = element.closest('th,td')
      if (cell?.parentElement) {
        const cells = [...cell.parentElement.children]
        for (const previous of cells.slice(0, cells.indexOf(cell))) add(previous, previous.tagName === 'TH' ? 96 : 90, 'table-cell')
        const table = cell.closest('table')
        const column = cells.indexOf(cell)
        for (const row of [...table?.querySelectorAll('tr') || []]) {
          if (row === cell.parentElement) break
          const header = row.children[column]
          if (header?.tagName === 'TH') add(header, 94, 'table-header')
        }
      }
      let branch = element
      for (let level = 0; branch?.parentElement && level < 3; level += 1, branch = branch.parentElement) {
        let previous = branch.previousElementSibling
        for (let offset = 0; previous && offset < 2; offset += 1, previous = previous.previousElementSibling) add(previous, 91 - level * 7 - offset * 6, 'preceding-content')
      }

      const target = element.getBoundingClientRect()
      const targetX = target.left + target.width / 2
      const targetY = target.top + target.height / 2
      for (const candidate of candidateElements) {
        if (candidate.contains(element) || element.contains(candidate)) continue
        const box = candidate.getBoundingClientRect()
        const centerX = box.left + box.width / 2
        const centerY = box.top + box.height / 2
        const sameRegion = candidate.closest('form,fieldset,section,[role="dialog"],[role="form"],[role="group"]') === element.closest('form,fieldset,section,[role="dialog"],[role="form"],[role="group"]')
        if (!sameRegion) continue
        const verticalOverlap = Math.max(0, Math.min(box.bottom, target.bottom) - Math.max(box.top, target.top))
        const horizontalOverlap = Math.max(0, Math.min(box.right, target.right) - Math.max(box.left, target.left))
        const leftGap = target.left - box.right
        if (leftGap >= -8 && leftGap <= 320 && (verticalOverlap > 0 || Math.abs(centerY - targetY) <= Math.max(target.height, box.height))) {
          add(candidate, 86 - leftGap / 12 - Math.abs(centerY - targetY) / 10, 'nearby-left')
        }
        const aboveGap = target.top - box.bottom
        if (aboveGap >= -8 && aboveGap <= 150 && (horizontalOverlap > 0 || Math.abs(centerX - targetX) <= Math.max(target.width, 140))) {
          add(candidate, 78 - aboveGap / 10 - Math.abs(centerX - targetX) / 30, 'nearby-above')
        }
      }
      scored.sort((a, b) => b.score - a.score)
      const best = scored[0]
      const next = scored.find(item => item.text !== best?.text)
      if (best) {
        const level = confidence(best.score, best.score - (next?.score ?? 0), Boolean(next))
        result.confidence = level
        if (level !== 'ambiguous') {
          result.inferredLabel = best.text
          result.labelSource = best.source
        }
        if (level === 'ambiguous' || level === 'low') result.labelCandidates = scored.slice(0, 3).map(item => ({ text: item.text, source: item.source }))
      }
      if (!result.helpText) {
        const wrapper = element.closest('.field,.form-item,[class*="field"],[class*="form-item"]') || element.parentElement
        const helper = wrapper?.querySelector('.help,.hint,[class*="help"],[class*="hint"],small')
        if (helper && !helper.contains(element)) result.helpText = text(helper) || undefined
      }
      if (element.tagName === 'SELECT' && options.mode === 'form') result.options = [...element.options].slice(0, 30).map(option => normalize(option.text)).filter(Boolean)
      return result
    }

    const primarySelector = 'a[href],button,input,textarea,select,[role],[contenteditable="true"],summary,label[for],[tabindex]'
    const primary = within(primarySelector).filter(visible)
    const primarySet = new Set(primary)
    const scopeTarget = options.scoped && root !== document.body ? root : undefined
    const candidates = [...new Set([...(scopeTarget ? [scopeTarget] : []), ...within('[onclick],li,div,span')])].filter(element => {
      if (!visible(element) || primarySet.has(element)) return false
      if (element === scopeTarget) return true
      if (!semantics(element).name) return false
      if (element.hasAttribute('onclick')) return true
      const pointer = getComputedStyle(element).cursor === 'pointer'
      return pointer && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== 'pointer')
    })
    const all = [...new Set([...primary, ...(options.includeCandidates ? candidates : [])])]
    const semanticCounts = new Map()
    for (const element of all.filter(isField)) {
      const value = semantics(element).name
      if (value) semanticCounts.set(value, (semanticCounts.get(value) || 0) + 1)
    }
    const elements = all.slice(0, options.max || 80).map(element => {
      const semantic = semantics(element)
      const enrich = isField(element) && (options.mode === 'form' || !semantic.name || semantic.source === 'placeholder' || semanticCounts.get(semantic.name) > 1)
      const valueState = element.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]')
        ? (element.checked || element.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked')
        : element.tagName === 'SELECT' ? normalize(element.selectedOptions?.[0]?.text) || 'selected' : element.matches('input,textarea,[contenteditable="true"]') && element.value ? 'has-value' : undefined
      return {
        node: element,
        path: path(element), role: role(element), name: semantic.name.slice(0, 160), nameSource: semantic.source || undefined,
        disabled: Boolean(element.disabled), candidate: !primarySet.has(element), scopeTarget: element === scopeTarget,
        isContentEditable: Boolean(element.isContentEditable || element.getAttribute('contenteditable') === 'true'),
        valueState,
        fieldContext: enrich ? inferField(element) : undefined,
      }
    })
    const headings = within('h1,h2,h3,[role="heading"]').filter(visible).slice(0, 20).map(element => text(element))
    const forms = options.mode === 'form' ? within('form,fieldset,[role="form"],[role="group"],[role="radiogroup"]').filter(visible).slice(0, 20).map(element => ({
      name: regionName(element),
      fieldCount: element.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[role="spinbutton"]').length,
    })) : undefined
    return { elements, headings, forms, totalInteractive: all.length, candidateCount: candidates.length, truncated: all.length > (options.max || 80) }
  }

  function generateRefId() {
    return 'e-' + Math.random().toString(36).slice(2, 10)
  }

  // --- Handlers for Agent Actions ---
  function handleSnapshot(params = {}) {
    const root = params.scopeCss ? document.querySelector(params.scopeCss) || document.body : document.body
    const options = {
      max: params.limit || 80,
      includeCandidates: Boolean(params.includeCandidates),
      scoped: Boolean(params.scopeCss),
      mode: params.mode || 'interactive',
    }

    const projection = projectSnapshot(root, options)
    const elements = []

    // Prune stale references if cache exceeds 1000
    if (window.__DSH_REFS__.size > 1000) {
      window.__DSH_REFS__.clear()
    }

    for (const item of projection.elements) {
      const ref = generateRefId()
      window.__DSH_REFS__.set(ref, {
        element: item.node,
        role: item.role,
        name: item.name,
        isContentEditable: item.isContentEditable,
        path: item.path,
        createdAt: Date.now(),
      })

      elements.push({
        ref,
        role: item.role,
        name: item.name,
        nameSource: item.nameSource,
        disabled: item.disabled,
        candidate: item.candidate || undefined,
        scopeTarget: item.scopeTarget || undefined,
        valueState: item.valueState,
        fieldContext: item.fieldContext,
      })
    }

    return {
      snapshotId: 's-' + Math.random().toString(36).slice(2, 10),
      url: window.location.href,
      title: document.title,
      mode: options.mode,
      scopeCss: params.scopeCss,
      headings: projection.headings,
      forms: projection.forms,
      elements,
      totalInteractive: projection.totalInteractive,
      candidateCount: projection.candidateCount,
      returned: elements.length,
      truncated: projection.truncated,
    }
  }

  async function setElementText(el, value, target) {
    if (el.disabled || el.readOnly) {
      throw { code: 'ELEMENT_DISABLED', message: 'Target element is disabled or read-only and cannot be edited.' }
    }

    const opStart = Date.now()
    const targetText = String(value ?? '')

    const isContentEditable = Boolean(
      target?.isContentEditable ||
      el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('data-lexical-editor') === 'true' ||
      el.getAttribute('role') === 'textbox' ||
      el.classList?.contains('uV2eYG_input')
    )

    if (!isContentEditable && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      // 1. React / Vue / Angular controlled input bypass
      const prototype = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (nativeSetter) {
        nativeSetter.call(el, targetText)
      } else {
        el.value = targetText
      }
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: targetText }))
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: targetText }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { strategy: 'native_setter', settledMs: Date.now() - opStart }
    }

    // 2. Rich Text / Lexical / ProseMirror / Slate / contenteditable Engine
    // Focus activation: only dispatch pointer sequence if pristine and completely empty, and NEVER dispatch synthetic click
    if (document.activeElement !== el) {
      if (el.childNodes.length === 0) {
        try {
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
          el.focus?.()
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }))
        } catch {}
      } else {
        el.focus?.()
      }
    }

    function normalize(str) {
      return String(str ?? '')
        .replace(/[\u200B\uFEFF\r]/g, '')
        .replace(/\u00A0/g, ' ')
        .trim()
    }

    function readNormalizedText() {
      return normalize(el.innerText || el.textContent || '')
    }

    const normExpected = normalize(targetText)
    const initialText = readNormalizedText()

    function establishSelection() {
      try {
        const sel = window.getSelection()
        if (!sel) return
        sel.removeAllRanges()
        const range = document.createRange()
        const targetContainer = el.querySelector('p, div, span') || el
        if (targetContainer.childNodes.length === 0) {
          range.setStart(targetContainer, 0)
          range.setEnd(targetContainer, 0)
        } else {
          range.selectNodeContents(targetContainer)
        }
        sel.addRange(range)
      } catch {}
    }

    // Exact equality check for replacement semantics (current === normExpected)
    async function waitForTextSettled(maxWaitMs = 160) {
      const startTime = Date.now()
      while (Date.now() - startTime < maxWaitMs) {
        const current = readNormalizedText()
        if (normExpected === '') {
          if (current === '') return true
        } else if (current === normExpected) {
          return true
        }
        // Yield to microtasks & DOM reconciliation (e.g. Lexical MutationObserver / React render)
        await new Promise(r => setTimeout(r, 15))
      }
      const finalVal = readNormalizedText()
      return normExpected === '' ? finalVal === '' : finalVal === normExpected
    }

    // Strategy A: document.execCommand('insertText')
    // In Chromium, execCommand triggers a native isTrusted beforeinput event that Lexical and ProseMirror reconcilers intercept.
    establishSelection()
    let strategyASuccess = false
    try {
      strategyASuccess = document.execCommand('insertText', false, targetText)
    } catch {}

    if (strategyASuccess) {
      const okA = await waitForTextSettled(160)
      if (okA) return { strategy: 'A_execCommand', settledMs: Date.now() - opStart }
    }

    // Strategy B: Synthetic InputEvent('beforeinput') + InputEvent('input')
    establishSelection()
    try {
      const beforeInputEvt = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: targetText ? 'insertText' : 'deleteContentBackward',
        data: targetText || null,
      })
      el.dispatchEvent(beforeInputEvt)
      const inputEvt = new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        inputType: targetText ? 'insertText' : 'deleteContentBackward',
        data: targetText || null,
      })
      el.dispatchEvent(inputEvt)
    } catch {}

    const okB = await waitForTextSettled(120)
    if (okB) return { strategy: 'B_synthetic_input', settledMs: Date.now() - opStart }

    // Strategy C: Synthetic ClipboardEvent('paste') with DataTransfer
    establishSelection()
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', targetText)
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      })
      el.dispatchEvent(pasteEvt)
    } catch {}

    const okC = await waitForTextSettled(120)
    if (okC) return { strategy: 'C_synthetic_paste', settledMs: Date.now() - opStart }

    // Strategy D: DOM scaffolding fallback (specifically for Lexical root with 0 children)
    try {
      if (el.getAttribute('data-lexical-editor') === 'true' && el.children.length === 0) {
        const p = document.createElement('p')
        p.setAttribute('dir', 'ltr')
        const span = document.createElement('span')
        span.setAttribute('data-lexical-text', 'true')
        span.textContent = targetText
        p.appendChild(span)
        el.appendChild(p)
      } else {
        el.innerText = targetText
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } catch {}

    const okD = await waitForTextSettled(60)
    if (okD) return { strategy: 'D_dom_scaffold', settledMs: Date.now() - opStart }

    // Final verification check after async settling
    const finalVal = readNormalizedText()
    if (normExpected ? finalVal !== normExpected : finalVal !== '') {
      throw {
        code: 'FILL_FAILED',
        message: `Text injection failed on element (${el.tagName}, data-lexical-editor=${el.getAttribute('data-lexical-editor')}). Target editor reconciler discarded inserted text. Expected: "${normExpected}", actual content: "${finalVal}" (initial: "${initialText}")`,
      }
    }

    return { strategy: 'fallback_verified', settledMs: Date.now() - opStart }
  }

  function pressKey(el, key) {
    el.focus?.()
    const isEnter = key === 'Enter'
    const isBackspace = key === 'Backspace'
    const code = isEnter ? 'Enter' : isBackspace ? 'Backspace' : (key.length === 1 ? `Key${key.toUpperCase()}` : key)
    const keyCode = isEnter ? 13 : isBackspace ? 8 : (key.charCodeAt?.(0) || 0)
    const charCode = isEnter ? 13 : (key.charCodeAt?.(0) || 0)

    const eventInit = {
      key,
      code,
      keyCode,
      which: keyCode,
      charCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    }

    const downAllowed = el.dispatchEvent(new KeyboardEvent('keydown', eventInit))
    el.dispatchEvent(new KeyboardEvent('keypress', eventInit))

    // Special behavior for Enter in contenteditable / form
    if (isEnter && downAllowed) {
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('data-lexical-editor') === 'true') {
        try {
          document.execCommand('insertParagraph', false, null)
        } catch {}
      }
      const form = el.closest('form')
      if (form) {
        try { form.requestSubmit?.() } catch {}
      }
    }

    el.dispatchEvent(new KeyboardEvent('keyup', eventInit))
  }

  async function handleAct(params = {}) {
    const { ref, action, value, expectedText, expectedUrl } = params
    const target = window.__DSH_REFS__.get(ref)

    if (!target) {
      throw { code: 'ELEMENT_NOT_FOUND', message: `Unknown or expired element ref '${ref}'. Please refresh snapshot.` }
    }
    if (!target.element || !target.element.isConnected) {
      throw { code: 'ELEMENT_STALE', message: `Element for ref '${ref}' is no longer connected to DOM. Please re-snapshot.` }
    }

    const el = target.element

    // Scroll into view safely
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch {}

    const beforeUrl = window.location.href
    let fillMeta = null

    if (action === 'click') {
      if (el.disabled) throw { code: 'ELEMENT_DISABLED', message: 'Target element is disabled and cannot be clicked.' }
      el.focus?.()
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      el.click()
    } else if (action === 'fill') {
      fillMeta = await setElementText(el, value, target)
    } else if (action === 'select') {
      el.focus?.()
      if (el.tagName === 'SELECT') {
        el.value = value ?? ''
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        throw { code: 'INVALID_TARGET', message: 'select action requires a <select> combobox element.' }
      }
    } else if (action === 'press') {
      pressKey(el, value || 'Enter')
    } else {
      throw { code: 'UNSUPPORTED_ACTION', message: `Action '${action}' is not supported.` }
    }

    let expectedUrlMatched = false
    if (expectedUrl) {
      expectedUrlMatched = window.location.href.includes(expectedUrl)
    }

    let expectedTextMatched = false
    if (expectedText) {
      const waitStart = Date.now()
      while (Date.now() - waitStart < 2000) {
        const bodyText = document.body ? (document.body.innerText || '') : ''
        if (bodyText.includes(expectedText)) {
          expectedTextMatched = true
          break
        }
        await new Promise(r => setTimeout(r, 50))
      }
    }

    return {
      ok: true,
      url: window.location.href,
      urlChanged: beforeUrl !== window.location.href,
      strategy: fillMeta?.strategy,
      settledMs: fillMeta?.settledMs,
      expectedText,
      expectedTextMatched: expectedText ? expectedTextMatched : undefined,
      expectedUrlMatched: expectedUrl ? expectedUrlMatched : undefined,
    }
  }

  async function handleWait(params = {}) {
    const { text, url, timeoutMs = 10000 } = params
    const startTime = Date.now()

    if (!text && !url) {
      throw { code: 'INVALID_WAIT', message: 'browser_wait requires text or url parameter.' }
    }

    while (Date.now() - startTime < timeoutMs) {
      if (url && window.location.href.toLowerCase().includes(url.toLowerCase())) {
        return { ok: true, url: window.location.href, matched: 'url' }
      }
      if (text) {
        const bodyText = document.body ? document.body.innerText : ''
        if (bodyText.includes(text)) {
          return { ok: true, url: window.location.href, matched: 'text', text }
        }
      }
      await new Promise(r => setTimeout(r, 200))
    }

    throw {
      code: 'WAIT_TIMEOUT',
      message: `Wait condition timed out after ${timeoutMs}ms for ${text ? `text "${text}"` : `url "${url}"`}. Current url: ${window.location.href}`,
    }
  }

  function handleQuery(params = {}) {
    const { scopeCss, read, attribute } = params
    const el = document.querySelector(scopeCss)
    if (!el) {
      if (read === 'count') return { read, value: 0 }
      throw { code: 'ELEMENT_NOT_FOUND', message: `No element found matching selector '${scopeCss}'.` }
    }

    let value
    if (read === 'text') value = (el.innerText || el.textContent || '').trim().slice(0, 4000)
    else if (read === 'count') value = document.querySelectorAll(scopeCss).length
    else if (read === 'checked') value = Boolean(el.checked)
    else if (read === 'value') {
      if (el.type === 'password') throw { code: 'SECURITY_ERROR', message: 'Password values cannot be read.' }
      value = String(el.value || '').slice(0, 1000)
    } else if (read === 'attribute') {
      value = el.getAttribute(attribute || '')
    } else if (read === 'html') {
      value = (el.outerHTML || el.innerHTML || '').slice(0, 4000)
    } else {
      throw { code: 'INVALID_QUERY', message: `Unsupported read type '${read}'.` }
    }

    return { read, value }
  }

  // --- Chrome Message Listener ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.method === 'browser.wait') {
      handleWait(request.params)
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => sendResponse({ ok: false, error: { code: err.code || 'WAIT_FAILED', message: err.message || String(err) } }))
      return true
    }

    if (request.method === 'browser.act') {
      handleAct(request.params)
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => sendResponse({
          ok: false,
          error: {
            code: err.code || 'ACTION_FAILED',
            message: err.message || String(err),
          },
        }))
      return true
    }

    try {
      if (request.method === 'browser.snapshot') {
        const result = handleSnapshot(request.params)
        sendResponse({ ok: true, result })
      } else if (request.method === 'browser.query') {
        const result = handleQuery(request.params)
        sendResponse({ ok: true, result })
      } else if (request.method === 'ping') {
        sendResponse({ ok: true, pong: true })
      } else {
        sendResponse({ ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method '${request.method}'.` } })
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: {
          code: err.code || 'ACTION_FAILED',
          message: err.message || String(err),
        },
      })
    }
    return true
  })
})()
