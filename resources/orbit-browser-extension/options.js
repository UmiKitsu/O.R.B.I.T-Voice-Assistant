/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const portInput = document.querySelector('#port')
const codeInput = document.querySelector('#code')
const pairButton = document.querySelector('#pair')
const disconnectButton = document.querySelector('#disconnect')
const grantSiteButton = document.querySelector('#grant-site')
const refreshSitesButton = document.querySelector('#refresh-sites')
const statusElement = document.querySelector('#status')
const sitesElement = document.querySelector('#sites')

function setStatus(message) {
  statusElement.textContent = message
}

async function renderStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null)
  if (!response) {
    setStatus('The extension service worker is unavailable.')
    return
  }
  portInput.value = response.port ? String(response.port) : portInput.value
  setStatus(
    response.connected
      ? `Connected to Orbit on 127.0.0.1:${response.port}.`
      : response.paired
        ? `Paired on port ${response.port}, but Orbit is not connected.`
        : 'Not paired with Orbit.'
  )
}

async function renderSites() {
  const permissions = await chrome.permissions.getAll()
  const origins = [...new Set(permissions.origins ?? [])]
    .filter((origin) => origin !== 'https://www.youtube.com/*')
    .sort()
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
  await chrome.runtime.sendMessage({ type: 'permissions-changed' }).catch(() => undefined)
}

pairButton.addEventListener('click', async () => {
  const port = Number(portInput.value)
  const code = codeInput.value.trim()
  if (!Number.isInteger(port) || port < 43117 || port > 43127 || !/^\d{6}$/.test(code)) {
    setStatus('Enter the Orbit port from 43117 to 43127 and exactly six digits.')
    return
  }
  pairButton.disabled = true
  setStatus('Pairing with Orbit…')
  const response = await chrome.runtime
    .sendMessage({ type: 'pair', port, code })
    .catch(() => ({ ok: false, message: 'The pairing request failed.' }))
  pairButton.disabled = false
  setStatus(response?.message ?? 'The pairing request failed.')
  if (response?.ok) codeInput.value = ''
  await renderStatus()
})

disconnectButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'forget-pairing' }).catch(() => undefined)
  codeInput.value = ''
  setStatus('The local extension pairing was removed.')
  await renderStatus()
})

grantSiteButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url) {
    setStatus('No active web page was found.')
    return
  }
  let origin
  try {
    const url = new URL(tab.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protected')
    origin = `${url.origin}/*`
  } catch {
    setStatus('Orbit cannot receive access to this protected browser page.')
    return
  }
  const granted = await chrome.permissions.request({ origins: [origin] })
  setStatus(granted ? `Granted access to ${origin}.` : 'Chrome did not grant site access.')
  await renderSites()
})

refreshSitesButton.addEventListener('click', () => void renderSites())
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'connection-status') void renderStatus()
})

void Promise.all([renderStatus(), renderSites()])
