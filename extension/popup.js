document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge')
  const statusText = document.getElementById('statusText')
  const serverUrlInput = document.getElementById('serverUrl')
  const tokenInput = document.getElementById('token')
  const btnConnect = document.getElementById('btnConnect')
  const btnDisconnect = document.getElementById('btnDisconnect')
  const activeTabUrl = document.getElementById('activeTabUrl')

  // Load saved settings
  const stored = await chrome.storage.local.get(['serverUrl', 'token', 'bridgeStatus'])
  serverUrlInput.value = stored.serverUrl || 'ws://localhost:8765'
  tokenInput.value = stored.token || ''
  updateStatusUI(stored.bridgeStatus || 'disconnected')

  // Display version
  const manifest = chrome.runtime.getManifest()
  const versionText = document.getElementById('versionText')
  if (versionText) {
    versionText.textContent = `版本: ${manifest.version_name || manifest.version || '0.2.0'}`
  }

  // Get active tab URL
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs && tabs[0]) {
      activeTabUrl.textContent = tabs[0].url || '空白页'
    } else {
      activeTabUrl.textContent = '无法获取当前标签'
    }
  })

  // Poll status
  setInterval(async () => {
    const data = await chrome.storage.local.get(['bridgeStatus'])
    updateStatusUI(data.bridgeStatus || 'disconnected')
  }, 1000)

  btnConnect.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim() || 'ws://localhost:8765'
    const token = tokenInput.value.trim()
    await chrome.storage.local.set({ serverUrl, token, autoConnect: true })
    updateStatusUI('connecting')
    chrome.runtime.sendMessage({ action: 'connect' })
  })

  btnDisconnect.addEventListener('click', async () => {
    await chrome.storage.local.set({ autoConnect: false })
    chrome.runtime.sendMessage({ action: 'disconnect' })
    updateStatusUI('disconnected')
  })

  function updateStatusUI(status) {
    statusBadge.className = 'badge ' + status
    if (status === 'connected') {
      statusText.textContent = '已连接'
    } else if (status === 'connecting') {
      statusText.textContent = '连接中...'
    } else if (status === 'error') {
      statusText.textContent = '连接异常'
    } else {
      statusText.textContent = '未连接'
    }
  }
})
