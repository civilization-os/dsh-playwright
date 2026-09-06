import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_RUNBOOKS = 200
const MAX_STEPS = 100
const MAX_FILE_BYTES = 2 * 1024 * 1024

export class RunbookStore {
  constructor(path) { this.path = path; this.mutations = Promise.resolve() }
  async read() {
    try { return parseRunbooks(await readBounded(this.path)) }
    catch (error) {
      if (error.code === 'ENOENT') return []
      try { return parseRunbooks(await readBounded(`${this.path}.bak`)) }
      catch { throw error }
    }
  }
  async list({ url, task, includeDisabled = false } = {}) {
    const runbooks = await this.read(); const parsed = url ? lookupSite(url) : undefined
    const words = clean(task, 500).toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return runbooks.filter(item => (includeDisabled || item.enabled)
      && (!parsed || item.origin === parsed.origin && pathMatches(item.path, parsed.path))
      && (!words.length || words.some(word => `${item.name} ${item.task} ${item.instructions}`.toLocaleLowerCase().includes(word))))
      .slice(0, MAX_RUNBOOKS).map(summary)
  }
  async get(id, includeDisabled = false) {
    const item = (await this.read()).find(value => value.id === id)
    if (!item || (!includeDisabled && !item.enabled)) throw new Error('Unknown or disabled runbook.')
    return structuredClone(item)
  }
  save(args, trajectory) {
    return this.mutate(async runbooks => {
      const previous = args.previousId ? runbooks.find(item => item.id === args.previousId) : undefined
      if (args.previousId && !previous) throw new Error('Unknown previous runbook.')
      const name = clean(args.name ?? previous?.name, 160); const task = clean(args.task ?? previous?.task, 500)
      if (!name || !task) throw new Error('Runbook name and task are required.')
      const instructions = cleanMultiline(args.instructions === undefined ? previous?.instructions : args.instructions, 12000)
      const source = trajectory || (previous && { origin: previous.origin, path: previous.path, steps: previous.steps })
      if (!source) throw new Error('A valid runbook site is required.')
      const site = assertSite(`${source.origin}${source.path}`); const steps = validateSteps(source.steps?.length ? source.steps : previous?.steps || [])
      if (previous && site.origin !== previous.origin) throw new Error('A runbook revision must use the same site origin.')
      if (!instructions && !steps.length) throw new Error('Runbook instructions or a reusable browser trajectory are required.')
      if (runbooks.length >= MAX_RUNBOOKS) throw new Error(`At most ${MAX_RUNBOOKS} runbooks may be stored.`)
      const now = new Date().toISOString()
      const item = validateStored({ id: `runbook-${randomUUID().slice(0, 8)}`, name, task, origin: site.origin, path: site.path, version: (previous?.version ?? 0) + 1, previousId: previous?.id || '', enabled: false, createdAt: now, updatedAt: now, successCount: 0, failureCount: 0, instructions, steps })
      runbooks.push(item); return item
    })
  }
  setEnabled(id, enabled) {
    return this.mutate(async runbooks => {
      const item = runbooks.find(value => value.id === id); if (!item) throw new Error('Unknown runbook.')
      if (enabled) {
        const lineage = lineageIds(runbooks, item)
        for (const value of runbooks) if (value.enabled && lineageIds(runbooks, value).some(valueId => lineage.includes(valueId))) value.enabled = false
      }
      item.enabled = Boolean(enabled); item.updatedAt = new Date().toISOString(); return item
    })
  }
  delete(id) {
    return this.mutate(async runbooks => { const index = runbooks.findIndex(value => value.id === id); if (index < 0) throw new Error('Unknown runbook.'); runbooks.splice(index, 1) })
  }
  async mutate(operation) {
    const run = async () => { const runbooks = await this.read(); const result = await operation(runbooks); await this.writeNow(runbooks); return structuredClone(result) }
    const pending = this.mutations.then(run, run); this.mutations = pending.then(() => undefined, () => undefined); return pending
  }
  async write(value) {
    const runbooks = parseRunbooks(JSON.stringify(value)); await this.writeNow(runbooks)
  }
  async writeNow(value) {
    if (value.length > MAX_RUNBOOKS) throw new Error(`At most ${MAX_RUNBOOKS} runbooks may be stored.`)
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`
    const content = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Runbook file is too large.')
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(content); await file.sync()
    } finally { await file.close() }
    try {
      await copyFile(this.path, `${this.path}.bak`).catch(error => { if (error.code !== 'ENOENT') throw error }); await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
}

async function readBounded(path) { const value = await readFile(path); if (value.byteLength > MAX_FILE_BYTES) throw new Error('Runbook file is too large.'); return value.toString('utf8') }
function parseRunbooks(text) { const value = JSON.parse(text); if (!Array.isArray(value) || value.length > MAX_RUNBOOKS) throw new Error('Invalid runbook file.'); return value.map(validateStored) }
function validateStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runbook entry.')
  for (const key of ['id', 'name', 'task', 'origin', 'path', 'createdAt', 'updatedAt']) if (typeof value[key] !== 'string') throw new Error(`Invalid runbook ${key}.`)
  if (!/^runbook-[a-z0-9-]+$/.test(value.id) && value.id !== 'legacy') throw new Error('Invalid runbook id.')
  const site = assertSite(`${value.origin}${value.path}`)
  if (!Number.isInteger(value.version) || value.version < 1 || typeof value.enabled !== 'boolean') throw new Error('Invalid runbook version or state.')
  if (value.previousId !== undefined && typeof value.previousId !== 'string') throw new Error('Invalid previous runbook id.')
  const instructions = cleanMultiline(value.instructions, 12000); const steps = validateSteps(value.steps)
  const successCount = count(value.successCount); const failureCount = count(value.failureCount)
  return { id: value.id, name: cleanRequired(value.name, 160), task: cleanRequired(value.task, 500), origin: site.origin, path: site.path, version: value.version, previousId: value.previousId || '', enabled: value.enabled, createdAt: assertDate(value.createdAt), updatedAt: assertDate(value.updatedAt), successCount, failureCount, instructions, steps }
}
function validateSteps(value) {
  if (!Array.isArray(value) || value.length > MAX_STEPS) throw new Error(`Runbook steps must contain at most ${MAX_STEPS} entries.`)
  return value.map(step => { if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid runbook step.'); const serialized = JSON.stringify(step); if (serialized.length > 4000 || serialized.includes('\u0000')) throw new Error('Invalid runbook step.'); return JSON.parse(serialized) })
}
function assertSite(value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Runbook sites require an HTTP(S) origin and path without credentials, query, or fragment.'); return { origin: url.origin, path: normalizePath(url.pathname) } }
function lookupSite(value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Runbook lookup requires an HTTP(S) URL without credentials.'); return { origin: url.origin, path: normalizePath(url.pathname) } }
function normalizePath(value) { const path = value.replace(/\/{2,}/g, '/'); return path.length > 1 ? path.replace(/\/$/, '') : '/' }
function pathMatches(base, current) { return base === '/' || current === base || current.startsWith(`${base}/`) }
function clean(value, max) { const result = String(value ?? '').trim().replace(/\s+/g, ' '); if (result.length > max || result.includes('\0')) throw new Error(`Text must be no longer than ${max} characters.`); return result }
function cleanRequired(value, max) { const result = clean(value, max); if (!result) throw new Error('Runbook text is required.'); return result }
function cleanMultiline(value, max) { const result = String(value ?? '').trim(); if (result.length > max || result.includes('\0')) throw new Error(`Runbook instructions must be safe text no longer than ${max} characters.`); return result }
function count(value) { return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0 }
function assertDate(value) { if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid runbook timestamp.'); return value }
function lineageIds(runbooks, item) { const ids = []; let current = item; while (current && !ids.includes(current.id)) { ids.push(current.id); current = runbooks.find(value => value.id === current.previousId) }; return ids }
function summary(item) { const instructionsPreview = item.instructions.length > 240 ? `${item.instructions.slice(0, 237)}...` : item.instructions; return { id: item.id, name: item.name, task: item.task, origin: item.origin, path: item.path, version: item.version, enabled: item.enabled, updatedAt: item.updatedAt, instructionsPreview, stepCount: item.steps.length } }
