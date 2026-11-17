import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, rm } from 'node:fs/promises'
import { launchTestBrowser } from './browser.helper.js'
import {
  normalizeCoordinates,
  parseVisionCoordinates,
  executeVisualAct,
  captureVisualScreenshot,
  VisionGrounder,
  findVisualElementByDescription,
  highlightPoint,
} from '../src/vision.js'
import { BrowserManager } from '../src/browser.js'
import { defaults } from '../src/settings.js'

test('normalizeCoordinates correctly converts across coordinate systems', () => {
  const viewport = { width: 1000, height: 500 }

  // 1. Pixel
  const px = normalizeCoordinates({ x: 400, y: 250 }, viewport, 'pixel')
  assert.equal(px.x, 400)
  assert.equal(px.y, 250)
  assert.equal(px.type, 'pixel')
  assert.equal(px.clamped, false)

  // 2. Normalized 0-1
  const norm01 = normalizeCoordinates({ x: 0.5, y: 0.2 }, viewport, 'normalized_0_1')
  assert.equal(norm01.x, 500)
  assert.equal(norm01.y, 100)
  assert.equal(norm01.type, 'normalized_0_1')
  assert.equal(norm01.clamped, false)

  // 3. Normalized 0-1000
  const norm1000 = normalizeCoordinates({ x: 750, y: 500 }, viewport, 'normalized_1000')
  assert.equal(norm1000.x, 750)
  assert.equal(norm1000.y, 250)
  assert.equal(norm1000.type, 'normalized_1000')
  assert.equal(norm1000.clamped, false)

  // 4. Percent
  const pct = normalizeCoordinates({ x: 80, y: 40 }, viewport, 'percent')
  assert.equal(pct.x, 800)
  assert.equal(pct.y, 200)
  assert.equal(pct.type, 'percent')

  // 5. Auto mode detects 0-1 as normalized
  const autoNorm = normalizeCoordinates({ x: 0.25, y: 0.8 }, viewport, 'auto')
  assert.equal(autoNorm.x, 250)
  assert.equal(autoNorm.y, 400)
  assert.equal(autoNorm.type, 'normalized_0_1')

  // 6. Auto mode treats > 1 as pixels
  const autoPx = normalizeCoordinates({ x: 300, y: 150 }, viewport, 'auto')
  assert.equal(autoPx.x, 300)
  assert.equal(autoPx.y, 150)
  assert.equal(autoPx.type, 'pixel')

  // 7. Clamping outside boundary (0 to width - 1, 0 to height - 1)
  const clamped = normalizeCoordinates({ x: 1200, y: -50 }, viewport, 'pixel')
  assert.equal(clamped.x, 999)
  assert.equal(clamped.y, 0)
  assert.equal(clamped.clamped, true)

  const clamp5000 = normalizeCoordinates({ x: 5000, y: 1000 }, { width: 1280, height: 800 }, 'pixel')
  assert.equal(clamp5000.x, 1279)
  assert.equal(clamp5000.y, 799)
  assert.equal(clamp5000.clamped, true)

  // 8. Invalid input throws
  assert.throws(() => normalizeCoordinates({ x: 'bad', y: 10 }, viewport), /Invalid coordinate values/)
  assert.throws(() => normalizeCoordinates(null, viewport), /Coordinates object/)
})

test('parseVisionCoordinates extracts coordinates from varied VLM formats', () => {
  const marks = [
    { markId: 1, name: 'Login', centerX: 100, centerY: 50 },
    { markId: 2, name: 'Search', centerX: 300, centerY: 200 },
  ]

  // JSON point
  assert.deepEqual(parseVisionCoordinates('{"point": [450, 320]}'), { x: 450, y: 320, source: 'json_point' })

  // JSON xy
  assert.deepEqual(parseVisionCoordinates('```json\n{"x": 120, "y": 80}\n```'), { x: 120, y: 80, source: 'json_xy' })

  // JSON coordinates
  assert.deepEqual(parseVisionCoordinates('{"coordinates": [500, 250]}'), { x: 500, y: 250, source: 'json_coordinates' })

  // Point tag
  assert.deepEqual(parseVisionCoordinates('<point x="220" y="330">'), { x: 220, y: 330, source: 'point_tag' })
  assert.deepEqual(parseVisionCoordinates('<point y="330" x="220">'), { x: 220, y: 330, source: 'point_tag' })

  // Explicit assign
  assert.deepEqual(parseVisionCoordinates('I found the button at x: 640, y: 480.'), { x: 640, y: 480, source: 'explicit_assign' })

  // Tuple
  assert.deepEqual(parseVisionCoordinates('Coordinates are (800, 600)'), { x: 800, y: 600, source: 'tuple' })

  // SoM mark references
  assert.deepEqual(parseVisionCoordinates('Click mark [2] for search', marks), { x: 300, y: 200, markId: 2, source: 'som_mark_regex' })
  assert.deepEqual(parseVisionCoordinates('target #1', marks), { x: 100, y: 50, markId: 1, source: 'som_mark_regex' })
  assert.deepEqual(parseVisionCoordinates('{"markId": 2}', marks), { x: 300, y: 200, markId: 2, source: 'som_mark' })

  // None
  assert.equal(parseVisionCoordinates('I cannot see anything here'), null)
})

test('visualAct executes click, typing, and drag on real page', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <style>
      body { margin: 0; padding: 20px; font-family: sans-serif; }
      #btn { padding: 10px 20px; font-size: 16px; }
      #input { margin-top: 10px; padding: 8px; font-size: 16px; }
      #box { width: 100px; height: 100px; background: red; position: absolute; top: 150px; left: 50px; }
    </style>
    <button id="btn" onclick="this.textContent = 'Clicked!'">Submit</button>
    <br/>
    <input id="input" type="text" placeholder="Type here" />
    <div id="box"></div>
    <script>
      let isDragging = false;
      const box = document.getElementById('box');
      box.addEventListener('mousedown', () => { isDragging = true; });
      window.addEventListener('mouseup', () => { isDragging = false; });
      window.addEventListener('mousemove', e => {
        if (isDragging) {
          box.style.left = (e.clientX - 50) + 'px';
          box.style.top = (e.clientY - 50) + 'px';
        }
      });
    </script>
  `)

  // 1. Click button by coordinates
  const btnBox = await page.locator('#btn').boundingBox()
  const btnX = btnBox.x + btnBox.width / 2
  const btnY = btnBox.y + btnBox.height / 2

  const clickRes = await executeVisualAct(page, {
    action: 'click',
    x: btnX,
    y: btnY,
    coordinateType: 'pixel',
    highlight: true,
  })
  assert.equal(clickRes.action, 'click')
  assert.equal(await page.locator('#btn').textContent(), 'Clicked!')

  // 2. Type at input coordinates
  const inputEl = page.locator('#input')
  const inputBox = await inputEl.boundingBox()
  const inputX = inputBox.x + inputBox.width / 2
  const inputY = inputBox.y + inputBox.height / 2

  const typeRes = await executeVisualAct(page, {
    action: 'type',
    x: inputX,
    y: inputY,
    text: 'Hello Vision!',
    clear: true,
  })
  assert.equal(typeRes.action, 'type')
  assert.equal(await inputEl.inputValue(), 'Hello Vision!')

  // 3. Drag box
  const dragRes = await executeVisualAct(page, {
    action: 'drag',
    x: 100,
    y: 200,
    targetX: 250,
    targetY: 300,
  })
  assert.equal(dragRes.action, 'drag')
  const newBoxPos = await page.locator('#box').boundingBox()
  assert.ok(newBoxPos.x > 100, 'Box should have moved horizontally')
})

test('captureVisualScreenshot captures grid and SoM marks', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="padding: 30px;">
      <button id="b1">Button One</button>
      <a href="#test" id="a1">Link One</a>
      <input type="text" placeholder="Search Box" />
    </div>
  `)

  const testDir = join(tmpdir(), `pw-vis-test-${Date.now()}`)
  t.after(() => rm(testDir, { recursive: true, force: true }).catch(() => {}))

  // 1. Screenshot with grid and base64
  const shotGrid = await captureVisualScreenshot(page, testDir, {
    grid: true,
    gridInterval: 100,
    returnBase64: true,
  })
  assert.ok(shotGrid.path.endsWith('.png'))
  assert.ok(shotGrid.base64.startsWith('data:image/png;base64,'))
  assert.equal(shotGrid.gridEnabled, true)
  assert.equal(shotGrid.width, 800)

  // Verify grid overlay was cleaned up from page
  const gridRemains = await page.evaluate(() => Boolean(document.getElementById('dsh-vision-grid')))
  assert.equal(gridRemains, false, 'Grid overlay should be removed after screenshot')

  // 2. Screenshot with Set-of-Marks
  const shotSoM = await captureVisualScreenshot(page, testDir, {
    som: true,
  })
  assert.equal(shotSoM.somEnabled, true)
  assert.ok(Array.isArray(shotSoM.marks))
  assert.ok(shotSoM.marks.length >= 3, 'Should have at least 3 marks for button, link, and input')
  assert.ok(shotSoM.marks.some(m => m.name.includes('Button One')))

  const somRemains = await page.evaluate(() => Boolean(document.getElementById('dsh-som-container')))
  assert.equal(somRemains, false, 'SoM overlay should be removed after screenshot')
})

test('findVisualElementByDescription locates DOM elements by text, role suffix stripping and reverse inclusion', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="padding: 20px;">
      <button id="btn-login" style="position: absolute; left: 100px; top: 80px; width: 120px; height: 40px;">登录系统</button>
      <button id="btn-reset" style="position: absolute; left: 250px; top: 80px; width: 100px; height: 40px;">重置</button>
      <input id="inp-user" type="text" placeholder="输入用户名" style="position: absolute; left: 100px; top: 150px; width: 200px; height: 30px;" />
      <a href="#help" id="link-help" style="position: absolute; left: 100px; top: 220px; width: 120px; height: 30px;">使用帮助</a>
    </div>
  `)

  // 1. 直接全词匹配
  const btnMatch = await findVisualElementByDescription(page, '登录系统')
  assert.ok(btnMatch, 'Should find login button')
  assert.equal(btnMatch.x, 160) // 100 + 120/2
  assert.equal(btnMatch.y, 100) // 80 + 40/2

  // 2. 剥离“按钮”后缀与反向包含："重置按钮" 匹配文案仅为 "重置" 的 <button>
  const resetBtnMatch = await findVisualElementByDescription(page, '重置按钮')
  assert.ok(resetBtnMatch, 'Should match button "重置" via stripped suffix and role alignment')
  assert.equal(resetBtnMatch.x, 300) // 250 + 100/2
  assert.equal(resetBtnMatch.y, 100) // 80 + 40/2
  assert.equal(resetBtnMatch.tag, 'button')

  // 3. 剥离“输入框”后缀并反向包含："用户名输入框" 匹配 placeholder 为 "输入用户名" 的 <input>
  const inputMatch = await findVisualElementByDescription(page, '用户名输入框')
  assert.ok(inputMatch, 'Should find username input by stripped role "输入框"')
  assert.equal(inputMatch.x, 200) // 100 + 200/2
  assert.equal(inputMatch.y, 165) // 150 + 30/2
  assert.equal(inputMatch.tag, 'input')

  // 4. 剥离“链接”后缀："使用帮助链接" 匹配 "使用帮助" 的 <a>
  const linkMatch = await findVisualElementByDescription(page, '使用帮助链接')
  assert.ok(linkMatch, 'Should find help link')
  assert.equal(linkMatch.tag, 'a')
})

test('BrowserManager integrates visualAct, visualScreenshot, and visualClick with trajectory recording', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setContent('<button id="target" onclick="window._clicked=true">Click Me</button>')

  const testDir = join(tmpdir(), `pw-bm-vis-${Date.now()}`)
  t.after(() => rm(testDir, { recursive: true, force: true }).catch(() => {}))

  const manager = new BrowserManager({ read: async () => defaults }, testDir)
  const pageId = manager.track(page)
  manager.page = async () => page
  manager.ensureContext = async () => browser
  manager.trajectories.set(pageId, { steps: [] })

  // 1. visualAct
  const box = await page.locator('#target').boundingBox()
  const actRes = await manager.visualAct({
    pageId,
    action: 'click',
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  assert.equal(actRes.pageId, pageId)
  assert.equal(actRes.action, 'click')
  assert.equal(await page.evaluate(() => window._clicked), true)

  // Verify trajectory step
  const trajectory = manager.trajectory(pageId)
  assert.ok(trajectory.steps.some(s => s.type === 'visual_act'))

  // 2. visualScreenshot
  const shotRes = await manager.visualScreenshot({ pageId, grid: true })
  assert.equal(shotRes.pageId, pageId)
  assert.equal(shotRes.gridEnabled, true)

  // 3. visualClick with DOM fallback
  const clickRes = await manager.visualClick({
    pageId,
    description: 'Click Me',
  })
  assert.equal(clickRes.groundedBy, 'dom_visual_rect')
  assert.equal(clickRes.action, 'click')
})

test('captureVisualScreenshot returns accurate fullPage dimensions and marks', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="height: 2500px; width: 1200px; background: linear-gradient(to bottom, #111, #444); position: relative;">
      <button style="position: absolute; top: 2200px; left: 100px;">Bottom Button</button>
    </div>
  `)

  const testDir = join(tmpdir(), `pw-vis-full-${Date.now()}`)
  t.after(() => rm(testDir, { recursive: true, force: true }).catch(() => {}))

  const shot = await captureVisualScreenshot(page, testDir, { fullPage: true, som: true })
  assert.equal(shot.fullPage, true)
  assert.ok(shot.height >= 2500, `fullPage height should be >= 2500, got ${shot.height}`)
  assert.ok(shot.width >= 1200, `fullPage width should be >= 1200, got ${shot.width}`)
  assert.deepEqual(shot.viewport, { width: 800, height: 600 })
  assert.ok(shot.marks.some(m => m.name.includes('Bottom Button')), 'Bottom button should be marked in fullPage SoM')
})

test('browser query value reads input value via ID selector directly', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setContent('<input id="note" value="Initial Typed Value" />')

  const manager = new BrowserManager({ read: async () => defaults }, '')
  const pageId = manager.track(page)
  manager.page = async () => page

  const res = await manager.query(pageId, undefined, '#note', 'value')
  assert.equal(res.value, 'Initial Typed Value')
})

test('executeVisualAct auto-scrolls to document coordinates beyond viewport', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="height: 3000px; position: relative;">
      <button id="deep-btn" style="position: absolute; top: 2200px; left: 150px; width: 120px; height: 40px;" onclick="window._deepClicked=true">Deep Button</button>
    </div>
  `)

  // Target button at (210, 2220)
  const actRes = await executeVisualAct(page, {
    action: 'click',
    x: 210,
    y: 2220,
    coordinateMode: 'auto',
    autoScroll: true,
  })

  assert.equal(actRes.action, 'click')
  assert.equal(actRes.coordinates.scrolled, true)
  assert.equal(await page.evaluate(() => window._deepClicked), true)
  assert.ok(await page.evaluate(() => window.scrollY > 1000), 'Page should have scrolled down')
})

test('SoM registry persists fullPage marks and visualClick with markId auto-scrolls and clicks', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="height: 3000px; position: relative;">
      <button id="top-btn">Top</button>
      <button id="bottom-btn" style="position: absolute; top: 2500px; left: 100px; width: 150px; height: 50px;" onclick="window._bottomClicked=true">Bottom</button>
    </div>
  `)

  const testDir = join(tmpdir(), `pw-vis-som-reg-${Date.now()}`)
  t.after(() => rm(testDir, { recursive: true, force: true }).catch(() => {}))

  const manager = new BrowserManager({ read: async () => defaults }, testDir)
  const pageId = manager.track(page)
  manager.page = async () => page
  manager.ensureContext = async () => browser
  manager.trajectories.set(pageId, { steps: [] })

  // 1. Take fullPage screenshot with SoM
  const shot = await manager.visualScreenshot({ pageId, fullPage: true, som: true })
  const bottomMark = shot.marks.find(m => m.name.includes('Bottom'))
  assert.ok(bottomMark, 'Bottom mark should be detected in fullPage screenshot')
  assert.ok(bottomMark.centerY > 2000)

  // 2. Click the mark by its markId directly - should retrieve from registry and auto-scroll
  const clickRes = await manager.visualClick({
    pageId,
    markId: bottomMark.markId,
  })

  assert.equal(clickRes.groundedBy, 'som_mark')
  assert.equal(clickRes.markId, bottomMark.markId)
  assert.equal(await page.evaluate(() => window._bottomClicked), true)
  assert.ok(await page.evaluate(() => window.scrollY > 1500), 'Window should have scrolled to bottom button')
})

test('visualClick with description suffix auto-scrolls and clicks deep DOM elements', async t => {
  const browser = await launchTestBrowser()
  if (!browser) return t.skip('No system browser found')
  t.after(() => browser.close())

  const page = await browser.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent(`
    <div style="height: 3200px; position: relative;">
      <button id="top-btn">顶部</button>
      <button id="deep-save-btn" style="position: absolute; top: 2600px; left: 120px; width: 140px; height: 45px;" onclick="window._deepSaved=true">保存</button>
    </div>
  `)

  const testDir = join(tmpdir(), `pw-vis-desc-deep-${Date.now()}`)
  t.after(() => rm(testDir, { recursive: true, force: true }).catch(() => {}))

  const manager = new BrowserManager({ read: async () => defaults }, testDir)
  const pageId = manager.track(page)
  manager.page = async () => page
  manager.ensureContext = async () => browser
  manager.trajectories.set(pageId, { steps: [] })

  // 使用带角色后缀的自然语言描述 "保存按钮"，目标文案为 "保存" 且位于 2600px 折叠线下方
  const clickRes = await manager.visualClick({
    pageId,
    description: '保存按钮',
  })

  assert.equal(clickRes.groundedBy, 'dom_visual_rect')
  assert.equal(clickRes.action, 'click')
  assert.equal(await page.evaluate(() => window._deepSaved), true, 'Deep button should have received the click event')
  assert.ok(await page.evaluate(() => window.scrollY > 1800), 'Page should have scrolled to center the deep button')
})
