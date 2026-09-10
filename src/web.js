import Schema from '@deepseek-ai/schemastery'
import { validateSettings } from './settings.js'

const settingsSchema = Schema.object({
  browser: Schema.union(['auto', 'chrome', 'msedge']).required(),
  headless: Schema.boolean().required(),
  timeoutMs: Schema.number().required(),
  width: Schema.number().required(),
  height: Schema.number().required(),
})

export function createWebHandler(settings, browser, runbooks) {
  const statusValue = async probe => {
    const [status, catalog] = await Promise.all([browser.status(probe), runbooks.catalog()])
    return { ...status, runbooks: catalog }
  }
  return async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (endpoint === 'status') { const value = await statusValue(false); signal.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'probe') { const value = await statusValue(true); signal.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'save') {
        const validated = validateSettings(settingsSchema(payload))
        signal.throwIfAborted()
        await settings.write(validated)
        await browser.dispose()
        return { ok: true, value: await statusValue(false) }
      }
      if (endpoint === 'runbook-enable') {
        await runbooks.setEnabled(payload.id, payload.enabled)
        const [runbookCatalog, selectedRunbook, runbookVersions] = await Promise.all([
          runbooks.catalog(), runbooks.get(payload.id, true), runbooks.versions(payload.id),
        ])
        return { ok: true, value: { runbooks: runbookCatalog, selectedRunbook, runbookVersions } }
      }
      if (endpoint === 'runbook-detail') {
        const [selectedRunbook, runbookVersions] = await Promise.all([runbooks.get(payload.id, true), runbooks.versions(payload.id)])
        return { ok: true, value: { selectedRunbook, runbookVersions } }
      }
      if (endpoint === 'runbook-revise') {
        const selectedRunbook = await runbooks.save({ previousId: payload.id, name: payload.name, task: payload.task, instructions: payload.instructions,
          inputs: payload.inputs, preconditions: payload.preconditions, successCriteria: payload.successCriteria })
        return { ok: true, value: { selectedRunbook, runbookVersions: await runbooks.versions(selectedRunbook.id), runbooks: await runbooks.catalog() } }
      }
      if (endpoint === 'runbook-delete') { await runbooks.delete(payload.id); return { ok: true, value: { runbooks: await runbooks.catalog(), selectedRunbook: undefined, runbookVersions: [] } } }
      throw new Error('Unknown operation.')
    } catch (error) {
      const aborted = signal.aborted || error?.name === 'AbortError'
      return { ok: false, error: { code: aborted ? 'playwright/aborted' : 'playwright/rejected', message: aborted ? 'Browser operation was cancelled.' : String(error?.message || 'Browser operation failed.').slice(0, 500), details: {} } }
    }
  }
}
