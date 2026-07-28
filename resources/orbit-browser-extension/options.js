/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const pairingSetup = document.querySelector('#pairing-setup')
const pairedSummary = document.querySelector('#paired-summary')
const portInput = document.querySelector('#port')
const codeInput = document.querySelector('#code')
const pairButton = document.querySelector('#pair')
const retryButton = document.querySelector('#retry')
const disconnectButton = document.querySelector('#disconnect')
const refreshSitesButton = document.querySelector('#refresh-sites')
const statusElement = document.querySelector('#status')
const diagnosticsElement = document.querySelector('#diagnostics')
const sitesElement = document.querySelector('#sites')

const ACCESS_PROBE_PATH = '/orbit-browser-v1/access'
const ACCESS_PROBE_TIMEOUT_MS = 5000
const ACCESS_FAILURE_MESSAGE =
  "Orbit must be open and Chrome's Local Network Access permission must be allowed."

function setStatus(message) {
  statusElement.textContent = message
}

function isOrbitPort(port) {
  return Number.isInteger(port) && port >= 43117 && port <= 43127
}

async function probeLocalNetworkAccess(port) {
  if (!isOrbitPort(port)) return { ok: false, message: ACCESS_FAILURE_MESSAGE }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ACCESS_PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${ACCESS_PROBE_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal
    })
    return response.status === 204
      ? { ok: true }
      : { ok: false, message: ACCESS_FAILURE_MESSAGE }
  } catch {
    return { ok: false, message: ACCESS_FAILURE_MESSAGE }
  } finally {
    clearTimeout(timeout)
  }
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
  const paired = Boolean(response.paired)
  pairingSetup.hidden = paired
  pairedSummary.hidden = !paired
  portInput.value = response.activePort ? String(response.activePort) : portInput.value
  if (response.connected) {
    setStatus(
      `Connected to Orbit on 127.0.0.1:${response.activePort}. Paired—reconnects automatically after updates and restarts.`
    )
  } else if (response.lastError?.message) {
    setStatus(response.lastError.message)
  } else if (response.paired) {
    setStatus('Paired—reconnects automatically after updates and restarts.')
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
  if (!isOrbitPort(port) || !/^\d{6}$/.test(code)) {
    setStatus('Enter the Orbit port from 43117 to 43127 and exactly six digits.')
    return
  }
  pairButton.disabled = true
  setStatus('Requesting Chrome Local Network Access…')
  const access = await probeLocalNetworkAccess(port)
  if (!access.ok) {
    pairButton.disabled = false
    setStatus(access.message)
    return
  }
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
  const port = Number(portInput.value)
  setStatus('Requesting Chrome Local Network Access…')
  const access = await probeLocalNetworkAccess(port)
  if (!access.ok) {
    retryButton.disabled = false
    setStatus(access.message)
    return
  }
  const response = await chrome.runtime
    .sendMessage({ type: 'retry-connection' })
    .catch(() => ({ ok: false, message: 'The retry request failed.' }))
  retryButton.disabled = false
  setStatus(response?.message ?? 'Retry requested.')
  await renderStatus()
})

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true
  const response = await chrome.runtime
    .sendMessage({ type: 'forget-pairing' })
    .catch(() => ({
      ok: false,
      message: 'Chrome could not remove its saved Orbit pairing.'
    }))
  disconnectButton.disabled = false
  codeInput.value = ''
  setStatus(response?.message ?? 'The local extension pairing was removed.')
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
