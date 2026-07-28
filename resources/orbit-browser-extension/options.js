/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const portInput = document.querySelector('#port')
const codeInput = document.querySelector('#code')
const pairButton = document.querySelector('#pair')
const retryButton = document.querySelector('#retry')
const disconnectButton = document.querySelector('#disconnect')
const refreshSitesButton = document.querySelector('#refresh-sites')
const statusElement = document.querySelector('#status')
const diagnosticsElement = document.querySelector('#diagnostics')
const sitesElement = document.querySelector('#sites')

function setStatus(message) {
  statusElement.textContent = message
}

function diagnosticItem(label, value) {
  const item = document.createElement('li')
  item.textContent = `${label}: ${value}`
  return item
}

async function renderStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null)
  if (!response) {
    setStatus('The extension service worker is unavailable.')
    diagnosticsElement.replaceChildren()
    return
  }
  portInput.value = response.activePort ? String(response.activePort) : portInput.value
  if (response.connected) {
    setStatus(`Connected to Orbit on 127.0.0.1:${response.activePort}.`)
  } else if (response.lastError?.message) {
    setStatus(response.lastError.message)
  } else if (response.paired) {
    setStatus('Paired with Orbit and reconnecting automatically.')
  } else {
    setStatus('Not paired with Orbit.')
  }
  diagnosticsElement.replaceChildren(
    diagnosticItem('Phase', response.phase ?? 'unknown'),
    diagnosticItem('Active port', response.activePort ?? 'none'),
    diagnosticItem(
      'Next retry',
      response.retryAt ? new Date(response.retryAt).toLocaleString() : 'not scheduled'
    ),
    diagnosticItem('Last error code', response.lastError?.code ?? 'none')
  )
}

async function renderSites() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null)
  const origins = Array.isArray(status?.grantedOrigins) ? [...status.grantedOrigins].sort() : []
  sitesElement.replaceChildren(
    ...origins.map((origin) => {
      const item = document.createElement('li')
      item.textContent = origin
      return item
    })
  )
  if (origins.length === 0) {
    const item = document.createElement('li')
    item.textContent = 'No optional sites granted.'
    sitesElement.append(item)
  }
}

pairButton.addEventListener('click', async () => {
  const port = Number(portInput.value)
  const code = codeInput.value.trim()
  if (!Number.isInteger(port) || port < 43117 || port > 43127 || !/^\d{6}$/.test(code)) {
    setStatus('Enter the Orbit port from 43117 to 43127 and exactly six digits.')
    return
  }
  pairButton.disabled = true
  setStatus('Pairing and waiting for authenticated reconnection…')
  const response = await chrome.runtime
    .sendMessage({ type: 'pair', port, code })
    .catch(() => ({ ok: false, message: 'The pairing request failed.' }))
  pairButton.disabled = false
  setStatus(response?.message ?? 'The pairing request failed.')
  if (response?.ok) codeInput.value = ''
  await renderStatus()
})

retryButton.addEventListener('click', async () => {
  retryButton.disabled = true
  const response = await chrome.runtime
    .sendMessage({ type: 'retry-connection' })
    .catch(() => ({ ok: false, message: 'The retry request failed.' }))
  retryButton.disabled = false
  setStatus(response?.message ?? 'Retry requested.')
  await renderStatus()
})

disconnectButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'forget-pairing' }).catch(() => undefined)
  codeInput.value = ''
  setStatus('The local extension pairing was removed.')
  await renderStatus()
})

refreshSitesButton.addEventListener('click', () => void renderSites())
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'connection-status') void renderStatus()
})

void Promise.all([
  chrome.runtime.sendMessage({ type: 'ui-opened' }).catch(() => undefined),
  renderStatus(),
  renderSites()
])
