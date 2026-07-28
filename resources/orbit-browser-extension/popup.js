/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const originElement = document.querySelector('#origin')
const permissionElement = document.querySelector('#permission')
const statusElement = document.querySelector('#status')
const retryButton = document.querySelector('#retry')
const optionsButton = document.querySelector('#options')

let orbitPort = null

const ACCESS_PROBE_PATH = '/orbit-browser-v1/access'
const ACCESS_PROBE_TIMEOUT_MS = 5000
const ACCESS_FAILURE_MESSAGE =
  "Orbit must be open and Chrome's Local Network Access permission must be allowed."

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

function safeStatusText(status) {
  if (!status) return 'The extension service worker is unavailable.'
  if (status.connected) return `Connected to Orbit on port ${status.activePort}.`
  const retryText = status.retryAt ? ` Retry after ${new Date(status.retryAt).toLocaleTimeString()}.` : ''
  const errorText = status.lastError?.message ? ` ${status.lastError.message}` : ''
  return `${status.phase || (status.paired ? 'reconnecting' : 'unpaired')}.${errorText}${retryText}`
}

async function renderActiveSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const url = new URL(tab?.url || '')
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protected')
    originElement.textContent = url.origin
  } catch {
    originElement.textContent = 'This is a protected Chrome or local page.'
  }
}

async function renderStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null)
  orbitPort = isOrbitPort(status?.activePort) ? status.activePort : null
  statusElement.textContent = safeStatusText(status)
  permissionElement.textContent = status?.siteAccessMode === 'all-websites'
    ? 'Website access: On all sites.'
    : 'Website access is restricted. Open chrome://extensions, select Orbit Browser Control, and set Site access to “On all sites.”'
}

retryButton.addEventListener('click', async () => {
  retryButton.disabled = true
  statusElement.textContent = 'Requesting Chrome Local Network Access…'
  const access = await probeLocalNetworkAccess(orbitPort)
  if (!access.ok) {
    statusElement.textContent = access.message
    retryButton.disabled = false
    return
  }
  const response = await chrome.runtime
    .sendMessage({ type: 'retry-connection' })
    .catch(() => ({ ok: false, message: 'The retry request failed.' }))
  statusElement.textContent = response?.message || 'Retry requested.'
  retryButton.disabled = false
  await renderStatus()
})

optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage())
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'connection-status') void renderStatus()
})

void (async () => {
  await Promise.all([renderActiveSite(), renderStatus()])
  await chrome.runtime.sendMessage({ type: 'ui-opened' }).catch(() => undefined)
})()
