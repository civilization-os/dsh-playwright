/** Build a bounded semantic projection inside the browser page. */
export function projectSnapshot(root, options) {
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 200)
  const visible = element => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = element => normalize(element?.innerText || element?.textContent)
  /** Resolve an element's tree root so id lookups work inside shadow roots. */
  const rootOf = element => element?.getRootNode?.() || document
  const referencedText = (value, element) => {
    const scope = rootOf(element)
    return normalize(String(value || '').split(/\s+/).map(id => text(scope.getElementById ? scope.getElementById(id) : document.getElementById(id))).filter(Boolean).join(' '))
  }
  const semantics = element => {
    const ariaLabel = normalize(element.getAttribute('aria-label'))
    if (ariaLabel) return { name: ariaLabel, source: 'aria-label' }
    const labelled = referencedText(element.getAttribute('aria-labelledby'), element)
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
    const labelled = referencedText(element?.getAttribute('aria-labelledby'), element)
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
  /** Walk an element's ancestors across open shadow boundaries. */
  const ancestorOf = node => node.parentElement || node.getRootNode()?.host || null
  /** closest() bounded and able to cross open shadow roots. */
  const closestDeep = (element, selector, maxDepth = 24) => {
    let node = element
    for (let depth = 0; node && depth < maxDepth; depth += 1) {
      if (node.matches?.(selector)) return node
      node = ancestorOf(node)
    }
    return null
  }
  const path = element => {
    const parts = []
    for (let node = element, depth = 0; node && node !== document.body && depth < 64; depth += 1) {
      const container = node.parentElement || node.getRootNode()
      if (!container || container === document) break
      const siblings = [...container.children].filter(item => item.tagName === node.tagName)
      // An id makes the path human-readable and stable to match on; positional parts stay primary.
      const id = node.id ? `#${String(node.id).slice(0, 60)}` : ''
      parts.unshift(`${node.tagName.toLowerCase()}${id}:nth-of-type(${siblings.indexOf(node) + 1})`)
      node = ancestorOf(node)
    }
    return `body>${parts.join('>')}`
  }
  /** Collect a root plus every open shadow root nested beneath it, breadth first. Scanned once per projection. */
  let deepRootList
  const deepRoots = node => {
    if (node === root && deepRootList) return deepRootList
    const roots = [node]
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot)
    }
    if (node === root) deepRootList = roots
    return roots
  }
  const within = selector => {
    const matches = root === document.body || !root.matches(selector) ? [] : [root]
    for (const scope of deepRoots(root)) matches.push(...scope.querySelectorAll(selector))
    return [...new Set(matches)]
  }
  const isField = element => element.matches('input:not([type="hidden"]),textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[role="spinbutton"]')
  /** Field name -> how many controls in this projection use it, so repeats are visible as evidence. */
  const fieldNameCounts = new Map()
  for (const candidate of within('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')) {
    const name = candidate.getAttribute('name')
    if (name) fieldNameCounts.set(name, (fieldNameCounts.get(name) ?? 0) + 1)
  }
  const confidence = (score, margin, hasSecond) => score >= 84 && (!hasSecond || margin >= 10) ? 'high' : score >= 64 && (!hasSecond || margin >= 6) ? 'medium' : hasSecond && margin < 6 ? 'ambiguous' : 'low'
  const groupName = element => {
    const fieldset = closestDeep(element, 'fieldset')
    if (fieldset && regionName(fieldset)) return regionName(fieldset)
    const group = closestDeep(element, '[role="group"],[role="radiogroup"],[role="form"]')
    if (group && regionName(group)) return regionName(group)
    const section = closestDeep(element, 'section,form,[role="dialog"]')
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
  /**
   * Placeholder or title values that carry no field meaning. They are real page text, but they
   * must never be reported as the field name and must never stop contextual inference.
   * Covers the English and Chinese phrasing that real forms use for "fill this in".
   */
  const GENERIC_HINT = new RegExp(
    '^(?:'
    + '(?:please\\s+)?(?:select|choose|enter|input|type|fill(?:\\s+in)?|search|pick)'
    + '(?:\\s+(?:one|an?\\s+option|a\\s+value|here|now|it|something|text|option|item|value))?'
    + '|(?:请|請)?(?:選擇|选择|選填|填寫|填写|輸入|输入|搜尋|搜索|查詢|查询|查找)'
    + ')[\\s.!:…，。、]*$', 'i',
  )
  const isGenericHint = value => !value || GENERIC_HINT.test(value)
  const inferField = element => {
    // Strong semantics: names explicitly associated with the control.
    const strong = normalize(element.getAttribute('aria-label'))
      || referencedText(element.getAttribute('aria-labelledby'), element)
      || normalize([...element.labels || []].map(text).filter(Boolean).join(' '))
      || (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase()) ? normalize(element.value) : '')
    // Weak semantics: authored hints and nearby prose.
    const hint = normalize(element.getAttribute('placeholder')) || normalize(element.getAttribute('title'))
    const visibleHint = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : text(element)
    const result = {
      group: groupName(element) || undefined,
      helpText: referencedText(element.getAttribute('aria-describedby'), element) || undefined,
      required: element.matches('[required],[aria-required="true"]') || undefined,
      inputType: element.tagName === 'INPUT' ? (element.getAttribute('type') || 'text').toLowerCase() : element.tagName.toLowerCase(),
      autocomplete: element.getAttribute('autocomplete') || undefined,
      fieldName: element.getAttribute('name') || undefined,
    }
    const withFieldNameHint = target => {
      // A repeated field name is not a label. It is kept as disambiguation evidence only.
      if (target.fieldName && (fieldNameCounts.get(target.fieldName) ?? 0) > 1) target.fieldNameRepeated = true
      return target
    }
    const finish = target => {
      if (element.tagName === 'SELECT' && options.mode === 'form') target.options = [...element.options].slice(0, 30).map(option => normalize(option.text)).filter(Boolean)
      // Scoring hints are internal evidence; the caller only needs the resolved label and source.
      delete target.labelHint
      delete target.labelHintGeneric
      return withFieldNameHint(target)
    }
    // Associated names are authoritative and are accepted without spending contextual scoring.
    if (strong) {
      result.inferredLabel = strong
      result.labelSource = element.getAttribute('aria-label') ? 'aria-label'
        : element.getAttribute('aria-labelledby') ? 'aria-labelledby'
        : element.labels?.length ? 'label' : 'value'
      result.confidence = 'high'
      return finish(result)
    }
    if (hint) {
      // Weak hints never terminate inference. A generic hint is recorded as unusable evidence and
      // dropped; a specific hint is kept as a fallback while contextual scoring still runs.
      if (isGenericHint(hint)) {
        result.labelSource = 'generic-hint'
        result.labelHintGeneric = true
      } else {
        result.labelSource = element.getAttribute('placeholder') ? 'placeholder' : 'title'
        result.labelHint = hint
      }
    } else if (visibleHint) {
      result.labelSource = 'content'
    }

    const scored = []
    const add = (candidate, score, source) => {
      const value = text(candidate)
      if (!value || value.length > 160 || candidate.matches('style,script,noscript,template')) return
      // Head metadata is never field evidence. `document.title` in particular would otherwise be
      // picked up as "nearby text" because <title> precedes <body> in document order.
      if (candidate.closest('head')) return
      if (candidate.contains(element) || element.contains(candidate)) return
      if (candidate.querySelector('input,textarea,select,[contenteditable="true"]')) return
      // A <label> names exactly one control. Its text is evidence only for the control it is
      // associated with, which the strong-semantics pass has already handled.
      if (candidate.tagName === 'LABEL' && !([...candidate.labels || []].includes(element))) return
      const existing = scored.find(item => item.text === value)
      if (!existing || score > existing.score) {
        if (existing) scored.splice(scored.indexOf(existing), 1)
        scored.push({ text: value, score, source })
      }
    }
    const cell = closestDeep(element, 'th,td')
    if (cell?.parentElement) {
      const cells = [...cell.parentElement.children]
      for (const previous of cells.slice(0, cells.indexOf(cell))) add(previous, previous.tagName === 'TH' ? 96 : 90, 'table-cell')
      const table = closestDeep(cell, 'table')
      const column = cells.indexOf(cell)
      for (const row of [...table?.querySelectorAll('tr') || []]) {
        if (row === cell.parentElement) break
        const header = row.children[column]
        if (header?.tagName === 'TH') add(header, 94, 'table-header')
      }
    }
    /**
     * True when the candidate names the field's *region* rather than the field itself, so it must
     * never compete as a label. Two shapes carry a region name: the legend of the fieldset the field
     * belongs to, and a heading that is the first heading of the smallest element containing both the
     * field and the candidate.
     *
     * Without this, every control inside a `<fieldset>` competes with its own legend, and the outcome
     * depends on a scoring margin of well under one point — which flips between browser builds.
     */
    const isRegionNameFor = (candidate, field) => {
      const isLegend = candidate.tagName === 'LEGEND'
      const isHeading = /^H[1-6]$/.test(candidate.tagName) || candidate.getAttribute('role') === 'heading'
      if (!isLegend && !isHeading) return false
      const candidateText = text(candidate)
      if (!candidateText) return false
      if (isLegend) return candidate.parentElement?.tagName === 'FIELDSET' && candidate.parentElement.contains(field)
      // Walk outwards from the field so the first container that also holds the candidate is the
      // smallest common ancestor, then ask whether the candidate is that container's own heading.
      for (let container = field.parentElement; container; container = container.parentElement) {
        if (!container.contains(candidate)) continue
        const firstHeading = container.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > [role="heading"]')
        return text(firstHeading) === candidateText
      }
      return false
    }
    let branch = element
    for (let level = 0; branch?.parentElement && level < 3; level += 1, branch = branch.parentElement) {
      let previous = branch.previousElementSibling
      for (let offset = 0; previous && offset < 2; offset += 1, previous = previous.previousElementSibling) {
        if (isRegionNameFor(previous, element)) continue
        add(previous, 91 - level * 7 - offset * 6, 'preceding-content')
      }
    }

    const target = element.getBoundingClientRect()
    const targetX = target.left + target.width / 2
    const targetY = target.top + target.height / 2
    for (const candidate of candidateElements) {
      if (candidate.contains(element) || element.contains(candidate)) continue
      // A region name is evidence for the group, never for the field.
      if (isRegionNameFor(candidate, element)) continue
      const box = candidate.getBoundingClientRect()
      const centerX = box.left + box.width / 2
      const centerY = box.top + box.height / 2
      const sameRegion = closestDeep(candidate, 'form,fieldset,section,[role="dialog"],[role="form"],[role="group"]') === closestDeep(element, 'form,fieldset,section,[role="dialog"],[role="form"],[role="group"]')
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
    // Contextual evidence outranks an authored placeholder, so a usable hint never masks a
    // stronger nearby label.
    if (best) {
      result.confidence = confidence(best.score, best.score - (next?.score ?? 0), Boolean(next))
      if (result.confidence !== 'ambiguous') {
        result.inferredLabel = best.text
        result.labelSource = best.source
      } else {
        result.labelCandidates = scored.slice(0, 3).map(item => ({ text: item.text, source: item.source }))
      }
    }
    if (!result.inferredLabel && !best) {
      // No contextual evidence at all: a specific authored hint is the best remaining evidence.
      // A generic hint ("please select"/"请选择") yields no label rather than a misleading one.
      const fallback = normalize(result.labelHint) || normalize(visibleHint)
      if (fallback && !isGenericHint(fallback)) {
        result.inferredLabel = fallback
        if (!result.confidence) result.confidence = 'low'
      }
    }
    if (!result.inferredLabel) {
      // Report the field as unresolved instead of inventing or echoing a meaningless name. A
      // generic placeholder is deliberately rejected, so it is not reported as a label source.
      delete result.inferredLabel
      delete result.labelHint
      delete result.labelHintGeneric
      result.labelSource = undefined
      if (!result.confidence) result.confidence = 'low'
    }
    if (!result.helpText) {
      const wrapper = closestDeep(element, '.field,.form-item,[class*="field"],[class*="form-item"]') || ancestorOf(element)
      const helper = wrapper?.querySelector('.help,.hint,[class*="help"],[class*="hint"],small')
      if (helper && !helper.contains(element)) result.helpText = text(helper) || undefined
    }
    return finish(result)
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
  const elements = all.slice(0, options.max).map(element => {
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
  return { elements, headings, forms, totalInteractive: all.length, candidateCount: candidates.length, truncated: all.length > options.max }
}

/** Read stable semantics again before an action. */
export function projectElementFingerprint(element) {
  const clean = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160)
  const scope = element.getRootNode?.() || document
  const labelled = clean(String(element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => { const node = scope.getElementById?.(id) || document.getElementById(id); return node?.innerText || node?.textContent || '' }).filter(Boolean).join(' '))
  const inputValue = element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase()) ? clean(element.value) : ''
  const ownText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : clean(element.innerText)
  const name = clean(element.getAttribute('aria-label')) || labelled || clean([...element.labels || []].map(label => label.innerText || label.textContent).join(' ')) || clean(element.getAttribute('placeholder')) || inputValue || ownText || clean(element.getAttribute('title'))
  const role = element.getAttribute('role') || (element.tagName === 'INPUT'
    ? ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', file: 'button' })[(element.type || 'text').toLowerCase()] || 'textbox'
    : ({ A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'listitem', SUMMARY: 'button', LABEL: 'label' }[element.tagName] || element.tagName.toLowerCase()))
  return { role, name }
}
