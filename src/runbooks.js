import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class RunbookStore {
  constructor(path) { this.path = path }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(value)) throw new Error('Invalid runbook file.')
      return value.map(validateStored)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  async list({ url, task, includeDisabled = false } = {}) {
    const runbooks = await this.read()
    const origin = url ? new URL(url).origin : ''
    const words = String(task || '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return runbooks.filter(item => (includeDisabled || item.enabled)
      && (!origin || item.origin === origin)
      && (!words.length || words.some(word => `${item.name} ${item.task}`.toLocaleLowerCase().includes(word))))
      .map(summary)
  }
  async get(id, includeDisabled = false) {
    const item = (await this.read()).find(value => value.id === id)
    if (!item || (!includeDisabled && !item.enabled)) throw new Error('Unknown or disabled runbook.')
    return item
  }
  async save({ name, task, previousId }, trajectory) {
    if (!name?.trim() || !task?.trim()) throw new Error('Runbook name and task are required.')
    if (!trajectory?.steps?.length) throw new Error('The current page has no reusable browser trajectory.')
    const runbooks = await this.read()
    const previous = previousId ? runbooks.find(item => item.id === previousId) : undefined
    if (previousId && !previous) throw new Error('Unknown previous runbook.')
    const now = new Date().toISOString()
    const item = validateStored({
      id: `runbook-${randomUUID().slice(0, 8)}`, name: name.trim(), task: task.trim(),
      origin: trajectory.origin, path: trajectory.path, version: (previous?.version ?? 0) + 1,
      previousId: previous?.id || '', enabled: false, createdAt: now, updatedAt: now,
      successCount: 0, failureCount: 0, steps: trajectory.steps,
    })
    runbooks.push(item)
    await this.write(runbooks)
    return item
  }
  async setEnabled(id, enabled) {
    const runbooks = await this.read()
    const item = runbooks.find(value => value.id === id)
    if (!item) throw new Error('Unknown runbook.')
    item.enabled = Boolean(enabled); item.updatedAt = new Date().toISOString()
    await this.write(runbooks)
    return item
  }
  async delete(id) {
    const runbooks = await this.read()
    const next = runbooks.filter(value => value.id !== id)
    if (next.length === runbooks.length) throw new Error('Unknown runbook.')
    await this.write(next)
  }
  async write(value) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
    await rename(temporary, this.path)
  }
}

function validateStored(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps)) throw new Error('Invalid runbook entry.')
  for (const key of ['id', 'name', 'task', 'origin', 'path', 'createdAt', 'updatedAt']) if (typeof value[key] !== 'string') throw new Error(`Invalid runbook ${key}.`)
  if (!Number.isInteger(value.version) || typeof value.enabled !== 'boolean') throw new Error('Invalid runbook version or state.')
  return value
}

function summary(item) {
  return { id: item.id, name: item.name, task: item.task, origin: item.origin, path: item.path, version: item.version, enabled: item.enabled, updatedAt: item.updatedAt, successCount: item.successCount, failureCount: item.failureCount, stepCount: item.steps.length }
}
