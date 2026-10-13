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
      signal?.throwIfAborted()
      if (endpoint === 'status') { const value = await statusValue(false); signal?.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'probe') { const value = await statusValue(true); signal?.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'save') {
        const validated = validateSettings(settingsSchema(payload))
        signal?.throwIfAborted()
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
      const aborted = signal?.aborted || error?.name === 'AbortError'
      return { ok: false, error: { code: aborted ? 'playwright/aborted' : 'playwright/rejected', message: aborted ? 'Browser operation was cancelled.' : String(error?.message || 'Browser operation failed.').slice(0, 500), details: {} } }
    }
  }
}

/** HTTP server route handler that satisfies DSH WebServer and RPC envelope protocols. */
export function createWebHttpHandler(settings, browser, runbooks) {
  const handler = createWebHandler(settings, browser, runbooks)
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, *',
      })
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { message: 'Method Not Allowed' } }))
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const endpoint = pathname.startsWith('/playwright-browser/') ? pathname.slice('/playwright-browser/'.length)
      : pathname === '/playwright-browser' ? 'status' : undefined
    if (!endpoint) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { message: 'Not Found' } }))
      return
    }

    let raw = ''
    try {
      for await (const chunk of req) raw += chunk.toString('utf8')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { message: 'Failed to read request body.' } }))
      return
    }

    let body = {}
    if (raw.trim()) {
      try { body = JSON.parse(raw) }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { message: 'Invalid JSON body.' } }))
        return
      }
    }

    const isRpcEnvelope = body && body.type === 'client-request' && typeof body.rpcId === 'string'
    const actualEndpoint = isRpcEnvelope ? (body.method || endpoint) : endpoint
    const payload = isRpcEnvelope ? (body.payload ?? {}) : body

    const result = await handler(actualEndpoint, payload, req.signal)

    const responseBody = isRpcEnvelope
      ? { type: 'server-response', rpcId: body.rpcId, result }
      : result

    const data = JSON.stringify(responseBody)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
    })
    res.end(data)
  }
}
