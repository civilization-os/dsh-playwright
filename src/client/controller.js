export class BrowserController {
  // The defaults mirror src/settings.js: the user's own Chrome through the extension is the default
  // backend, and the bridge is off until the operator enables it.
  state = { configured: { browser: 'auto', headless: false, timeoutMs: 10000, width: 1280, height: 800, ignoreHTTPSErrors: false, exposeAuthFields: false, trustedOrigins: [], backend: 'chrome-extension', chromeBridge: { enabled: false, mode: 'webServer', path: '/chrome-bridge', host: '127.0.0.1', port: 0, publicUrl: '', tlsKeyFile: '', tlsCertFile: '', allowedOrigins: [], requestTimeoutMs: 30000 } }, browsers: [], selected: '', launch: 'unchecked', activePages: 0, bridge: undefined, runbooks: [], selectedRunbook: undefined, runbookVersions: [], loading: true, saving: false, error: '' }
  listeners = new Set()
  lifetime = new AbortController()
  requestId = 0
  constructor(call) { this.call = call }
  getSnapshot = () => this.state
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  publish(patch) { if (this.lifetime.signal.aborted) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  async request(endpoint, args = {}) {
    if (endpoint === 'status' && this.state.saving) return false
    const requestId = ++this.requestId
    const saving = endpoint !== 'status'
    this.publish({ loading: !saving, saving, error: '' })
    try {
      const result = await this.call(endpoint, args, this.lifetime.signal)
      if (requestId !== this.requestId) return false
      if (!result.ok) { this.publish({ loading: false, saving: false, error: 'failed' }); return false }
      this.publish({ ...result.value, loading: false, saving: false }); return true
    } catch { if (requestId === this.requestId) this.publish({ loading: false, saving: false, error: 'failed' }); return false }
  }
  dispose() { this.lifetime.abort(); this.listeners.clear() }
}
