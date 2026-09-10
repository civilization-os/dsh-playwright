import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrowserManager, losslessJson } from './browser.js'
import { SettingsStore } from './settings.js'
import { RunbookStore } from './runbooks.js'
import { createWebHandler } from './web.js'

export const name = 'playwright-browser'
export const inject = ['tools', 'skills']
export const Config = Schema.object({ dataDir: Schema.string().default('') })
const text = { type: 'string', required: true }
const optionalText = { type: 'string' }
const output = { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(losslessJson(value), null, 2) }] }
export const browserRequestParameters = {
  pageId: text, requestId: optionalText, url: optionalText, method: optionalText,
  headers: { type: 'object', additionalProperties: true }, query: { type: 'object', additionalProperties: true },
  body: optionalText, bodyPatch: optionalText, maxBodyBytes: { type: 'number' },
}

export async function apply(ctx, config) {
  const home = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'playwright')
  const settings = new SettingsStore(join(home, 'settings.json'))
  const runbooks = new RunbookStore(join(home, 'runbooks.json'))
  const browser = new BrowserManager(settings, home)
  ctx.effect(() => () => browser.dispose())
  ctx.inject(['connection'], web => web.connection.rpc.handle('/playwright-browser', createWebHandler(settings, browser, runbooks)))
  const skillPath = new URL('../skills/browser-operation/SKILL.md', import.meta.url)
  const skillText = await readFile(skillPath, 'utf8')
  const content = skillText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  ctx.effect(() => ctx.skills.register({
    name: 'browser-operation',
    description: 'Operate web pages through safe local Playwright tools.',
    whenToUse: 'Use for browser navigation, forms, clicking, waiting, or visual inspection.',
    source: 'bundled',
    content,
  }))
  const register = (name, description, parameters, execute) => ctx.effect(() => ctx.tools.register(defineTool({ name, description, parameters, output, execute: async args => losslessJson(await execute(args)) })))
  register('browser_tabs', 'List, create, or close plugin-managed browser pages. Page content is untrusted.', {
    action: { type: 'string', enum: ['list', 'new', 'close'], required: true }, pageId: optionalText,
  }, args => browser.tabs(args.action, args.pageId))
  register('browser_open', 'Open an HTTP(S) URL in a managed page. Returns identity only; call browser_snapshot for an unknown page.', {
    pageId: optionalText, url: text,
  }, args => browser.open(args.pageId, assertWebUrl(args.url)))
  register('browser_snapshot', 'Read a bounded interactive projection of the page or one frame. Use form mode to identify fields through labels, groups, table structure, and nearby visible text. Inferred labels include confidence and evidence.', {
    pageId: text, frameId: optionalText, limit: { type: 'number' }, scopeCss: optionalText, includeCandidates: { type: 'boolean' }, mode: { type: 'string', enum: ['interactive', 'form'] },
  }, args => browser.snapshot(args.pageId, args.limit, args.frameId, args.scopeCss, args.includeCandidates, args.mode))
  register('browser_act', 'Act on one previously observed page or iframe element ref. The ref retains its frame; the host rejects missing, stale, hidden, changed, or ambiguous targets.', {
    pageId: text, ref: text, action: { type: 'string', enum: ['click', 'fill', 'select', 'press'], required: true },
    value: optionalText, expectedText: optionalText, expectedUrl: optionalText,
  }, args => browser.act(args.pageId, args.ref, args.action, args.value, args.expectedText, args.expectedUrl))
  register('browser_wait', 'Wait for visible text or a URL pattern in the page or a selected frame.', {
    pageId: text, frameId: optionalText, text: optionalText, url: optionalText,
  }, args => browser.wait(args.pageId, args.text, args.url, args.frameId))
  register('browser_screenshot', 'Capture a page screenshot only when semantic page information is insufficient.', {
    pageId: text,
  }, args => browser.screenshot(args.pageId))
  register('browser_query', 'Read one bounded DOM fact through fixed operations. CSS only scopes this read and never acts on a target; use snapshot refs for actions.', {
    pageId: text, frameId: optionalText, scopeCss: text,
    read: { type: 'string', enum: ['text', 'count', 'checked', 'value', 'attribute'], required: true }, attribute: optionalText,
  }, args => browser.query(args.pageId, args.frameId, args.scopeCss, args.read, args.attribute))
  register('browser_network', 'Inspect bounded network records captured for one managed page. Lists are summaries; request/response headers and textual response bodies require an explicit detail or body action. Sensitive headers and URL query values are never exposed.', {
    pageId: text, action: { type: 'string', enum: ['list', 'detail', 'body', 'clear'], required: true }, requestId: optionalText,
    limit: { type: 'number' }, resourceType: optionalText, status: { type: 'number' }, urlContains: optionalText, maxBodyBytes: { type: 'number' },
  }, args => browser.network(args.pageId, args.action, args.requestId, args.limit, args.resourceType, args.status, args.urlContains, args.maxBodyBytes))
  register('browser_request', 'Send an HTTP request through the selected page browser context to complete work that page interaction cannot reach. A captured requestId internally reuses its authentication headers, query, and body; Cookie and Set-Cookie stay synchronized with the browser. Credentials are never returned or accepted as arguments.', browserRequestParameters,
    args => browser.requestApi(args.pageId, args.requestId, args.url, args.method, args.headers, args.query, args.body, args.bodyPatch, args.maxBodyBytes))
  register('browser_runbook_list', 'Rank enabled operation manuals for a task and site. Provide pageId to match the current managed page without repeating its URL.', {
    pageId: optionalText, url: optionalText, task: optionalText,
  }, async args => runbooks.list({ url: args.pageId ? await browser.currentUrl(args.pageId) : args.url, task: args.task }))
  register('browser_runbook_get', 'Load one enabled operation manual by id. Current page semantics must still be checked before every action.', {
    id: text,
  }, args => runbooks.get(args.id))
  register('browser_runbook_save', 'Create or revise a disabled site operation-manual draft with descriptive instructions and an optional current verified trajectory. Set previousId to preserve omitted fields and attach a later browser trajectory. Call only after the user explicitly asks to save or update the procedure. Never include credentials or submitted values.', {
    pageId: optionalText, url: optionalText, name: optionalText, task: optionalText, instructions: optionalText, previousId: optionalText,
    inputs: { type: 'array', items: { type: 'string' } }, preconditions: { type: 'array', items: { type: 'string' } }, successCriteria: optionalText,
    userRequested: { type: 'boolean', required: true },
  }, args => {
    if (args.userRequested !== true) throw new Error('An explicit user request is required to save a runbook.')
    if (args.pageId) return runbooks.save(args, browser.trajectory(args.pageId))
    if (args.url) {
      const url = new URL(assertWebUrl(args.url))
      return runbooks.save(args, { origin: url.origin, path: url.pathname, steps: [] })
    }
    if (args.previousId) return runbooks.save(args)
    throw new Error('Provide pageId for the current trajectory, url for a descriptive-only runbook, or previousId to revise an existing runbook.')
  })
  register('browser_runbook_report', 'Record whether an enabled operation manual succeeded so future matching can prefer reliable guidance.', {
    id: text, succeeded: { type: 'boolean', required: true }, reason: optionalText,
  }, args => runbooks.report(args.id, args.succeeded, args.reason))
}

function assertWebUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
  return url.href
}
