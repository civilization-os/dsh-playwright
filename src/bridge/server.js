import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

export class ChromeBridgeServer {
  constructor(options = {}) {
    this.port = options.port || 8765
    this.host = options.host || '0.0.0.0'
    this.token = options.token || ''
    this.timeoutMs = options.timeoutMs || 15000
    this.wss = null
    this.activeSocket = null
    this.pendingRequests = new Map()
    this.clientInfo = null
    this.statusListeners = new Set()
  }

  async start() {
    if (this.wss) return
    return new Promise((resolve, reject) => {
      try {
        const wss = new WebSocketServer({
          host: this.host,
          port: this.port,
        })

        wss.on('listening', () => {
          this.wss = wss
          resolve()
        })

        wss.on('error', err => {
          reject(err)
        })

        wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  handleConnection(ws, req) {
    const url = new URL(req.url || '/', 'http://localhost')
    const queryToken = url.searchParams.get('token')

    let authenticated = false
    if (this.token && queryToken === this.token) {
      authenticated = true
    } else if (!this.token) {
      authenticated = true
    }

    let authTimer = null
    if (!authenticated) {
      // Allow auth handshake message within 5 seconds
      authTimer = setTimeout(() => {
        if (!authenticated) {
          try {
            ws.send(JSON.stringify({
              type: 'auth_error',
              error: { code: 'UNAUTHORIZED', message: 'Authentication failed: Invalid or missing token.' },
            }))
            ws.close(4001, 'Unauthorized')
          } catch {}
        }
      }, 5000)
    } else {
      this.promoteClient(ws, { queryAuth: true })
    }

    ws.on('message', data => {
      let msg
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }

      if (msg.type === 'auth') {
        if (this.token && msg.token !== this.token) {
          if (authTimer) clearTimeout(authTimer)
          try {
            ws.send(JSON.stringify({
              type: 'auth_error',
              error: { code: 'UNAUTHORIZED', message: 'Authentication failed: Token mismatch.' },
            }))
            ws.close(4001, 'Unauthorized')
          } catch {}
          return
        }
        authenticated = true
        if (authTimer) clearTimeout(authTimer)
        this.promoteClient(ws, msg.clientInfo || {})
        ws.send(JSON.stringify({ type: 'auth_ok', ok: true }))
        return
      }

      if (!authenticated) return

      if (msg.type === 'response' && msg.requestId) {
        const pending = this.pendingRequests.get(msg.requestId)
        if (pending) {
          this.pendingRequests.delete(msg.requestId)
          clearTimeout(pending.timer)
          if (msg.ok) {
            pending.resolve(msg.result)
          } else {
            const err = new Error(msg.error?.message || 'Bridge request failed.')
            err.code = msg.error?.code || 'BRIDGE_ERROR'
            err.details = msg.error?.details
            pending.reject(err)
          }
        }
        return
      }

      if (msg.type === 'status_update') {
        this.clientInfo = { ...this.clientInfo, ...msg.data }
        this.notifyStatus()
        return
      }

      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })) } catch {}
      }
    })

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer)
      if (this.activeSocket === ws) {
        this.activeSocket = null
        this.clientInfo = null
        this.rejectAllPending(new Error('Chrome extension bridge connection closed.'))
        this.notifyStatus()
      }
    })

    ws.on('error', () => {
      if (this.activeSocket === ws) {
        this.activeSocket = null
        this.clientInfo = null
        this.rejectAllPending(new Error('Chrome extension bridge connection error.'))
        this.notifyStatus()
      }
    })
  }

  promoteClient(ws, clientInfo) {
    if (this.activeSocket && this.activeSocket !== ws) {
      try { this.activeSocket.close(1000, 'Replaced by newer connection') } catch {}
    }
    this.activeSocket = ws
    this.clientInfo = clientInfo
    this.notifyStatus()
  }

  notifyStatus() {
    for (const listener of this.statusListeners) {
      try { listener(this.getStatus()) } catch {}
    }
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getStatus() {
    return {
      connected: Boolean(this.activeSocket && this.activeSocket.readyState === 1),
      port: this.port,
      tokenConfigured: Boolean(this.token),
      clientInfo: this.clientInfo || undefined,
    }
  }

  rejectAllPending(error) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      const err = new Error(error.message)
      err.code = 'BRIDGE_DISCONNECTED'
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  async sendRequest(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.activeSocket || this.activeSocket.readyState !== 1) {
      const err = new Error('Chrome extension is not connected to DSH Bridge. Please open your Chrome, install the DSH Chrome Bridge extension, and connect.')
      err.code = 'BRIDGE_NOT_CONNECTED'
      throw err
    }

    const requestId = `req-${randomUUID().slice(0, 8)}`
    const requestMessage = {
      type: 'request',
      requestId,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        const err = new Error(`Bridge request timed out after ${timeoutMs}ms for method ${method}.`)
        err.code = 'BRIDGE_TIMEOUT'
        reject(err)
      }, timeoutMs)

      this.pendingRequests.set(requestId, { resolve, reject, timer, method })

      try {
        this.activeSocket.send(JSON.stringify(requestMessage), sendErr => {
          if (sendErr) {
            clearTimeout(timer)
            this.pendingRequests.delete(requestId)
            const err = new Error(`Failed to send message to extension: ${sendErr.message}`)
            err.code = 'BRIDGE_SEND_FAILED'
            reject(err)
          }
        })
      } catch (err) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  async stop() {
    this.rejectAllPending(new Error('Chrome bridge server is stopping.'))
    if (this.activeSocket) {
      try { this.activeSocket.close(1000, 'Server stopping') } catch {}
      this.activeSocket = null
    }
    if (this.wss) {
      await new Promise(resolve => {
        this.wss.close(() => resolve())
      })
      this.wss = null
    }
  }
}
