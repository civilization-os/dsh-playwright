export class BrowserController {
  state = { configured: { browser: 'auto', headless: false, timeoutMs: 10000, width: 1280, height: 800 }, browsers: [], selected: '', launch: 'unchecked', activePages: 0, runbooks: [], loading: true, saving: false, error: '' }
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
