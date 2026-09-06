import Schema from '@deepseek-ai/schemastery'

const settingsSchema = Schema.object({
  browser: Schema.union(['auto', 'chrome', 'msedge']).required(),
  headless: Schema.boolean().required(),
  timeoutMs: Schema.number().required(),
  width: Schema.number().required(),
  height: Schema.number().required(),
})

export function createWebHandler(settings, browser) {
  return async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (endpoint === 'status') return { ok: true, value: await browser.status(false) }
      if (endpoint === 'probe') return { ok: true, value: await browser.status(true) }
      if (endpoint === 'save') {
        await browser.dispose()
        await settings.write(settingsSchema(payload))
        return { ok: true, value: await browser.status(false) }
      }
      throw new Error('Unknown operation.')
    } catch {
      return { ok: false, error: { code: 'playwright/rejected', message: 'Browser operation failed.', details: {} } }
    }
  }
}
