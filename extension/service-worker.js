/**
 * DSH Chrome Bridge - Background Service Worker (Manifest V3)
 * Manages WebSocket connection to DSH Server and dispatches actions to browser tabs.
 */

const DEFAULT_SERVER_URL = 'ws://localhost:8765'
let socket = null
let reconnectTimer = null
let heartbeatTimer = null
let isConnecting = false

async function getConfig() {
  const data = await chrome.storage.local.get(['serverUrl', 'token', 'autoConnect'])
  return {
    serverUrl: data.serverUrl || DEFAULT_SERVER_URL,
    token: data.token || '',
    autoConnect: data.autoConnect !== false,
  }
}

async function setStatus(status, details = {}) {
  await chrome.storage.local.set({
    bridgeStatus: status,
    statusDetails: details,
    lastStatusUpdate: Date.now(),
  })
}

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      if (tabs && tabs.length > 0) return resolve(tabs[0])
      chrome.tabs.query({ active: true }, allActive => {
        resolve(allActive && allActive.length > 0 ? allActive[0] : null)
      })
    })
  })
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { method: 'ping' })
    if (response?.pong) return true
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
    return true
  } catch (err) {
    throw new Error(`Cannot interact with page (tabId: ${tabId}). Maybe it is a restricted chrome:// or edge:// page? Error: ${err.message}`)
  }
}

async function handleMessageFromBridge(request) {
  const { requestId, method, params = {} } = request

  try {
    if (method === 'browser.tabs') {
      const action = params.action || 'list'
      if (action === 'new') {
        const newTab = await chrome.tabs.create({})
        return {
          pages: [{ id: String(newTab.id), url: newTab.url || '', title: newTab.title || '' }],
        }
      }
      if (action === 'close') {
        if (!params.pageId) throw new Error('pageId is required to close tab.')
        await chrome.tabs.remove(Number(params.pageId))
        const tabs = await chrome.tabs.query({})
        return {
          pages: tabs.map(t => ({ id: String(t.id), url: t.url || '', title: t.title || '' })),
        }
      }
      const tabs = await chrome.tabs.query({})
      return {
        pages: tabs.map(t => ({ id: String(t.id), url: t.url || '', title: t.title || '' })),
      }
    }

    if (method === 'browser.open') {
      let tab
      if (params.pageId && params.pageId !== 'active') {
        tab = await chrome.tabs.update(Number(params.pageId), { url: params.url })
      } else {
        const active = await getActiveTab()
        if (active?.id) {
          tab = await chrome.tabs.update(active.id, { url: params.url })
        } else {
          tab = await chrome.tabs.create({ url: params.url })
        }
      }

      await new Promise(resolve => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }, 10000)
      })

      const updatedTab = await chrome.tabs.get(tab.id)
      return {
        pageId: String(updatedTab.id),
        url: updatedTab.url || params.url,
        title: updatedTab.title || '',
      }
    }

    if (method === 'browser.screenshot') {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' })
      return {
        ok: true,
        dataUrl,
      }
    }

    // Interactive operations targeting a specific tab or active tab
    let targetTab
    if (params.pageId && params.pageId !== 'active') {
      targetTab = await chrome.tabs.get(Number(params.pageId)).catch(() => null)
    }
    if (!targetTab) {
      targetTab = await getActiveTab()
    }
    if (!targetTab || !targetTab.id) {
      throw new Error('No active browser tab found to interact with.')
    }

    await ensureContentScript(targetTab.id)

    const response = await chrome.tabs.sendMessage(targetTab.id, { method, params })
    if (!response) throw new Error('No response received from page content script.')
    if (!response.ok) throw response.error

    return {
      pageId: String(targetTab.id),
      ...response.result,
    }
  } catch (err) {
    throw {
      code: err.code || 'BRIDGE_ACTION_FAILED',
      message: err.message || String(err),
    }
  }
}

async function connect() {
  if (isConnecting || (socket && socket.readyState === WebSocket.OPEN)) return
  isConnecting = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)

  const config = await getConfig()
  await setStatus('connecting', { url: config.serverUrl })

  try {
    let wsUrl = config.serverUrl
    if (config.token) {
      const u = new URL(wsUrl)
      u.searchParams.set('token', config.token)
      wsUrl = u.toString()
    }

    socket = new WebSocket(wsUrl)

    socket.onopen = async () => {
      isConnecting = false
      await setStatus('connected', { url: config.serverUrl })

      // Send auth/info handshake
      const activeTab = await getActiveTab()
      const manifest = chrome.runtime.getManifest()
      const extensionVersion = manifest.version_name || manifest.version || '0.2.0'
      socket.send(JSON.stringify({
        type: 'auth',
        token: config.token,
        clientInfo: {
          userAgent: navigator.userAgent,
          extensionVersion,
          manifestVersion: manifest.version,
          activeTab: activeTab ? { id: String(activeTab.id), url: activeTab.url, title: activeTab.title } : null,
        },
      }))

      // Heartbeat
      heartbeatTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, 20000)
    }

    socket.onmessage = async event => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }

      if (data.type === 'auth_ok') {
        await setStatus('connected', { authenticated: true })
        return
      }

      if (data.type === 'request' && data.requestId) {
        try {
          const result = await handleMessageFromBridge(data)
          socket.send(JSON.stringify({
            type: 'response',
            requestId: data.requestId,
            ok: true,
            result,
          }))
        } catch (err) {
          socket.send(JSON.stringify({
            type: 'response',
            requestId: data.requestId,
            ok: false,
            error: {
              code: err.code || 'ACTION_FAILED',
              message: err.message || String(err),
            },
          }))
        }
      }
    }

    socket.onclose = async event => {
      isConnecting = false
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      await setStatus('disconnected', { code: event.code, reason: event.reason })
      scheduleReconnect()
    }

    socket.onerror = async () => {
      isConnecting = false
      await setStatus('error', { message: 'WebSocket connection failed.' })
    }
  } catch (err) {
    isConnecting = false
    await setStatus('error', { message: err.message })
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(async () => {
    const config = await getConfig()
    if (config.autoConnect) {
      connect()
    }
  }, 5000)
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (socket) {
    socket.close(1000, 'User disconnected')
    socket = null
  }
  setStatus('disconnected', { manual: true })
}

// Listen for popup actions
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'connect') {
    connect().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg.action === 'disconnect') {
    disconnect()
    sendResponse({ ok: true })
    return true
  }
  if (msg.action === 'getStatus') {
    chrome.storage.local.get(['bridgeStatus', 'statusDetails']).then(data => {
      sendResponse({ status: data.bridgeStatus || 'disconnected', details: data.statusDetails || {} })
    })
    return true
  }
})

// Auto-start on load
chrome.storage.local.get(['autoConnect']).then(data => {
  if (data.autoConnect !== false) {
    connect()
  }
})
