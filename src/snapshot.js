/** Build a bounded semantic projection inside the browser page. */
export function projectSnapshot(root, options) {
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
  const labelled = clean(String(element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').filter(Boolean).join(' '))
  const inputValue = element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase()) ? clean(element.value) : ''
  const ownText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : clean(element.innerText)
  const name = clean(element.getAttribute('aria-label')) || labelled || clean([...element.labels || []].map(label => label.innerText || label.textContent).join(' ')) || clean(element.getAttribute('placeholder')) || inputValue || ownText || clean(element.getAttribute('title'))
  const role = element.getAttribute('role') || (element.tagName === 'INPUT'
    ? ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', file: 'button' })[(element.type || 'text').toLowerCase()] || 'textbox'
    : ({ A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'listitem', SUMMARY: 'button', LABEL: 'label' }[element.tagName] || element.tagName.toLowerCase()))
  return { role, name }
}
