/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const originElement = document.querySelector('#origin')
const permissionElement = document.querySelector('#permission')
const statusElement = document.querySelector('#status')
const grantButton = document.querySelector('#grant')
const revokeButton = document.querySelector('#revoke')
const retryButton = document.querySelector('#retry')
const optionsButton = document.querySelector('#options')

let activeOrigin = null
let activePattern = null
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

async function readActiveOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const url = new URL(tab?.url || '')
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protected')
    activeOrigin = url.origin
    activePattern = `${url.origin}/*`
    originElement.textContent = activeOrigin
    return
  } catch {
    activeOrigin = null
    activePattern = null
    originElement.textContent = 'This is a protected Chrome page.'
  }
}

async function renderPermission() {
  if (!activePattern) {
    permissionElement.textContent = 'Orbit cannot receive access to this page.'
    grantButton.disabled = true
    revokeButton.disabled = true
    return
  }
  const access = await chrome.runtime
    .sendMessage({ type: 'get-origin-access', origin: activeOrigin })
    .catch(() => ({ granted: false }))
  const granted = access?.granted === true
  permissionElement.textContent = granted
    ? `Orbit has guarded automation access to ${activeOrigin}.`
    : `Orbit does not have automation access to ${activeOrigin}.`
  grantButton.disabled = granted
  revokeButton.disabled = !granted
}

async function renderStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null)
  orbitPort = isOrbitPort(status?.activePort) ? status.activePort : null
  statusElement.textContent = safeStatusText(status)
}

grantButton.addEventListener('click', async () => {
  if (!activePattern) return
  const granted = await chrome.permissions.request({ origins: [activePattern] })
  if (granted) {
    await chrome.runtime
      .sendMessage({ type: 'site-granted', origin: activeOrigin })
      .catch(() => undefined)
  }
  statusElement.textContent = granted
    ? `Granted guarded access to ${activeOrigin}.`
    : 'Chrome did not grant this site.'
  await renderPermission()
})

revokeButton.addEventListener('click', async () => {
  if (!activePattern) return
  await chrome.permissions.remove({ origins: [activePattern] })
  const response = await chrome.runtime
    .sendMessage({ type: 'site-revoked', origin: activeOrigin })
    .catch(() => ({ ok: false }))
  statusElement.textContent = response?.ok
    ? `Revoked access to ${activeOrigin}.`
    : 'Chrome did not change this site permission.'
  await renderPermission()
})

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
  await readActiveOrigin()
  await Promise.all([renderPermission(), renderStatus()])
  await chrome.runtime.sendMessage({ type: 'ui-opened' }).catch(() => undefined)
})()
