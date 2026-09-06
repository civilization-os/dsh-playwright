import Schema from '@deepseek-ai/schemastery'

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
      if (endpoint === 'status') return { ok: true, value: { ...await browser.status(false), runbooks: await runbooks.list({ includeDisabled: true }) } }
      if (endpoint === 'probe') return { ok: true, value: { ...await browser.status(true), runbooks: await runbooks.list({ includeDisabled: true }) } }
      if (endpoint === 'save') {
        await browser.dispose()
        await settings.write(settingsSchema(payload))
        return { ok: true, value: { ...await browser.status(false), runbooks: await runbooks.list({ includeDisabled: true }) } }
      }
      if (endpoint === 'runbook-enable') { await runbooks.setEnabled(payload.id, payload.enabled); return { ok: true, value: { runbooks: await runbooks.list({ includeDisabled: true }) } } }
      if (endpoint === 'runbook-delete') { await runbooks.delete(payload.id); return { ok: true, value: { runbooks: await runbooks.list({ includeDisabled: true }) } } }
      throw new Error('Unknown operation.')
    } catch {
      return { ok: false, error: { code: 'playwright/rejected', message: 'Browser operation failed.', details: {} } }
    }
  }
}
