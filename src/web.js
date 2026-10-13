import Schema from '@deepseek-ai/schemastery'
import { validateSettings } from './settings.js'

const settingsSchema = Schema.object({
  browser: Schema.union(['auto', 'chrome', 'msedge']).required(),
  headless: Schema.boolean().required(),
  timeoutMs: Schema.number().required(),
  width: Schema.number().required(),
  height: Schema.number().required(),
  // The settings page also owns the backend policy and the Chrome Bridge endpoint.
  backend: Schema.union(['chrome-extension', 'playwright']),
  chromeBridge: Schema.object({
    enabled: Schema.boolean(),
    mode: Schema.union(['webServer', 'standalone']),
    path: Schema.string(),
    host: Schema.string(),
    port: Schema.number(),
    publicUrl: Schema.string(),
    requestTimeoutMs: Schema.number(),
    // `allowedOrigins` is deliberately absent: the card does not edit it, and a declared array would
    // arrive as an implicit `[]` and wipe the stored allowlist on a partial save. validateSettings
    // still validates every entry that does arrive.
  }),
})

/**
 * @param bridge Optional Chrome Bridge reporter. `status()` is the same report the
 *   `browser_bridge_status` tool returns, so the page and the agent agree on the connection state.
 */
export function createWebHandler(settings, browser, runbooks, bridge) {
  /** A failing bridge must degrade the page, not blank it. */
  const bridgeValue = async () => {
    if (typeof bridge?.status !== 'function') return undefined
    try { return await bridge.status() } catch (error) { return { enabled: false, listening: false, error: String(error?.message || error).slice(0, 300) } }
  }
  const statusValue = async probe => {
    const [status, catalog, bridgeStatus] = await Promise.all([browser.status(probe), runbooks.catalog(), bridgeValue()])
    return { ...status, runbooks: catalog, bridge: bridgeStatus }
  }
  return async (endpoint, payload, signal) => {
    try {
      signal?.throwIfAborted()
      if (endpoint === 'status') { const value = await statusValue(false); signal?.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'probe') { const value = await statusValue(true); signal?.throwIfAborted(); return { ok: true, value } }
      if (endpoint === 'save') {
        // The form owns a subset of the settings. Everything it does not send — and every bridge key
        // the form does not render, such as the TLS files — is carried over from the stored settings,
        // so saving the page can never silently disable the extension the tools now prefer.
        const stored = await settings.read()
        const incoming = settingsSchema(payload)
        const validated = validateSettings({
          ...stored,
          ...incoming,
          chromeBridge: { ...stored.chromeBridge, ...incoming.chromeBridge },
        })
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
export function createWebHttpHandler(settings, browser, runbooks, bridge) {
  const handler = createWebHandler(settings, browser, runbooks, bridge)
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
