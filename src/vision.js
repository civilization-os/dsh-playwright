import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

/**
 * 坐标标准化与转换器
 * 支持：
 * - 'pixel': 绝对像素坐标 (例如 640, 360)
 * - 'normalized_0_1': 0 到 1 归一化浮点数 (例如 0.5, 0.3)
 * - 'normalized_1000': 0 到 1000 归一化坐标 (例如 500, 300，Gemini/Qwen-VL/UI-TARS 常见格式)
 * - 'percent': 0 到 100 百分比 (例如 50, 30)
 * - 'auto': 自动推断 (0-1 之间小数视为 normalized_0_1，其余视为像素)
 */
export function normalizeCoordinates(coord, viewport, coordinateType = 'auto') {
  if (!coord || typeof coord !== 'object') {
    throw new Error('Coordinates object with x and y is required.')
  }
  const rawX = Number(coord.x)
  const rawY = Number(coord.y)
  if (isNaN(rawX) || isNaN(rawY)) {
    throw new Error(`Invalid coordinate values: x=${coord.x}, y=${coord.y}`)
  }

  const width = Math.max(viewport?.width || 1280, 1)
  const height = Math.max(viewport?.height || 800, 1)

  let px = rawX
  let py = rawY
  let resolvedType = coordinateType

  if (coordinateType === 'normalized_0_1') {
    px = rawX * width
    py = rawY * height
  } else if (coordinateType === 'normalized_1000') {
    px = (rawX / 1000) * width
    py = (rawY / 1000) * height
  } else if (coordinateType === 'percent') {
    px = (rawX / 100) * width
    py = (rawY / 100) * height
  } else if (coordinateType === 'auto') {
    if (rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1 && (rawX !== 0 || rawY !== 0)) {
      resolvedType = 'normalized_0_1'
      px = rawX * width
      py = rawY * height
    } else {
      resolvedType = 'pixel'
      px = rawX
      py = rawY
    }
  } else {
    // 默认为 pixel
    resolvedType = 'pixel'
    px = rawX
    py = rawY
  }

  const roundedX = Math.round(px)
  const roundedY = Math.round(py)
  const maxX = Math.max(0, width - 1)
  const maxY = Math.max(0, height - 1)
  const clampedX = Math.max(0, Math.min(maxX, roundedX))
  const clampedY = Math.max(0, Math.min(maxY, roundedY))

  return {
    x: clampedX,
    y: clampedY,
    rawX,
    rawY,
    type: resolvedType,
    clamped: clampedX !== roundedX || clampedY !== roundedY,
    viewport: { width, height },
  }
}

/**
 * 在页面指定坐标短暂注入高亮光标或涟漪动画，提供直观的视觉点击反馈
 */
export async function highlightPoint(page, x, y, durationMs = 800) {
  try {
    await page.evaluate(({ x, y, durationMs }) => {
      const styleId = 'dsh-visual-ripple-style'
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style')
        style.id = styleId
        style.textContent = `
          @keyframes dshVisualPulse {
            0% { transform: translate(-50%, -50%) scale(0.3); opacity: 0.95; }
            60% { transform: translate(-50%, -50%) scale(1.6); opacity: 0.4; }
            100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
          }
          .dsh-visual-ripple {
            position: fixed;
            pointer-events: none;
            z-index: 2147483647;
            border-radius: 50%;
            background: rgba(239, 68, 68, 0.35);
            border: 2px solid #ef4444;
            box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);
            width: 32px;
            height: 32px;
            animation: dshVisualPulse ${durationMs}ms ease-out forwards;
          }
          .dsh-visual-dot {
            position: fixed;
            pointer-events: none;
            z-index: 2147483647;
            border-radius: 50%;
            background: #ef4444;
            border: 1px solid #ffffff;
            width: 8px;
            height: 8px;
            transform: translate(-50%, -50%);
          }
        `
        document.head?.appendChild(style)
      }

      const ripple = document.createElement('div')
      ripple.className = 'dsh-visual-ripple'
      ripple.style.left = `${x}px`
      ripple.style.top = `${y}px`

      const dot = document.createElement('div')
      dot.className = 'dsh-visual-dot'
      dot.style.left = `${x}px`
      dot.style.top = `${y}px`

      document.body?.appendChild(ripple)
      document.body?.appendChild(dot)

      setTimeout(() => {
        ripple.remove()
        dot.remove()
      }, durationMs)
    }, { x, y, durationMs })
  } catch {
    // 忽略页面跳转或环境已断开
  }
}

/**
 * 注入半透明坐标网格，极大降低视觉模型 (VLM) 估算坐标时的漂移与幻觉
 */
export async function injectCoordinateGrid(page, gridType = 'pixel', interval, isFullPage = false, fullDimensions = null) {
  try {
    return await page.evaluate(({ gridType, interval, isFullPage, fullDimensions }) => {
      const existing = document.getElementById('dsh-vision-grid')
      if (existing) existing.remove()

      const width = isFullPage && fullDimensions?.width ? fullDimensions.width : window.innerWidth
      const height = isFullPage && fullDimensions?.height ? fullDimensions.height : window.innerHeight
      const effectiveInterval = Number(interval) || (width >= 1000 ? 150 : 100)

      const container = document.createElement('div')
      container.id = 'dsh-vision-grid'
      container.style.cssText = isFullPage
        ? `position:absolute;top:0;left:0;width:${width}px;height:${height}px;pointer-events:none;z-index:2147483646;font-family:monospace;font-size:10px;`
        : 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;font-family:monospace;font-size:10px;'

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
      const ctx = canvas.getContext('2d')
      if (!ctx) return false

      ctx.strokeStyle = 'rgba(239, 68, 68, 0.28)'
      ctx.lineWidth = 1
      ctx.font = 'bold 10px monospace'

      // 竖向网格线与 X 坐标（带半透明暗色底色，避免与 HUD 重叠遮挡）
      for (let x = effectiveInterval; x < width; x += effectiveInterval) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
        const label = gridType === 'normalized_1000' ? Math.round((x / width) * 1000) : x
        const text = String(label)
        const textWidth = ctx.measureText(text).width
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
        ctx.fillRect(x - 2, 0, textWidth + 8, 15)
        ctx.fillStyle = '#f87171'
        ctx.fillText(text, x + 2, 11)
      }

      // 横向网格线与 Y 坐标（带半透明暗色底色）
      for (let y = effectiveInterval; y < height; y += effectiveInterval) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
        const label = gridType === 'normalized_1000' ? Math.round((y / height) * 1000) : y
        const text = String(label)
        const textWidth = ctx.measureText(text).width
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
        ctx.fillRect(0, y - 13, textWidth + 6, 15)
        ctx.fillStyle = '#f87171'
        ctx.fillText(text, 2, y - 2)
      }

      container.appendChild(canvas)
      document.body?.appendChild(container)
      return true
    }, { gridType, interval, isFullPage, fullDimensions })
  } catch {
    return false
  }
}

/**
 * 移除坐标网格
 */
export async function removeCoordinateGrid(page) {
  try {
    await page.evaluate(() => {
      const grid = document.getElementById('dsh-vision-grid')
      if (grid) grid.remove()
    })
  } catch {
    // 忽略
  }
}

/**
 * Set-of-Marks (SoM) 元素标注：自动为页面可交互元素生成带数字编号的边框和标签
 */
export async function injectSetOfMarks(page, isFullPage = false, fullDimensions = null) {
  try {
    return await page.evaluate(({ isFullPage, fullDimensions }) => {
      const existing = document.getElementById('dsh-som-container')
      if (existing) existing.remove()

      const width = isFullPage && fullDimensions?.width ? fullDimensions.width : window.innerWidth
      const height = isFullPage && fullDimensions?.height ? fullDimensions.height : window.innerHeight

      const container = document.createElement('div')
      container.id = 'dsh-som-container'
      container.style.cssText = isFullPage
        ? `position:absolute;top:0;left:0;width:${width}px;height:${height}px;pointer-events:none;z-index:2147483646;`
        : 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;'

      const selector = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick]'
      const candidates = Array.from(document.querySelectorAll(selector))

      const marks = []
      let counter = 1
      const scrollX = window.scrollX || window.pageXOffset || 0
      const scrollY = window.scrollY || window.pageYOffset || 0

      for (const el of candidates) {
        if (counter > 80) break
        const rect = el.getBoundingClientRect()
        const pageLeft = isFullPage ? rect.left + scrollX : rect.left
        const pageTop = isFullPage ? rect.top + scrollY : rect.top

        if (rect.width <= 2 || rect.height <= 2) continue
        if (!isFullPage) {
          if (rect.top > window.innerHeight || rect.bottom < 0 || rect.left > window.innerWidth || rect.right < 0) continue
        } else {
          if (pageTop > height || pageLeft > width || pageLeft + rect.width < 0 || pageTop + rect.height < 0) continue
        }

        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

        const box = document.createElement('div')
        box.style.cssText = `
          position: ${isFullPage ? 'absolute' : 'fixed'};
          left: ${pageLeft}px;
          top: ${pageTop}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          border: 2px solid #2563eb;
          box-sizing: border-box;
        `

        const badge = document.createElement('span')
        badge.textContent = `[${counter}]`
        badge.style.cssText = `
          position: absolute;
          top: -12px;
          left: -2px;
          background: #2563eb;
          color: #ffffff;
          font-family: monospace;
          font-size: 11px;
          font-weight: bold;
          padding: 0 3px;
          border-radius: 2px;
          line-height: 14px;
        `
        box.appendChild(badge)
        container.appendChild(box)

        const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80)
        marks.push({
          markId: counter,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name,
          x: Math.round(pageLeft),
          y: Math.round(pageTop),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerX: Math.round(pageLeft + rect.width / 2),
          centerY: Math.round(pageTop + rect.height / 2),
        })

        counter += 1
      }

      document.body?.appendChild(container)
      return marks
    }, { isFullPage, fullDimensions })
  } catch {
    return []
  }
}

/**
 * 移除 Set-of-Marks 标注容器
 */
export async function removeSetOfMarks(page) {
  try {
    await page.evaluate(() => {
      const container = document.getElementById('dsh-som-container')
      if (container) container.remove()
    })
  } catch {
    // 忽略
  }
}

/**
 * 视觉动作执行引擎
 * 支持针对目标坐标的：点击、双击、右键、悬停、拖拽、输入文本、按键、滚轮滚动
 */
export async function executeVisualAct(page, options = {}) {
  const {
    action = 'click',
    x,
    y,
    coordinateType = 'auto',
    coordinateMode = 'auto',
    autoScroll = true,
    targetX,
    targetY,
    text,
    key,
    deltaX = 0,
    deltaY = 100,
    button = 'left',
    clickCount = 1,
    highlight = true,
    clear = false,
    expectedText,
    expectedUrl,
    timeoutMs = 5000,
  } = options

  if (x == null || y == null) {
    throw new Error('Coordinates x and y are required for visual actions.')
  }

  const pageMetrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight),
  })).catch(() => {
    const vp = page.viewportSize() || { width: 1280, height: 800 }
    return {
      viewportWidth: vp.width,
      viewportHeight: vp.height,
      scrollX: 0,
      scrollY: 0,
      documentWidth: vp.width,
      documentHeight: vp.height,
    }
  })

  const isPageCoord = coordinateMode === 'page' || (
    coordinateMode === 'auto' && (
      (Number(y) >= pageMetrics.viewportHeight && pageMetrics.documentHeight > pageMetrics.viewportHeight) ||
      (Number(x) >= pageMetrics.viewportWidth && pageMetrics.documentWidth > pageMetrics.viewportWidth)
    )
  )

  const dimBase = isPageCoord
    ? { width: pageMetrics.documentWidth, height: pageMetrics.documentHeight }
    : { width: pageMetrics.viewportWidth, height: pageMetrics.viewportHeight }

  const norm = normalizeCoordinates({ x, y }, dimBase, coordinateType)

  let didScroll = false
  let currentScroll = { x: pageMetrics.scrollX, y: pageMetrics.scrollY }

  if (isPageCoord && autoScroll !== false) {
    const targetScrollY = Math.max(0, Math.min(pageMetrics.documentHeight - pageMetrics.viewportHeight, Math.round(norm.y - pageMetrics.viewportHeight / 2)))
    const targetScrollX = Math.max(0, Math.min(pageMetrics.documentWidth - pageMetrics.viewportWidth, Math.round(norm.x - pageMetrics.viewportWidth / 2)))

    if (Math.abs(pageMetrics.scrollY - targetScrollY) > 2 || Math.abs(pageMetrics.scrollX - targetScrollX) > 2) {
      await page.evaluate(({ sx, sy }) => {
        window.scrollTo({ left: sx, top: sy, behavior: 'instant' })
      }, { sx: targetScrollX, sy: targetScrollY }).catch(() => {})
      await page.waitForTimeout(40).catch(() => {})
      didScroll = true
    }

    currentScroll = await page.evaluate(() => ({
      x: window.scrollX || window.pageXOffset || 0,
      y: window.scrollY || window.pageYOffset || 0,
    })).catch(() => ({ x: targetScrollX, y: targetScrollY }))
  }

  const clientX = isPageCoord
    ? Math.max(0, Math.min(pageMetrics.viewportWidth - 1, norm.x - currentScroll.x))
    : norm.x
  const clientY = isPageCoord
    ? Math.max(0, Math.min(pageMetrics.viewportHeight - 1, norm.y - currentScroll.y))
    : norm.y

  const currentUrlBefore = page.url()

  if (highlight) {
    await highlightPoint(page, clientX, clientY, 600)
  }

  let targetNorm
  let targetClientX, targetClientY
  if (['drag'].includes(action)) {
    if (targetX == null || targetY == null) {
      throw new Error('targetX and targetY are required for drag action.')
    }
    targetNorm = normalizeCoordinates({ x: targetX, y: targetY }, dimBase, coordinateType)
    targetClientX = isPageCoord
      ? Math.max(0, Math.min(pageMetrics.viewportWidth - 1, targetNorm.x - currentScroll.x))
      : targetNorm.x
    targetClientY = isPageCoord
      ? Math.max(0, Math.min(pageMetrics.viewportHeight - 1, targetNorm.y - currentScroll.y))
      : targetNorm.y
  }

  switch (action) {
    case 'click': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.click(clientX, clientY, { button, clickCount })
      break
    }
    case 'doubleClick': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.dblclick(clientX, clientY, { button })
      break
    }
    case 'rightClick': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.click(clientX, clientY, { button: 'right' })
      break
    }
    case 'hover':
    case 'move': {
      await page.mouse.move(clientX, clientY, { steps: 5 })
      break
    }
    case 'drag': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.down({ button: 'left' })
      await page.mouse.move(targetClientX, targetClientY, { steps: 12 })
      await page.mouse.up({ button: 'left' })
      break
    }
    case 'type':
    case 'fill': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.click(clientX, clientY)
      if (clear) {
        await page.keyboard.press('ControlOrMeta+A').catch(() => {})
        await page.keyboard.press('Backspace').catch(() => {})
      }
      if (text != null && String(text).length > 0) {
        await page.keyboard.type(String(text), { delay: 25 })
      }
      break
    }
    case 'press': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.click(clientX, clientY)
      if (!key) throw new Error('A keyboard key string is required for press action (e.g. "Enter", "Tab", "Escape").')
      await page.keyboard.press(key)
      break
    }
    case 'scroll': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.wheel(Number(deltaX) || 0, Number(deltaY) || 100)
      break
    }
    case 'down': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.down({ button })
      break
    }
    case 'up': {
      await page.mouse.move(clientX, clientY)
      await page.mouse.up({ button })
      break
    }
    default:
      throw new Error(`Unsupported visual action: "${action}". Supported: click, doubleClick, rightClick, hover, drag, type, press, scroll, down, up.`)
  }

  let textVerified = false
  if (expectedText) {
    try {
      const locator = page.getByText(expectedText).first()
      await locator.waitFor({ state: 'visible', timeout: timeoutMs })
      textVerified = true
    } catch {
      throw new Error(`Visual action executed, but expectedText "${expectedText}" did not become visible within ${timeoutMs}ms.`)
    }
  }

  let urlVerified = false
  if (expectedUrl) {
    try {
      await page.waitForURL(expectedUrl, { timeout: timeoutMs })
      urlVerified = true
    } catch {
      throw new Error(`Visual action executed, but expectedUrl "${expectedUrl}" was not reached within ${timeoutMs}ms. Current: ${page.url()}`)
    }
  }

  const currentUrl = page.url()
  const title = await page.title().catch(() => '')

  return {
    action,
    coordinates: {
      x: clientX,
      y: clientY,
      pageX: isPageCoord ? norm.x : clientX + (currentScroll.x || 0),
      pageY: isPageCoord ? norm.y : clientY + (currentScroll.y || 0),
      rawX: norm.rawX,
      rawY: norm.rawY,
      type: norm.type,
      clamped: norm.clamped,
      scrolled: didScroll,
    },
    targetCoordinates: targetNorm ? {
      x: targetClientX,
      y: targetClientY,
      pageX: isPageCoord ? targetNorm.x : targetClientX + (currentScroll.x || 0),
      pageY: isPageCoord ? targetNorm.y : targetClientY + (currentScroll.y || 0),
      rawX: targetNorm.rawX,
      rawY: targetNorm.rawY,
    } : undefined,
    viewport: { width: pageMetrics.viewportWidth, height: pageMetrics.viewportHeight },
    documentDimensions: { width: pageMetrics.documentWidth, height: pageMetrics.documentHeight },
    url: currentUrl,
    title,
    urlChanged: currentUrl !== currentUrlBefore,
    textVerified,
    urlVerified,
  }
}

/**
 * 视觉模型专用截图与坐标辅助
 * 支持：
 * - 自动渲染坐标参考网格 (grid: true)
 * - 自动进行 Set-of-Marks 元素标注 (som: true)
 * - 直接返回 base64 便于多模态大模型直接感知
 * - 自动落盘与返回文件路径
 */
export async function captureVisualScreenshot(page, homeDir, options = {}) {
  const {
    grid = false,
    gridType = 'pixel',
    gridInterval = 100,
    som = false,
    returnBase64 = false,
    fullPage = false,
    savePath,
    format = 'png',
    quality,
  } = options

  const screenshotDir = join(homeDir || tmpdir(), 'screenshots')
  await mkdir(screenshotDir, { recursive: true })

  const viewport = page.viewportSize() || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })).catch(() => ({ width: 1280, height: 800 }))

  const dimensions = await page.evaluate(isFull => {
    if (!isFull) {
      return {
        width: window.innerWidth,
        height: window.innerHeight,
      }
    }
    const doc = document.documentElement
    const body = document.body
    return {
      width: Math.max(
        doc?.scrollWidth || 0,
        doc?.offsetWidth || 0,
        doc?.clientWidth || 0,
        body?.scrollWidth || 0,
        body?.offsetWidth || 0,
        window.innerWidth
      ),
      height: Math.max(
        doc?.scrollHeight || 0,
        doc?.offsetHeight || 0,
        doc?.clientHeight || 0,
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        window.innerHeight
      ),
    }
  }, Boolean(fullPage)).catch(() => viewport)

  let marks = []
  try {
    if (grid) {
      await injectCoordinateGrid(page, gridType, gridInterval, Boolean(fullPage), dimensions)
    }
    if (som) {
      marks = await injectSetOfMarks(page, Boolean(fullPage), dimensions)
    }

    const defaultFilename = `visual-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`
    const finalPath = savePath ? resolve(savePath) : join(screenshotDir, defaultFilename)
    await mkdir(dirname(finalPath), { recursive: true })

    const screenshotOptions = {
      path: finalPath,
      fullPage: Boolean(fullPage),
      type: format === 'jpeg' ? 'jpeg' : 'png',
    }
    if (format === 'jpeg' && quality != null) {
      screenshotOptions.quality = quality
    }

    const buffer = await page.screenshot(screenshotOptions)
    const base64Data = returnBase64 ? `data:image/${format === 'jpeg' ? 'jpeg' : 'png'};base64,${buffer.toString('base64')}` : undefined

    return {
      path: finalPath,
      base64: base64Data,
      width: dimensions.width,
      height: dimensions.height,
      fullPage: Boolean(fullPage),
      viewport,
      gridEnabled: Boolean(grid),
      somEnabled: Boolean(som),
      marks: som ? marks : undefined,
      url: page.url(),
    }
  } finally {
    if (grid) {
      await removeCoordinateGrid(page)
    }
    if (som) {
      await removeSetOfMarks(page)
    }
  }
}

/**
 * 从多模态视觉模型 (VLM) 的文本输出中鲁棒解析出点击坐标或 Set-of-Marks 编号
 */
export function parseVisionCoordinates(output, marks = []) {
  if (!output) return null
  const text = typeof output === 'string' ? output : JSON.stringify(output)

  // 1. 优先尝试解析 JSON 结构
  try {
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.markId != null || parsed.mark != null) {
        const id = Number(parsed.markId ?? parsed.mark)
        const found = marks.find(m => m.markId === id)
        if (found) return { x: found.centerX, y: found.centerY, markId: id, source: 'som_mark' }
      }
      if (parsed.point && Array.isArray(parsed.point) && parsed.point.length >= 2) {
        return { x: Number(parsed.point[0]), y: Number(parsed.point[1]), source: 'json_point' }
      }
      if (parsed.coordinates && Array.isArray(parsed.coordinates) && parsed.coordinates.length >= 2) {
        return { x: Number(parsed.coordinates[0]), y: Number(parsed.coordinates[1]), source: 'json_coordinates' }
      }
      if (parsed.x != null && parsed.y != null) {
        return { x: Number(parsed.x), y: Number(parsed.y), source: 'json_xy' }
      }
    }
  } catch {
    // 不是纯 JSON，继续后续正则匹配
  }

  // 2. 尝试匹配 Set-of-Marks 标记编号，如 [12] 或 mark 12 或 Mark #12
  if (marks && marks.length > 0) {
    const markMatch = text.match(/\[(\d+)\]|\b(?:mark|target|badge)\s*#?(\d+)\b/i)
    if (markMatch) {
      const id = Number(markMatch[1] || markMatch[2])
      const found = marks.find(m => m.markId === id)
      if (found) return { x: found.centerX, y: found.centerY, markId: id, source: 'som_mark_regex' }
    }
  }

  // 3. 匹配标签语法 <point x="100" y="200"> 或 <point y="200" x="100">
  const tagMatch = text.match(/<point\s+[^>]*x=["']?(\d+(?:\.\d+)?)["']?[^>]*y=["']?(\d+(?:\.\d+)?)["']?[^>]*>/i)
    || text.match(/<point\s+[^>]*y=["']?(\d+(?:\.\d+)?)["']?[^>]*x=["']?(\d+(?:\.\d+)?)["']?[^>]*>/i)
  if (tagMatch) {
    const isYFirst = text.indexOf('y=') < text.indexOf('x=')
    const x = Number(isYFirst ? tagMatch[2] : tagMatch[1])
    const y = Number(isYFirst ? tagMatch[1] : tagMatch[2])
    return { x, y, source: 'point_tag' }
  }

  // 4. 匹配显式坐标赋值，如 x: 120, y: 350 或 x=120, y=350
  const assignMatch = text.match(/(?:x|X)\s*[:=]\s*(\d+(?:\.\d+)?)\s*[,;\s]+\s*(?:y|Y)\s*[:=]\s*(\d+(?:\.\d+)?)/)
  if (assignMatch) {
    return { x: Number(assignMatch[1]), y: Number(assignMatch[2]), source: 'explicit_assign' }
  }

  // 5. 匹配元组形式 (120, 350) 或 [120, 350]
  const tupleMatch = text.match(/(?:coordinates?|point|at)?\s*[(\[]\s*(\d+(?:\.\d+)?)\s*[,，\s]\s*(\d+(?:\.\d+)?)\s*[)\]]/i)
  if (tupleMatch) {
    return { x: Number(tupleMatch[1]), y: Number(tupleMatch[2]), source: 'tuple' }
  }

  return null
}

/**
 * 本地 DOM 视觉矩形定位（无外部 VLM API 时的就地智能兜底）
 * 根据自然语言语义匹配页面中符合特征的元素，并返回其可见视口或文档中心像素坐标
 * 支持：正向包含、反向包含（如输入“重置按钮”匹配文案为“重置”的按钮）、角色后缀剥离、语义角色对齐与长页面全域检索
 */
export async function findVisualElementByDescription(page, description) {
  if (!description) return null
  try {
    return await page.evaluate(desc => {
      const rawQuery = String(desc).trim()
      const query = rawQuery.toLowerCase()
      if (!query) return null

      // 角色后缀模式（支持中英文常见的控件后缀词）
      const roleSuffixPattern = /(?:按钮|链接|输入框|文本框|输入|选择框|下拉框|选项|单选框|复选框|图标|开关|标签|button|btn|link|input|textbox|text|box|select|dropdown|checkbox|radio|toggle|icon|tab)$/i

      // 剥离角色后缀（支持多重后缀剥离，如 "重置 按钮" -> "重置"）
      let strippedQuery = query
      while (roleSuffixPattern.test(strippedQuery)) {
        const next = strippedQuery.replace(roleSuffixPattern, '').trim()
        if (!next || next === strippedQuery) break
        strippedQuery = next
      }

      // 语义角色意图识别
      const expectsButton = /(?:按钮|button|btn)/i.test(query)
      const expectsInput = /(?:输入|输入框|文本框|input|textbox|text|box)/i.test(query)
      const expectsLink = /(?:链接|跳转|link)/i.test(query)
      const expectsSelect = /(?:选择|下拉|select|dropdown)/i.test(query)
      const expectsCheckbox = /(?:复选|勾选|checkbox)/i.test(query)
      const expectsRadio = /(?:单选|radio)/i.test(query)

      const candidates = Array.from(document.querySelectorAll(
        'button, a[href], input, textarea, select, [role], [onclick], img, svg, h1, h2, h3, h4, p, span, div, li'
      ))

      const scrollX = window.scrollX || window.pageXOffset || 0
      const scrollY = window.scrollY || window.pageYOffset || 0
      const vpWidth = window.innerWidth
      const vpHeight = window.innerHeight

      let bestMatch = null
      let highestScore = 0

      // 分词（按空白或常见标点）
      const words = Array.from(new Set([
        ...query.split(/[\s,，.。!！?？:：;；/\\_-]+/),
        ...strippedQuery.split(/[\s,，.。!！?？:：;；/\\_-]+/),
      ])).filter(w => w.length >= 2)

      for (const el of candidates) {
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

        const tagName = el.tagName.toLowerCase()
        const elType = (el.getAttribute('type') || '').toLowerCase()
        const elRole = (el.getAttribute('role') || tagName).toLowerCase()

        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim()
        const innerText = (el.innerText || '').toLowerCase().trim()
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase().trim()
        const title = (el.getAttribute('title') || '').toLowerCase().trim()
        const alt = (el.getAttribute('alt') || '').toLowerCase().trim()
        const val = (typeof el.value === 'string' && tagName === 'input' ? el.value : '').toLowerCase().trim()

        const targetTexts = [ariaLabel, innerText, placeholder, title, alt, val].filter(Boolean)
        if (targetTexts.length === 0) continue

        let textScore = 0

        for (const t of targetTexts) {
          // 1. 完全匹配
          if (t === query) {
            textScore = Math.max(textScore, 100)
          } else if (strippedQuery && t === strippedQuery) {
            textScore = Math.max(textScore, 95)
          }

          // 2. 正向包含（候选文本包含 query 或 strippedQuery）
          if (query.length >= 2 && t.includes(query)) {
            textScore = Math.max(textScore, 65)
          } else if (strippedQuery && strippedQuery.length >= 2 && t.includes(strippedQuery)) {
            textScore = Math.max(textScore, 60)
          }

          // 3. 反向包含（query 或 strippedQuery 包含候选文本，加长度防抖）
          if (t.length >= 2) {
            if (query.includes(t)) {
              textScore = Math.max(textScore, 55)
            } else if (strippedQuery && strippedQuery.length >= 2 && strippedQuery.includes(t)) {
              textScore = Math.max(textScore, 50)
            }
          }

          // 4. 单词级匹配
          for (const w of words) {
            if (t.includes(w)) {
              textScore += 12
            }
          }
        }

        if (textScore <= 0) continue

        let totalScore = textScore

        // 5. 角色意图对齐加成
        const isButton = tagName === 'button' || elRole === 'button' || (tagName === 'input' && ['button', 'submit', 'reset'].includes(elType))
        const isInput = tagName === 'textarea' || (tagName === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(elType)) || elRole === 'textbox'
        const isLink = tagName === 'a' || elRole === 'link'
        const isSelect = tagName === 'select' || elRole === 'combobox' || elRole === 'listbox'
        const isCheckbox = (tagName === 'input' && elType === 'checkbox') || elRole === 'checkbox'
        const isRadio = (tagName === 'input' && elType === 'radio') || elRole === 'radio'

        if (expectsButton && isButton) totalScore += 25
        if (expectsInput && isInput) totalScore += 25
        if (expectsLink && isLink) totalScore += 25
        if (expectsSelect && isSelect) totalScore += 25
        if (expectsCheckbox && isCheckbox) totalScore += 25
        if (expectsRadio && isRadio) totalScore += 25

        // 6. 交互式标签基础权重加成
        if (['button', 'a', 'input', 'select', 'textarea'].includes(tagName) || el.hasAttribute('onclick')) {
          totalScore += 10
        }

        // 7. 视口内优先加成（同等匹配度下优先当前视口内可见元素）
        const inViewport = (rect.top < vpHeight && rect.bottom > 0 && rect.left < vpWidth && rect.right > 0)
        if (inViewport) {
          totalScore += 10
        }

        if (totalScore > highestScore) {
          highestScore = totalScore
          const clientCenterX = Math.round(rect.left + rect.width / 2)
          const clientCenterY = Math.round(rect.top + rect.height / 2)
          const pageCenterX = Math.round(scrollX + rect.left + rect.width / 2)
          const pageCenterY = Math.round(scrollY + rect.top + rect.height / 2)

          bestMatch = {
            score: totalScore,
            tag: tagName,
            role: elRole,
            text: (innerText || ariaLabel || placeholder || title || alt || '').slice(0, 50),
            x: inViewport ? clientCenterX : pageCenterX,
            y: inViewport ? clientCenterY : pageCenterY,
            clientX: clientCenterX,
            clientY: clientCenterY,
            pageX: pageCenterX,
            pageY: pageCenterY,
            inViewport,
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          }
        }
      }

      return highestScore >= 20 ? bestMatch : null
    }, description)
  } catch {
    return null
  }
}

/**
 * 视觉模型智能定位与点击集成器
 */
export class VisionGrounder {
  constructor(settings, homeDir) {
    this.settings = settings
    this.homeDir = homeDir
    this.pageMarks = new Map()
  }

  saveMarks(pageId, marks, isFullPage = false, url = '') {
    if (!pageId || !marks) return
    this.pageMarks.set(pageId, {
      marks: marks.map(m => ({ ...m, isFullPage })),
      isFullPage,
      url,
      timestamp: Date.now(),
    })
  }

  getMarks(pageId) {
    if (!pageId) return null
    const entry = this.pageMarks.get(pageId)
    if (!entry) return null
    if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
      this.pageMarks.delete(pageId)
      return null
    }
    return entry
  }

  async groundAndClick(page, options = {}) {
    const {
      description,
      x,
      y,
      markId,
      action = 'click',
      coordinateType = 'auto',
      coordinateMode = 'auto',
      autoScroll = true,
      grid = true,
      som = false,
      visionApi,
      highlight = true,
      text,
      key,
    } = options

    // 情况 A：调用方已直接给出 x, y 坐标，直接点击
    if (x != null && y != null) {
      const result = await executeVisualAct(page, {
        action,
        x,
        y,
        coordinateType,
        coordinateMode,
        autoScroll,
        text,
        key,
        highlight,
      })
      return {
        groundedBy: 'direct_coordinates',
        ...result,
      }
    }

    // 情况 B：提供 Set-of-Marks 标记编号
    if (markId != null) {
      const pageId = options.pageId
      const cached = this.getMarks(pageId)
      let mark = cached?.marks?.find(m => m.markId === Number(markId))
      let shotPath = undefined

      if (!mark) {
        // 先在当前视口尝试
        let shot = await captureVisualScreenshot(page, this.homeDir, { som: true, fullPage: false, pageId })
        mark = (shot.marks || []).find(m => m.markId === Number(markId))
        shotPath = shot.path
        if (shot.marks && pageId) {
          this.saveMarks(pageId, shot.marks, false, page.url())
        }

        // 若视口内未找到，自动尝试全页整页扫描（支持在长页面视口下方的标记）
        if (!mark) {
          shot = await captureVisualScreenshot(page, this.homeDir, { som: true, fullPage: true, pageId })
          mark = (shot.marks || []).find(m => m.markId === Number(markId))
          shotPath = shot.path
          if (shot.marks && pageId) {
            this.saveMarks(pageId, shot.marks, true, page.url())
          }
        }
      }

      if (!mark) {
        throw new Error(`Mark with id [${markId}] was not found in the current page Set-of-Marks.`)
      }

      const result = await executeVisualAct(page, {
        action,
        x: mark.centerX,
        y: mark.centerY,
        coordinateType: 'pixel',
        coordinateMode: mark.isFullPage ? 'page' : 'auto',
        autoScroll: true,
        text,
        key,
        highlight,
      })
      return {
        groundedBy: 'som_mark',
        markId: Number(markId),
        markName: mark.name,
        isFullPage: Boolean(mark.isFullPage),
        screenshotPath: shotPath,
        ...result,
      }
    }

    if (!description) {
      throw new Error('Either coordinates (x, y), markId, or a visual description must be provided.')
    }

    // 情况 C：检查是否有可用的 Vision Model API (OpenAI 兼容端点 / 自定义配置)
    const configured = typeof this.settings?.read === 'function' ? await this.settings.read() : (this.settings || {})
    const apiKey = visionApi?.apiKey || configured?.visionApiKey || process.env.VISION_API_KEY || process.env.OPENAI_API_KEY
    const baseUrl = visionApi?.baseUrl || configured?.visionBaseUrl || process.env.VISION_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    const model = visionApi?.model || configured?.visionModel || process.env.VISION_MODEL || 'gpt-4o'

    if (apiKey) {
      // 捕获带有网格或标注的高清晰度视觉截图
      const shot = await captureVisualScreenshot(page, this.homeDir, {
        grid,
        som,
        returnBase64: true,
      })

      const prompt = `You are a GUI visual grounding agent. Locate the target element: "${description}" in the web screenshot. Return the target center coordinates as JSON: {"x": <number>, "y": <number>}. The image dimensions are ${shot.width}x${shot.height} pixels.`

      const apiEndpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
      const resp = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: shot.base64 },
                },
              ],
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
        }),
      })

      if (resp.ok) {
        const body = await resp.json()
        const reply = body.choices?.[0]?.message?.content || ''
        const coords = parseVisionCoordinates(reply, shot.marks || [])
        if (coords) {
          const actResult = await executeVisualAct(page, {
            action,
            x: coords.x,
            y: coords.y,
            coordinateType: 'pixel',
            text,
            key,
            highlight,
          })
          return {
            groundedBy: 'vision_model',
            modelUsed: model,
            visionReply: reply,
            screenshotPath: shot.path,
            ...actResult,
          }
        }
      }
    }

    // 情况 D：本地 DOM 视口/文档包围盒视觉兜底
    const localMatch = await findVisualElementByDescription(page, description)
    if (localMatch) {
      const actResult = await executeVisualAct(page, {
        action,
        x: localMatch.inViewport ? localMatch.x : (localMatch.pageX ?? localMatch.x),
        y: localMatch.inViewport ? localMatch.y : (localMatch.pageY ?? localMatch.y),
        coordinateType: 'pixel',
        coordinateMode: localMatch.inViewport ? 'viewport' : 'page',
        autoScroll: true,
        text,
        key,
        highlight,
      })
      return {
        groundedBy: 'dom_visual_rect',
        matchedElement: { tag: localMatch.tag, role: localMatch.role, text: localMatch.text, inViewport: localMatch.inViewport },
        ...actResult,
      }
    }

    // 情况 E：无法自动定位，截图落盘并返回坐标网格供模型自行决策
    const fallbackShot = await captureVisualScreenshot(page, this.homeDir, { grid: true })
    return {
      success: false,
      groundedBy: 'none',
      message: `Could not resolve visual coordinates for description: "${description}". A coordinate grid screenshot has been saved to: ${fallbackShot.path}. Please supply explicit coordinates (x, y) to browser_visual_act.`,
      screenshotPath: fallbackShot.path,
      viewport: fallbackShot.viewport,
    }
  }
}
