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
  return async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (endpoint === 'status') { const value = { ...await browser.status(false), runbooks: await runbooks.list({ includeDisabled: true }) }; signal.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'probe') { const value = { ...await browser.status(true), runbooks: await runbooks.list({ includeDisabled: true }) }; signal.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'save') {
        const validated = validateSettings(settingsSchema(payload))
        signal.throwIfAborted()
        await settings.write(validated)
        await browser.dispose()
        return { ok: true, value: { ...await browser.status(false), runbooks: await runbooks.list({ includeDisabled: true }) } }
      }
      if (endpoint === 'runbook-enable') { await runbooks.setEnabled(payload.id, payload.enabled); return { ok: true, value: { runbooks: await runbooks.list({ includeDisabled: true }) } } }
      if (endpoint === 'runbook-delete') { await runbooks.delete(payload.id); return { ok: true, value: { runbooks: await runbooks.list({ includeDisabled: true }) } } }
      throw new Error('Unknown operation.')
    } catch (error) {
      const aborted = signal.aborted || error?.name === 'AbortError'
      return { ok: false, error: { code: aborted ? 'playwright/aborted' : 'playwright/rejected', message: aborted ? 'Browser operation was cancelled.' : String(error?.message || 'Browser operation failed.').slice(0, 500), details: {} } }
    }
  }
}
