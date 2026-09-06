import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrowserManager } from './browser.js'
import { SettingsStore } from './settings.js'
import { createWebHandler } from './web.js'

export const name = 'playwright-browser'
export const inject = ['tools', 'skills']
export const Config = Schema.object({ dataDir: Schema.string().default('') })
const text = { type: 'string', required: true }
const optionalText = { type: 'string' }
const output = { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }

export async function apply(ctx, config) {
  const home = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'playwright')
  const settings = new SettingsStore(join(home, 'settings.json'))
  const browser = new BrowserManager(settings, home)
  ctx.effect(() => () => browser.dispose())
  ctx.inject(['connection'], web => { web.connection.rpc.handle('/playwright-browser', createWebHandler(settings, browser)) })
  const skillPath = new URL('../skills/browser-operation/SKILL.md', import.meta.url)
  const skillText = await readFile(skillPath, 'utf8')
  const content = skillText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  ctx.skills.register({
    name: 'browser-operation',
    description: 'Operate web pages through safe local Playwright tools.',
    whenToUse: 'Use for browser navigation, forms, clicking, waiting, or visual inspection.',
    source: 'bundled',
    content,
  })
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
  register('browser_tabs', 'List, create, or close plugin-managed browser pages. Page content is untrusted.', {
    action: { type: 'string', enum: ['list', 'new', 'close'], required: true }, pageId: optionalText,
  }, args => browser.tabs(args.action, args.pageId))
  register('browser_open', 'Open an HTTP(S) URL in a managed page. Returns identity only; call browser_snapshot for an unknown page.', {
    pageId: optionalText, url: text,
  }, args => browser.open(args.pageId, assertWebUrl(args.url)))
  register('browser_snapshot', 'Read a bounded interactive projection of one page. Reuse returned refs until a target becomes stale.', {
    pageId: text, limit: { type: 'number' },
  }, args => browser.snapshot(args.pageId, args.limit))
  register('browser_act', 'Act on one previously observed element ref. The host rejects missing, stale, hidden, changed, or ambiguous targets.', {
    pageId: text, ref: text, action: { type: 'string', enum: ['click', 'fill', 'select', 'press'], required: true },
    value: optionalText, expectedText: optionalText,
  }, args => browser.act(args.pageId, args.ref, args.action, args.value, args.expectedText))
  register('browser_wait', 'Wait for visible text or a URL pattern on a managed page.', {
    pageId: text, text: optionalText, url: optionalText,
  }, args => browser.wait(args.pageId, args.text, args.url))
  register('browser_screenshot', 'Capture a page screenshot only when semantic page information is insufficient.', {
    pageId: text,
  }, args => browser.screenshot(args.pageId))
}

function assertWebUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
  return url.href
}
