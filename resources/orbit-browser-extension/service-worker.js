/* global chrome */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  migrateExactOriginPatterns,
  normalizeExactOrigin
} from './origin-grants.js'
import { navigateYouTubePlayer, setYouTubePlayback } from './youtube-controls.js'
import { evaluateYouTubePlaybackMeasurement } from './youtube-playback.js'
import { selectFirstRegularYouTubeVideo } from './youtube-selection.js'

const PROTOCOL_VERSION = 2
const SOCKET_PATH = '/orbit-browser-v1'
const REQUEST_TTL_MS = 60_000
const PORT_MIN = 43117
const PORT_MAX = 43127
const HEARTBEAT_INTERVAL_MS = 20000
const AUTHENTICATED_CONTACT_TIMEOUT_MS = 60000
const RETRY_ALARM = 'orbit-browser-reconnect'
const RETRY_DELAYS_MS = [30000, 60000, 120000, 300000]
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '')
const EXTENSION_VERSION = chrome.runtime.getManifest().version
const KNOWN_CAPABILITIES = new Set([
  'browser.openUrl',
  'browser.searchWeb',
  'browser.searchYouTube',
  'browser.newTab',
  'browser.closeTab',
  'browser.switchTab',
  'browser.goBack',
  'browser.goForward',
  'browser.reload',
  'browser.scroll',
  'youtube.playSearch',
  'youtube.play',
  'youtube.pause',
  'youtube.next',
  'youtube.previous',
  'youtube.playPause',
  'youtube.seekBy',
  'youtube.setVolume',
  'youtube.mute',
  'youtube.unmute',
  'youtube.fullscreen',
  'youtube.getPlaybackState',
  'browser.readVisiblePage',
  'browser.clickSafe',
  'browser.typeSafeText',
  'browser.selectOption',
  'browser.submitConsequential'
])

let socket = null
let socketAuthenticated = false
let heartbeatTimer = null
let pairingAttempt = null
let authClientNonce = null
let lastCommandSequence = 0
let pairResolver = null
let pairRejecter = null
let activeCommands = new Map()
let connectionPhase = 'unpaired'
let activePort = null
let retryAt = null
let retryAttempt = 0
let lastError = null
let lastAuthenticatedContactAt = 0
let connectionAttempt = null
let connectionGeneration = 0

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)])
  )
}

function stableJson(value) {
  return JSON.stringify(normalizeJson(value))
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function base64ToBytes(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function createMac(secretBase64, purpose, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secretBase64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${purpose}\n${stableJson(payload)}`)
  )
  return bytesToHex(signature)
}

async function verifyMac(secret, purpose, payload, received) {
  if (!/^[a-f0-9]{64}$/i.test(received ?? '')) return false
  const expected = await createMac(secret, purpose, payload)
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index)
  }
  return difference === 0
}

function success(message, data) {
  return data === undefined ? { ok: true, message } : { ok: true, message, data }
}

function failure(code, message, recoverable = true) {
  return { ok: false, code, message, recoverable }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key))
}

function parseSafeUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

async function getGrantedOriginAllowlist() {
  const stored = await chrome.storage.local.get([
    'orbitGrantedOrigins',
    'orbitOriginAllowlistMigrated'
  ])
  const existing = Array.isArray(stored.orbitGrantedOrigins)
    ? stored.orbitGrantedOrigins.flatMap((origin) => {
        const normalized = normalizeExactOrigin(origin)
        return normalized ? [normalized] : []
      })
    : []
  if (stored.orbitOriginAllowlistMigrated === true) return [...new Set(existing)].sort()

  const permissions = await chrome.permissions.getAll()
  const origins = migrateExactOriginPatterns(permissions.origins ?? [], existing)
  await chrome.storage.local.set({
    orbitGrantedOrigins: origins,
    orbitOriginAllowlistMigrated: true
  })
  return origins
}

async function setGrantedOrigin(origin, granted) {
  const normalized = normalizeExactOrigin(origin)
  if (!normalized) return false
  const existing = await getGrantedOriginAllowlist()
  const next = granted
    ? [...new Set([...existing, normalized])].sort()
    : existing.filter((candidate) => candidate !== normalized)
  await chrome.storage.local.set({
    orbitGrantedOrigins: next,
    orbitOriginAllowlistMigrated: true
  })
  return true
}

async function getEffectiveGrantedOrigins() {
  const allowed = await getGrantedOriginAllowlist()
  const checks = await Promise.all(
    allowed.map(async (origin) => ({
      origin,
      granted: await chrome.permissions.contains({ origins: [`${origin}/*`] })
    }))
  )
  const effective = checks.filter((entry) => entry.granted).map((entry) => entry.origin)
  if (effective.length !== allowed.length) {
    await chrome.storage.local.set({
      orbitGrantedOrigins: effective,
      orbitOriginAllowlistMigrated: true
    })
  }
  return effective
}

async function getPairing() {
  const stored = await chrome.storage.local.get([
    'orbitPort',
    'orbitSecret',
    'orbitExtensionOrigin',
    'orbitPairingConfirmed'
  ])
  const secret = typeof stored.orbitSecret === 'string' ? stored.orbitSecret : null
  return {
    port: Number.isInteger(stored.orbitPort) ? stored.orbitPort : null,
    secret,
    extensionOrigin:
      typeof stored.orbitExtensionOrigin === 'string' ? stored.orbitExtensionOrigin : null,
    confirmed: Boolean(secret) && stored.orbitPairingConfirmed !== false
  }
}

async function getControlledTabId() {
  const stored = await chrome.storage.session.get('controlledTabId')
  return Number.isInteger(stored.controlledTabId) ? stored.controlledTabId : null
}

async function setControlledTabId(tabId) {
  if (tabId === null) await chrome.storage.session.remove('controlledTabId')
  else await chrome.storage.session.set({ controlledTabId: tabId })
}

async function getControlledTab() {
  const tabId = await getControlledTabId()
  if (tabId === null) return null
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab || tab.id === undefined) throw new Error('missing')
    return tab
  } catch {
    await setControlledTabId(null)
    return null
  }
}

async function ensureControlledTab(url) {
  let tab = await getControlledTab()
  if (!tab) {
    tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: true })
    if (tab.id === undefined) throw new Error('Chrome did not create a tab.')
    await setControlledTabId(tab.id)
    return tab
  }
  if (url) tab = await chrome.tabs.update(tab.id, { url, active: true })
  else tab = await chrome.tabs.update(tab.id, { active: true })
  return tab
}

function protectedPageFailure() {
  return failure(
    'BROWSER_PROTECTED_CONTEXT',
    'Orbit cannot control Chrome pages, extension pages, files, developer tools, or other protected browser contexts.'
  )
}

async function requireControllableTab() {
  const tab = await getControlledTab()
  if (!tab?.id || !tab.url || !parseSafeUrl(tab.url)) return { error: protectedPageFailure() }
  return { tab }
}

async function requireActiveWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url || !parseSafeUrl(tab.url)) return { error: protectedPageFailure() }
  await setControlledTabId(tab.id)
  return { tab }
}

async function waitForTabComplete(tabId, timeoutMs = 12000) {
  const initial = await chrome.tabs.get(tabId).catch(() => null)
  if (initial?.status === 'complete') return initial
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('The page did not finish loading.'))
    }, timeoutMs)
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(tab)
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function hasPagePermission(url) {
  const parsed = parseSafeUrl(url)
  if (!parsed) return false
  const allowed = await getEffectiveGrantedOrigins()
  if (!allowed.includes(parsed.origin)) return false
  return chrome.permissions.contains({ origins: [`${parsed.origin}/*`] })
}

async function executeFixedScript(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return results?.[0]?.result
}

function collectYouTubeResultCandidates() {
  return new Promise((resolve) => {
    let latestCandidates = []
    const finish = (candidates) => {
      observer.disconnect()
      clearTimeout(timeout)
      resolve(candidates)
    }
    const inspect = () => {
      latestCandidates = [...document.querySelectorAll('a#video-title[href]')]
        .slice(0, 100)
        .flatMap((anchor) => {
          if (!(anchor instanceof HTMLAnchorElement)) return []
          return [
            {
              href: anchor.href,
              title: (anchor.getAttribute('title') || anchor.textContent || '').trim(),
              advertisement: Boolean(
                anchor.closest(
                  'ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-display-ad-renderer'
                )
              ),
              shorts: Boolean(
                anchor.closest(
                  'ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]'
                )
              ),
              channel: Boolean(anchor.closest('ytd-channel-renderer')),
              playlist: Boolean(
                anchor.closest('ytd-playlist-renderer, ytd-radio-renderer')
              ),
              shelf: Boolean(anchor.closest('ytd-shelf-renderer'))
            }
          ]
        })
      const hasPotentialRegularVideo = latestCandidates.some(
        (candidate) =>
          !candidate.advertisement &&
          !candidate.shorts &&
          !candidate.channel &&
          !candidate.playlist &&
          !candidate.shelf
      )
      if (hasPotentialRegularVideo) finish(latestCandidates)
      return hasPotentialRegularVideo
    }
    const observer = new MutationObserver(() => inspect())
    const timeout = setTimeout(() => finish(latestCandidates), 10000)
    if (!inspect()) observer.observe(document.documentElement, { childList: true, subtree: true })
  })
}

function readYouTubePlaybackState(expectedVideoId) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  const url = new URL(location.href)
  const videoId = url.searchParams.get('v') ?? undefined
  if (expectedVideoId && videoId !== expectedVideoId) {
    return { ok: false, code: 'YOUTUBE_TARGET_CHANGED', message: 'The controlled YouTube video changed before verification.', recoverable: true }
  }
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  const title = rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined
  return {
    ok: true,
    message: 'Read YouTube playback state.',
    data: {
      videoId,
      title,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

async function measureYouTubePlayback(expectedVideoId) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { mediaFound: false, expectedVideoId }
  }
  const currentVideoId = new URL(location.href).searchParams.get('v')
  const initialTime = Math.max(0, video.currentTime || 0)
  let playRejected = false
  if (currentVideoId === expectedVideoId) {
    try {
      await video.play()
    } catch {
      playRejected = true
    }
    if (!playRejected) await new Promise((resolve) => setTimeout(resolve, 1600))
  }
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    mediaFound: true,
    expectedVideoId,
    currentVideoId,
    playRejected,
    initialTime,
    currentTime: Math.max(0, video.currentTime || 0),
    paused: video.paused,
    ended: video.ended,
    muted: video.muted,
    volume: Math.round(video.volume * 100),
    ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
    title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
    url: location.href
  }
}

async function toggleYouTubePlayback() {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  if (video.paused || video.ended) {
    try {
      await video.play()
    } catch {
      return { ok: false, code: 'YOUTUBE_AUTOPLAY_BLOCKED', message: 'Chrome blocked playback.', recoverable: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  } else {
    video.pause()
  }
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: 'Updated YouTube playback.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

function seekYouTubePlayback(seconds) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY
  video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds))
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: 'Updated YouTube playback position.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

function setYouTubeVolume(volume) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  video.volume = volume / 100
  if (volume > 0) video.muted = false
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: 'Updated YouTube volume.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

function setYouTubeMuted(muted) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  video.muted = muted
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: 'Updated YouTube mute state.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

async function fullscreenYouTubePlayback() {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return { ok: false, code: 'YOUTUBE_PLAYER_NOT_FOUND', message: 'The YouTube media player was not found.', recoverable: true }
  }
  const target = document.querySelector('.html5-video-player') || video
  try {
    await target.requestFullscreen()
  } catch {
    return { ok: false, code: 'YOUTUBE_FULLSCREEN_BLOCKED', message: 'Chrome requires a direct user gesture for fullscreen.', recoverable: true }
  }
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: 'Updated YouTube fullscreen state.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0 ? { duration: video.duration } : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

function scrollPage(direction, amount) {
  const movement = direction === 'up' || direction === 'left' ? -amount : amount
  window.scrollBy({
    left: direction === 'left' || direction === 'right' ? movement : 0,
    top: direction === 'up' || direction === 'down' ? movement : 0,
    behavior: 'smooth'
  })
  return { ok: true, message: 'Scrolled the page.' }
}

function readVisiblePageSnapshot() {
  const stateKey = '__orbitVisiblePageStateV1'
  let state = globalThis[stateKey]
  if (!state || state.url !== location.href) {
    state?.observer?.disconnect?.()
    state = { url: location.href, version: 1, refs: new Map(), observer: null }
    state.observer = new MutationObserver(() => {
      state.version += 1
      state.refs.clear()
    })
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'aria-hidden', 'style', 'class']
    })
    globalThis[stateKey] = state
  }
  state.refs.clear()

  const visible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || 1) > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= innerHeight &&
      rect.left <= innerWidth
    )
  }
  const protectedField = (element) => {
    if (!(element instanceof HTMLElement)) return true
    const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : ''
    const signature = [
      inputType,
      element.getAttribute('name'),
      element.id,
      element.getAttribute('autocomplete'),
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label')
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return (
      inputType === 'password' ||
      inputType === 'file' ||
      /(password|passcode|credential|credit.?card|card.?number|cvv|cvc|security.?code|expiry|expiration|payment|billing)/i.test(signature)
    )
  }
  const roleFor = (element) => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    if (element instanceof HTMLAnchorElement) return 'link'
    if (element instanceof HTMLButtonElement) return 'button'
    if (element instanceof HTMLSelectElement) return 'combobox'
    if (element instanceof HTMLTextAreaElement) return 'textbox'
    if (element instanceof HTMLInputElement) {
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button'
      if (element.type === 'checkbox') return 'checkbox'
      if (element.type === 'radio') return 'radio'
      return 'textbox'
    }
    return element.tagName.toLowerCase()
  }
  const nameFor = (element) =>
    (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      element.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)

  const elements = []
  const candidates = document.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), textarea, select, [role], [contenteditable="true"]'
  )
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || elements.length >= 100) break
    if (!visible(element) || protectedField(element)) continue
    const name = nameFor(element)
    if (!name && !['textbox', 'checkbox', 'radio', 'combobox'].includes(roleFor(element))) continue
    const random = crypto.getRandomValues(new Uint32Array(2)).join('')
    const ref = `e${state.version}_${elements.length}_${random}`
    state.refs.set(ref, element)
    elements.push({
      ref,
      role: roleFor(element),
      name,
      ...((element.innerText || '').trim() ? { text: element.innerText.replace(/\s+/g, ' ').trim().slice(0, 1000) } : {}),
      ...(element.matches(':disabled,[aria-disabled="true"]') ? { disabled: true } : {})
    })
  }

  const visibleTextParts = []
  const seenText = new Set()
  const textRoot = document.body || document.documentElement
  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT)
  let visitedTextNodes = 0
  while (visibleTextParts.join(' ').length < 12000 && visitedTextNodes < 2500) {
    const textNode = walker.nextNode()
    if (!textNode) break
    visitedTextNodes += 1
    const parent = textNode.parentElement
    if (
      !parent ||
      parent.closest('script, style, noscript, template, [aria-hidden="true"]') ||
      protectedField(parent)
    ) {
      continue
    }
    const text = (textNode.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text || seenText.has(text)) continue
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) <= 0) {
      continue
    }
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const rect = range.getBoundingClientRect()
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > innerHeight ||
      rect.left > innerWidth
    ) {
      continue
    }
    seenText.add(text)
    visibleTextParts.push(text)
  }
  const visibleText = visibleTextParts.join(' ').slice(0, 12000)
  return {
    ok: true,
    message: 'Read the visible page.',
    data: {
      origin: location.origin,
      url: location.href,
      title: document.title.slice(0, 500),
      visibleText,
      domVersion: state.version,
      elements
    }
  }
}

function interactWithVisibleElement(elementRef, action, value) {
  const state = globalThis.__orbitVisiblePageStateV1
  if (!state || state.url !== location.href || !state.refs.has(elementRef)) {
    return { ok: false, code: 'BROWSER_STALE_ELEMENT_REFERENCE', message: 'That page element reference expired. Read the page again.', recoverable: true }
  }
  const element = state.refs.get(elementRef)
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return { ok: false, code: 'BROWSER_STALE_ELEMENT_REFERENCE', message: 'That page element is no longer available.', recoverable: true }
  }
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, code: 'BROWSER_ELEMENT_NOT_VISIBLE', message: 'That page element is not visible.', recoverable: true }
  }
  const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : ''
  const signature = [
    inputType,
    element.getAttribute('name'),
    element.id,
    element.getAttribute('autocomplete'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label')
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (
    inputType === 'password' ||
    inputType === 'file' ||
    /(password|passcode|credential|credit.?card|card.?number|cvv|cvc|security.?code|expiry|expiration|payment|billing)/i.test(signature)
  ) {
    return { ok: false, code: 'BROWSER_PROTECTED_FIELD', message: 'Orbit cannot use password, credential, payment, or file-upload fields.', recoverable: false }
  }

  if (action === 'type') {
    if (typeof value !== 'string' || value.length > 4000) {
      return { ok: false, code: 'BROWSER_INVALID_TEXT', message: 'The text is invalid or too long.', recoverable: true }
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      setter?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, message: 'Entered text.' }
    }
    if (element.isContentEditable) {
      element.textContent = value
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      return { ok: true, message: 'Entered text.' }
    }
    return { ok: false, code: 'BROWSER_NOT_TEXT_FIELD', message: 'That element is not a safe text field.', recoverable: true }
  }

  if (action === 'select') {
    if (!(element instanceof HTMLSelectElement) || typeof value !== 'string') {
      return { ok: false, code: 'BROWSER_NOT_SELECT', message: 'That element is not a select control.', recoverable: true }
    }
    const option = [...element.options].find((item) => item.value === value || item.text.trim() === value)
    if (!option) return { ok: false, code: 'BROWSER_OPTION_NOT_FOUND', message: 'The requested option was not found.', recoverable: true }
    element.value = option.value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, message: 'Selected the option.' }
  }

  const text = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`.trim()
  const href = element instanceof HTMLAnchorElement ? element.href : ''
  const pageContext = `${location.pathname} ${document.title}`
  const accountSettingChange =
    /(account|settings|profile|security|privacy)/i.test(pageContext) &&
    /(save|update|apply|confirm|change)/i.test(text)
  const permissionAction =
    /(allow|enable|grant)/i.test(text) &&
    /(notification|camera|microphone|location|permission)/i.test(`${text} ${pageContext}`)
  const consequential =
    /(send|post|publish|submit|purchase|buy now|place order|checkout|confirm order|join call|leave call|delete account|change password|save account)/i.test(
      text
    ) || accountSettingChange
  const forbidden =
    element.hasAttribute('download') ||
    /(^|\b)(upload|download|choose file|attach file)(\b|$)/i.test(text) ||
    permissionAction ||
    href.startsWith('blob:') ||
    href.startsWith('data:')
  if (forbidden) {
    return { ok: false, code: 'BROWSER_FORBIDDEN_ACTION', message: 'Uploads, downloads, and file actions are blocked.', recoverable: false }
  }
  if (action === 'click-safe' && consequential) {
    return { ok: false, code: 'BROWSER_CONFIRMATION_REQUIRED', message: 'That page action is consequential and requires exact confirmation.', recoverable: true }
  }
  if (action !== 'click-safe' && action !== 'submit-consequential') {
    return { ok: false, code: 'BROWSER_INVALID_ACTION', message: 'The browser action is invalid.', recoverable: true }
  }
  element.click()
  return { ok: true, message: consequential ? 'Submitted the confirmed action.' : 'Clicked the page control.' }
}

async function withYouTubeTab(command) {
  const required = await requireControllableTab()
  if (required.error) return required.error
  const { tab } = required
  if (!tab.url.startsWith('https://www.youtube.com/')) {
    return failure('YOUTUBE_NOT_CONTROLLED', 'The controlled tab is not a supported YouTube page.')
  }
  try {
    const result = await command(tab)
    if (result?.ok && result.data) result.data.controlledTabId = tab.id
    return result
  } catch {
    const tabStillExists = await chrome.tabs.get(tab.id).then(
      () => true,
      () => false
    )
    return tabStillExists
      ? failure('YOUTUBE_CONTROL_FAILED', 'The YouTube player control failed.')
      : failure('YOUTUBE_TAB_CLOSED', 'The controlled YouTube tab was closed.')
  }
}

async function executeCapability(capability, parameters, signal) {
  if (!KNOWN_CAPABILITIES.has(capability) || !isPlainObject(parameters)) {
    return failure('BROWSER_INVALID_COMMAND', 'The browser command is not registered.')
  }
  if (signal.aborted) return failure('ACTION_CANCELLED', 'The request was cancelled.')

  if (capability === 'browser.openUrl') {
    if (!hasOnlyKeys(parameters, ['url'])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid URL parameters.')
    const url = parseSafeUrl(parameters.url)
    if (!url) return failure('INVALID_EXTERNAL_URL', 'That URL is not allowed.')
    const tab = await ensureControlledTab(url.toString())
    return success('Opened the page.', { controlledTabId: tab.id })
  }
  if (capability === 'browser.searchWeb' || capability === 'browser.searchYouTube') {
    if (!hasOnlyKeys(parameters, ['query']) || typeof parameters.query !== 'string' || !parameters.query.trim() || parameters.query.length > 500) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The search query is invalid.')
    }
    const url =
      capability === 'browser.searchWeb'
        ? `https://www.google.com/search?q=${encodeURIComponent(parameters.query.trim())}`
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(parameters.query.trim())}`
    const tab = await ensureControlledTab(url)
    return success('Opened search results.', { controlledTabId: tab.id })
  }
  if (capability === 'browser.newTab') {
    if (!hasOnlyKeys(parameters, ['url'])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid new-tab parameters.')
    const url = parameters.url === undefined ? undefined : parseSafeUrl(parameters.url)?.toString()
    if (parameters.url !== undefined && !url) return failure('INVALID_EXTERNAL_URL', 'That URL is not allowed.')
    const tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: true })
    if (tab.id === undefined) return failure('BROWSER_TAB_FAILED', 'Chrome did not create the tab.')
    await setControlledTabId(tab.id)
    return success('Opened a new controlled tab.')
  }
  if (capability === 'browser.closeTab') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid close-tab parameters.')
    const tab = await getControlledTab()
    if (!tab?.id) return failure('BROWSER_CONTROLLED_TAB_MISSING', 'No Orbit-controlled tab is available.')
    await chrome.tabs.remove(tab.id)
    await setControlledTabId(null)
    return success('Closed the controlled tab.')
  }
  if (capability === 'browser.switchTab') {
    if (!hasOnlyKeys(parameters, ['query']) || typeof parameters.query !== 'string' || !parameters.query.trim() || parameters.query.length > 200) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The tab query is invalid.')
    }
    const query = parameters.query.trim().toLowerCase()
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const match = tabs.find((tab) => {
      if (!tab.id || !tab.url || !parseSafeUrl(tab.url)) return false
      return `${tab.title || ''} ${tab.url}`.toLowerCase().includes(query)
    })
    if (!match?.id) return failure('BROWSER_TAB_NOT_FOUND', 'No matching safe browser tab was found.')
    await chrome.tabs.update(match.id, { active: true })
    await setControlledTabId(match.id)
    return success('Switched the controlled tab.')
  }
  if (['browser.goBack', 'browser.goForward', 'browser.reload'].includes(capability)) {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid navigation parameters.')
    const required = await requireControllableTab()
    if (required.error) return required.error
    if (capability === 'browser.goBack') await chrome.tabs.goBack(required.tab.id)
    else if (capability === 'browser.goForward') await chrome.tabs.goForward(required.tab.id)
    else await chrome.tabs.reload(required.tab.id)
    return success('Navigated the controlled tab.')
  }
  if (capability === 'browser.scroll') {
    if (
      !hasOnlyKeys(parameters, ['direction', 'amount']) ||
      !['up', 'down', 'left', 'right'].includes(parameters.direction) ||
      !Number.isInteger(parameters.amount) ||
      parameters.amount < 100 ||
      parameters.amount > 5000
    ) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The scroll parameters are invalid.')
    }
    const required = await requireActiveWebTab()
    if (required.error) return required.error
    if (!(await hasPagePermission(required.tab.url))) return failure('BROWSER_SITE_ACCESS_REQUIRED', 'Grant this exact site from the Orbit extension toolbar before page actions.')
    return executeFixedScript(required.tab.id, scrollPage, [parameters.direction, parameters.amount])
  }

  if (capability === 'youtube.playSearch') {
    if (!hasOnlyKeys(parameters, ['query']) || typeof parameters.query !== 'string' || !parameters.query.trim() || parameters.query.length > 200) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The YouTube query is invalid.')
    }
    const tab = await ensureControlledTab(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(parameters.query.trim())}`
    )
    if (!tab.id) return failure('BROWSER_TAB_FAILED', 'Chrome did not create the YouTube tab.')
    await waitForTabComplete(tab.id)
    if (signal.aborted) return failure('ACTION_CANCELLED', 'The request was cancelled.')
    const candidates = await executeFixedScript(tab.id, collectYouTubeResultCandidates)
    const selected = selectFirstRegularYouTubeVideo(candidates)
    if (!selected) {
      return failure(
        'YOUTUBE_UNSUPPORTED_PAGE',
        'YouTube results did not expose a supported regular video.'
      )
    }
    const { videoId, title, url } = selected
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || parseSafeUrl(url)?.hostname !== 'www.youtube.com') {
      return failure('YOUTUBE_INVALID_RESULT', 'YouTube returned an invalid video result.')
    }
    await chrome.tabs.update(tab.id, { url })
    await waitForTabComplete(tab.id)
    if (signal.aborted) return failure('ACTION_CANCELLED', 'The request was cancelled.')
    let measurement
    try {
      measurement = await executeFixedScript(tab.id, measureYouTubePlayback, [videoId])
    } catch {
      const tabStillExists = await chrome.tabs.get(tab.id).then(
        () => true,
        () => false
      )
      measurement = tabStillExists ? null : { tabClosed: true }
    }
    const playback = evaluateYouTubePlaybackMeasurement(measurement)
    if (playback.ok && playback.data) {
      playback.data.controlledTabId = tab.id
      playback.data.videoId = videoId
      playback.data.title = playback.data.title || title
    }
    return playback ?? failure('YOUTUBE_PLAYBACK_NOT_VERIFIED', 'The YouTube video could not be verified.')
  }

  if (capability === 'youtube.play' || capability === 'youtube.pause') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) =>
      executeFixedScript(tab.id, setYouTubePlayback, [capability === 'youtube.play'])
    )
  }
  if (capability === 'youtube.next' || capability === 'youtube.previous') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) =>
      executeFixedScript(tab.id, navigateYouTubePlayer, [capability === 'youtube.next' ? 'next' : 'previous'])
    )
  }
  if (capability === 'youtube.playPause') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) => executeFixedScript(tab.id, toggleYouTubePlayback))
  }
  if (capability === 'youtube.seekBy') {
    if (!hasOnlyKeys(parameters, ['seconds']) || !Number.isInteger(parameters.seconds) || parameters.seconds < -300 || parameters.seconds > 300 || parameters.seconds === 0) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The YouTube seek amount is invalid.')
    }
    return withYouTubeTab((tab) => executeFixedScript(tab.id, seekYouTubePlayback, [parameters.seconds]))
  }
  if (capability === 'youtube.setVolume') {
    if (!hasOnlyKeys(parameters, ['volume']) || !Number.isInteger(parameters.volume) || parameters.volume < 0 || parameters.volume > 100) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The YouTube volume is invalid.')
    }
    return withYouTubeTab((tab) => executeFixedScript(tab.id, setYouTubeVolume, [parameters.volume]))
  }
  if (capability === 'youtube.mute' || capability === 'youtube.unmute') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) => executeFixedScript(tab.id, setYouTubeMuted, [capability === 'youtube.mute']))
  }
  if (capability === 'youtube.fullscreen') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) => executeFixedScript(tab.id, fullscreenYouTubePlayback))
  }
  if (capability === 'youtube.getPlaybackState') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid YouTube parameters.')
    return withYouTubeTab((tab) => executeFixedScript(tab.id, readYouTubePlaybackState))
  }

  const stageTwo = await requireActiveWebTab()
  if (stageTwo.error) return stageTwo.error
  if (!(await hasPagePermission(stageTwo.tab.url))) {
    return failure('BROWSER_SITE_ACCESS_REQUIRED', 'Grant this exact site from the Orbit extension toolbar before page actions.')
  }
  if (capability === 'browser.readVisiblePage') {
    if (!hasOnlyKeys(parameters, [])) return failure('BROWSER_INVALID_PARAMETERS', 'Invalid page-read parameters.')
    return executeFixedScript(stageTwo.tab.id, readVisiblePageSnapshot)
  }
  if (capability === 'browser.clickSafe' || capability === 'browser.submitConsequential') {
    const allowedKeys =
      capability === 'browser.clickSafe'
        ? ['elementRef']
        : ['elementRef', 'confirmationText']
    if (
      !hasOnlyKeys(parameters, allowedKeys) ||
      typeof parameters.elementRef !== 'string' ||
      !/^[A-Za-z0-9_-]{8,160}$/.test(parameters.elementRef) ||
      (capability === 'browser.submitConsequential' &&
        (typeof parameters.confirmationText !== 'string' ||
          !parameters.confirmationText.trim() ||
          parameters.confirmationText.length > 600))
    ) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The element reference or confirmation is invalid.')
    }
    return executeFixedScript(stageTwo.tab.id, interactWithVisibleElement, [
      parameters.elementRef,
      capability === 'browser.clickSafe' ? 'click-safe' : 'submit-consequential',
      null
    ])
  }
  if (capability === 'browser.typeSafeText') {
    if (!hasOnlyKeys(parameters, ['elementRef', 'text']) || typeof parameters.elementRef !== 'string' || typeof parameters.text !== 'string' || parameters.text.length > 4000) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The safe text parameters are invalid.')
    }
    return executeFixedScript(stageTwo.tab.id, interactWithVisibleElement, [parameters.elementRef, 'type', parameters.text])
  }
  if (capability === 'browser.selectOption') {
    if (!hasOnlyKeys(parameters, ['elementRef', 'value']) || typeof parameters.elementRef !== 'string' || typeof parameters.value !== 'string' || !parameters.value.trim() || parameters.value.length > 500) {
      return failure('BROWSER_INVALID_PARAMETERS', 'The select parameters are invalid.')
    }
    return executeFixedScript(stageTwo.tab.id, interactWithVisibleElement, [parameters.elementRef, 'select', parameters.value])
  }
  return failure('BROWSER_INVALID_COMMAND', 'The browser command is not registered.')
}

async function sendCommandResult(command, result) {
  const pairing = await getPairing()
  if (!socket || socket.readyState !== WebSocket.OPEN || !pairing.secret) return
  const payload = {
    version: PROTOCOL_VERSION,
    requestId: command.requestId,
    sequence: command.sequence,
    result
  }
  socket.send(
    JSON.stringify({
      type: 'command_result',
      ...payload,
      mac: await createMac(pairing.secret, 'command-result', payload)
    })
  )
}

async function handleCommand(message) {
  const pairing = await getPairing()
  if (!pairing.secret || !socketAuthenticated) return
  if (
    message.version !== PROTOCOL_VERSION ||
    message.type !== 'command' ||
    typeof message.requestId !== 'string' ||
    !Number.isInteger(message.sequence) ||
    message.sequence <= 0 ||
    !KNOWN_CAPABILITIES.has(message.capability) ||
    !isPlainObject(message.parameters) ||
    !Number.isInteger(message.deadline) ||
    message.deadline < Date.now() ||
    message.deadline > Date.now() + REQUEST_TTL_MS
  ) {
    return
  }
  const { mac, ...payload } = message
  if (
    message.sequence <= lastCommandSequence ||
    !(await verifyMac(pairing.secret, 'command', payload, mac))
  ) {
    socket.close(1008, 'Replay or command authentication failed')
    return
  }
  lastCommandSequence = message.sequence
  const controller = new AbortController()
  activeCommands.set(message.requestId, controller)
  let result
  try {
    result = await executeCapability(message.capability, message.parameters, controller.signal)
  } catch {
    result = failure('BROWSER_COMMAND_FAILED', 'The browser action failed.', true)
  } finally {
    activeCommands.delete(message.requestId)
  }
  await sendCommandResult(message, result)
  await sendExtensionStatus()
}

async function sendExtensionStatus() {
  if (!socketAuthenticated || !socket || socket.readyState !== WebSocket.OPEN) return
  const grantedOrigins = await getEffectiveGrantedOrigins()
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let activeTabOrigin
  try {
    activeTabOrigin = activeTab?.url && parseSafeUrl(activeTab.url)
      ? new URL(activeTab.url).origin
      : undefined
  } catch {
    activeTabOrigin = undefined
  }
  socket.send(
    JSON.stringify({
      type: 'extension_status',
      version: PROTOCOL_VERSION,
      grantedOrigins: grantedOrigins.map((origin) => `${origin}/*`),
      ...(activeTabOrigin ? { activeTabOrigin } : {})
    })
  )
}

function clearSocketTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

async function persistLifecycle() {
  await chrome.storage.session.set({
    orbitConnectionLifecycle: {
      phase: connectionPhase,
      activePort,
      retryAt,
      lastError,
      retryAttempt
    }
  })
}

function notifyConnectionStatus() {
  void persistLifecycle().catch(() => undefined)
  chrome.runtime.sendMessage({ type: 'connection-status' }).catch(() => undefined)
}

function setLifecycle(phase, options = {}) {
  connectionPhase = phase
  if ('activePort' in options) activePort = options.activePort
  if ('retryAt' in options) retryAt = options.retryAt
  if ('lastError' in options) lastError = options.lastError
  notifyConnectionStatus()
}

async function getSafeConnectionStatus() {
  const [pairing, grantedOrigins] = await Promise.all([
    getPairing(),
    getEffectiveGrantedOrigins()
  ])
  return {
    paired: Boolean(pairing.confirmed && pairing.port),
    connected: socketAuthenticated,
    phase: connectionPhase,
    activePort: activePort ?? pairing.port,
    retryAt,
    lastError,
    grantedOrigins
  }
}

function startHeartbeat() {
  clearSocketTimers()
  heartbeatTimer = setInterval(() => {
    if (!socketAuthenticated || !socket || socket.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (
      !lastAuthenticatedContactAt ||
      now - lastAuthenticatedContactAt > AUTHENTICATED_CONTACT_TIMEOUT_MS
    ) {
      lastError = {
        code: 'BROWSER_HEARTBEAT_TIMEOUT',
        message: 'Orbit stopped responding. The extension will reconnect automatically.'
      }
      socket.close(4004, 'Authenticated heartbeat timeout')
      return
    }
    socket.send(JSON.stringify({ type: 'heartbeat', version: PROTOCOL_VERSION, timestamp: now }))
    void sendExtensionStatus()
  }, HEARTBEAT_INTERVAL_MS)
}

function orderedPorts(savedPort) {
  const allPorts = Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, index) => PORT_MIN + index)
  return Number.isInteger(savedPort) && savedPort >= PORT_MIN && savedPort <= PORT_MAX
    ? [savedPort, ...allPorts.filter((port) => port !== savedPort)]
    : allPorts
}

async function clearRetrySchedule() {
  await chrome.alarms.clear(RETRY_ALARM).catch(() => false)
  retryAt = null
}

async function scheduleReconnect(error) {
  const pairing = await getPairing()
  if (!pairing.secret) {
    retryAt = null
    retryAttempt = 0
    setLifecycle('unpaired', { activePort: null, lastError: null, retryAt: null })
    return
  }
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)]
  retryAttempt = Math.min(retryAttempt + 1, RETRY_DELAYS_MS.length - 1)
  retryAt = Date.now() + delay
  lastError = error ?? {
    code: 'BROWSER_BRIDGE_UNAVAILABLE',
    message: 'Orbit is not available on the local browser-control ports.'
  }
  connectionPhase = 'reconnecting'
  await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: delay / 60000 })
  notifyConnectionStatus()
}

function connectPort(port, pairOverride, generation) {
  return new Promise((resolve) => {
    let settled = false
    let authenticated = false
    let outcome = 'failed'
    const finish = (nextOutcome) => {
      if (settled) return
      settled = true
      outcome = nextOutcome
      clearTimeout(timeout)
      resolve(nextOutcome)
    }
    const timeout = setTimeout(() => {
      if (socket === currentSocket) currentSocket.close(4005, 'Connection attempt timed out')
      finish('failed')
    }, pairOverride ? 8000 : 1500)

    const currentSocket = new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`)
    socket = currentSocket
    socketAuthenticated = false
    clearSocketTimers()
    authClientNonce = null
    activePort = port
    pairingAttempt = pairOverride ?? null
    setLifecycle(pairOverride ? 'pairing' : 'connecting', {
      activePort: port,
      retryAt: null,
      lastError: null
    })

    currentSocket.addEventListener('open', async () => {
      if (generation !== connectionGeneration || socket !== currentSocket) {
        currentSocket.close(4001, 'A newer connection attempt replaced this connection')
        return
      }
      if (pairOverride) {
        currentSocket.send(
          JSON.stringify({
            type: 'pair',
            version: PROTOCOL_VERSION,
            code: pairOverride.code,
            extensionOrigin: EXTENSION_ORIGIN,
            extensionVersion: EXTENSION_VERSION
          })
        )
        return
      }
      const pairing = await getPairing()
      if (!pairing.secret || pairing.extensionOrigin !== EXTENSION_ORIGIN) {
        finish('fatal')
        currentSocket.close(1008, 'Pairing is unavailable')
        return
      }
      authClientNonce = randomNonce()
      const hello = {
        type: 'auth_hello',
        version: PROTOCOL_VERSION,
        extensionOrigin: EXTENSION_ORIGIN,
        extensionVersion: EXTENSION_VERSION,
        nonce: authClientNonce,
        timestamp: Date.now()
      }
      currentSocket.send(
        JSON.stringify({
          ...hello,
          mac: await createMac(pairing.secret, 'auth-client', hello)
        })
      )
      setLifecycle('authenticating', { activePort: port, retryAt: null, lastError: null })
    })

    currentSocket.addEventListener('message', (event) => {
      void (async () => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          currentSocket.close(1003, 'Invalid Orbit message')
          return
        }
        if (generation !== connectionGeneration || socket !== currentSocket) return

        if (message?.type === 'protocol_error') {
          const incompatible = message.code === 'BROWSER_PROTOCOL_INCOMPATIBLE'
          const safeMessage = incompatible
            ? 'Reload the Orbit Browser Control extension to use the current browser protocol.'
            : typeof message.message === 'string' && message.message.length <= 500
              ? message.message
              : 'Orbit rejected the browser connection.'
          lastError = {
            code: incompatible ? 'BROWSER_PROTOCOL_INCOMPATIBLE' : 'BROWSER_PROTOCOL_ERROR',
            message: safeMessage
          }
          setLifecycle('error', { activePort: port, retryAt: null, lastError })
          finish(incompatible ? 'fatal' : 'failed')
          currentSocket.close(1002, 'Protocol error')
          return
        }

        if (message?.type === 'pair_success' && pairingAttempt) {
          if (
            message.version !== PROTOCOL_VERSION ||
            message.extensionOrigin !== EXTENSION_ORIGIN ||
            !Number.isInteger(message.port) ||
            message.port < PORT_MIN ||
            message.port > PORT_MAX ||
            typeof message.secret !== 'string' ||
            !/^[A-Za-z0-9+/]{43}=$/.test(message.secret)
          ) {
            lastError = {
              code: 'PAIRING_RESPONSE_INVALID',
              message: 'Orbit returned an invalid pairing response.'
            }
            setLifecycle('error', { activePort: port, retryAt: null, lastError })
            finish('fatal')
            currentSocket.close(1008, 'Invalid pairing response')
            return
          }
          try {
            await chrome.storage.local.set({
              orbitPort: message.port,
              orbitSecret: message.secret,
              orbitExtensionOrigin: EXTENSION_ORIGIN,
              orbitPairingConfirmed: false
            })
            pairingAttempt = null
            lastCommandSequence = 0
            setLifecycle('authenticating', {
              activePort: message.port,
              retryAt: null,
              lastError: null
            })
            finish('paired')
            currentSocket.close(4000, 'Reconnect with authentication')
          } catch {
            lastError = {
              code: 'PAIRING_STORAGE_FAILED',
              message: 'Chrome could not store the pairing secret securely.'
            }
            setLifecycle('error', { activePort: port, retryAt: null, lastError })
            finish('fatal')
            currentSocket.close(1011, 'Pairing storage failed')
          }
          return
        }

        const pairing = await getPairing()
        if (message?.type === 'auth_challenge' && pairing.secret && authClientNonce) {
          const payload = {
            version: message.version,
            clientNonce: message.clientNonce,
            serverNonce: message.serverNonce,
            timestamp: message.timestamp
          }
          if (
            message.version !== PROTOCOL_VERSION ||
            message.clientNonce !== authClientNonce ||
            typeof message.serverNonce !== 'string' ||
            Math.abs(Date.now() - message.timestamp) > 30000 ||
            !(await verifyMac(pairing.secret, 'auth-server', payload, message.mac))
          ) {
            lastError = {
              code: 'AUTHENTICATION_FAILED',
              message: 'Orbit browser authentication failed. Pair the extension again.'
            }
            setLifecycle('error', { activePort: port, retryAt: null, lastError })
            finish('fatal')
            currentSocket.close(1008, 'Server authentication failed')
            return
          }
          lastAuthenticatedContactAt = Date.now()
          const ack = {
            type: 'auth_ack',
            version: PROTOCOL_VERSION,
            clientNonce: authClientNonce,
            serverNonce: message.serverNonce
          }
          currentSocket.send(
            JSON.stringify({
              ...ack,
              mac: await createMac(pairing.secret, 'auth-ack', ack)
            })
          )
          return
        }

        if (message?.type === 'authenticated' && message.version === PROTOCOL_VERSION) {
          authenticated = true
          socketAuthenticated = true
          lastCommandSequence = 0
          lastAuthenticatedContactAt = Date.now()
          retryAttempt = 0
          await clearRetrySchedule()
          await chrome.storage.local.set({ orbitPort: port, orbitPairingConfirmed: true })
          setLifecycle('connected', { activePort: port, retryAt: null, lastError: null })
          startHeartbeat()
          await sendExtensionStatus()
          finish('connected')
          const resolvePairing = pairResolver
          pairResolver = null
          pairRejecter = null
          resolvePairing?.()
          return
        }

        if (!socketAuthenticated) return
        lastAuthenticatedContactAt = Date.now()
        if (message?.type === 'command') {
          await handleCommand(message)
          return
        }
        if (
          message?.type === 'cancel' &&
          message.version === PROTOCOL_VERSION &&
          typeof message.requestId === 'string'
        ) {
          activeCommands.get(message.requestId)?.abort()
          return
        }
        if (message?.type === 'heartbeat' && message.version === PROTOCOL_VERSION) {
          if (currentSocket.readyState === WebSocket.OPEN) {
            currentSocket.send(
              JSON.stringify({ type: 'heartbeat', version: PROTOCOL_VERSION, timestamp: Date.now() })
            )
          }
        }
      })().catch(() => {
        if (currentSocket.readyState === WebSocket.OPEN) currentSocket.close(1011, 'Connection handling failed')
      })
    })

    currentSocket.addEventListener('close', () => {
      clearTimeout(timeout)
      if (socket === currentSocket) {
        socket = null
        socketAuthenticated = false
        clearSocketTimers()
      }
      if (!settled) finish('failed')
      if (
        authenticated &&
        generation === connectionGeneration &&
        outcome === 'connected'
      ) {
        lastError ??= {
          code: 'BROWSER_EXTENSION_DISCONNECTED',
          message: 'The browser connection closed and will retry automatically.'
        }
        setLifecycle('reconnecting', { activePort: port, retryAt: null, lastError })
        void (async () => {
          const finishingAttempt = connectionAttempt
          if (finishingAttempt) await finishingAttempt.catch(() => false)
          if (!socketAuthenticated) await requestConnection('authenticated-disconnect')
        })()
      }
    })
    currentSocket.addEventListener('error', () => undefined)
  })
}

async function runConnectionAttempt(pairOverride, generation) {
  if (pairOverride) {
    const pairedOutcome = await connectPort(pairOverride.port, pairOverride, generation)
    if (pairedOutcome !== 'paired' || generation !== connectionGeneration) {
      if (pairedOutcome !== 'fatal') {
        await scheduleReconnect({
          code: 'PAIRING_CONNECTION_FAILED',
          message: 'Orbit could not complete the pairing connection.'
        })
      }
      return false
    }
  }

  const pairing = await getPairing()
  if (!pairing.secret || pairing.extensionOrigin !== EXTENSION_ORIGIN) {
    setLifecycle('unpaired', { activePort: null, retryAt: null, lastError: null })
    return false
  }

  for (const port of orderedPorts(pairing.port)) {
    if (generation !== connectionGeneration) return false
    const outcome = await connectPort(port, null, generation)
    if (outcome === 'connected') return true
    if (outcome === 'fatal') return false
  }

  await scheduleReconnect({
    code: 'BROWSER_BRIDGE_UNAVAILABLE',
    message: 'Orbit is not available on localhost ports 43117 through 43127.'
  })
  return false
}

function requestConnection(_reason, pairOverride = null, force = false) {
  if (connectionAttempt && !force) return connectionAttempt
  if (socketAuthenticated && !force) return Promise.resolve(true)
  if (force) {
    connectionGeneration += 1
    const previousSocket = socket
    socket = null
    socketAuthenticated = false
    previousSocket?.close(4001, 'Manual connection retry')
  }
  const generation = ++connectionGeneration
  const nextAttempt = runConnectionAttempt(pairOverride, generation)
  connectionAttempt = nextAttempt
  void nextAttempt.finally(() => {
    if (connectionAttempt === nextAttempt) connectionAttempt = null
  })
  return nextAttempt
}

async function pairWithOrbit(port, code) {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX || !/^\d{6}$/.test(code)) {
    return { ok: false, message: 'Enter a valid Orbit port and six-digit pairing code.' }
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pairResolver = null
      pairRejecter = null
      pairingAttempt = null
      resolve({
        ok: false,
        message: 'Pairing did not reach an authenticated connection. Start a new pairing session in Orbit.'
      })
    }, 15000)
    pairResolver = () => {
      clearTimeout(timeout)
      resolve({ ok: true, message: 'Paired and connected securely to Orbit.' })
    }
    pairRejecter = (error) => {
      clearTimeout(timeout)
      pairResolver = null
      pairRejecter = null
      resolve({ ok: false, message: error.message || 'Pairing failed.' })
    }
    void clearRetrySchedule()
      .then(() => requestConnection('pairing', { port, code }, true))
      .then((connected) => {
        if (!connected && pairRejecter) {
          pairRejecter(new Error(lastError?.message || 'Pairing could not authenticate.'))
        }
      })
  })
}

async function forgetPairing() {
  connectionGeneration += 1
  await clearRetrySchedule()
  const previousSocket = socket
  socket = null
  socketAuthenticated = false
  previousSocket?.close(4003, 'Pairing forgotten')
  clearSocketTimers()
  await chrome.storage.local.remove([
    'orbitPort',
    'orbitSecret',
    'orbitExtensionOrigin',
    'orbitPairingConfirmed'
  ])
  await chrome.storage.session.remove(['controlledTabId', 'orbitConnectionLifecycle'])
  pairingAttempt = null
  pairResolver = null
  pairRejecter = null
  lastCommandSequence = 0
  retryAttempt = 0
  lastAuthenticatedContactAt = 0
  setLifecycle('unpaired', { activePort: null, retryAt: null, lastError: null })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pair') {
    void pairWithOrbit(message.port, message.code).then(sendResponse)
    return true
  }
  if (message?.type === 'forget-pairing') {
    void forgetPairing().then(() => sendResponse({ ok: true }))
    return true
  }
  if (message?.type === 'get-status') {
    void getSafeConnectionStatus().then(sendResponse)
    return true
  }
  if (message?.type === 'retry-connection' || message?.type === 'ui-opened') {
    void clearRetrySchedule()
      .then(() => requestConnection(message.type, null, message.type === 'retry-connection'))
      .then((connected) =>
        sendResponse({
          ok: connected,
          message: connected
            ? 'Connected securely to Orbit.'
            : lastError?.message || 'Orbit is not connected yet.'
        })
      )
    return true
  }
  if (message?.type === 'get-origin-access') {
    void (async () => {
      const normalized = normalizeExactOrigin(message.origin)
      const origins = await getEffectiveGrantedOrigins()
      sendResponse({
        ok: Boolean(normalized),
        granted: Boolean(normalized && origins.includes(normalized))
      })
    })()
    return true
  }
  if (message?.type === 'site-granted' || message?.type === 'site-revoked') {
    void (async () => {
      const updated = await setGrantedOrigin(message.origin, message.type === 'site-granted')
      if (updated) await sendExtensionStatus()
      sendResponse({ ok: updated })
    })()
    return true
  }
  if (message?.type === 'permissions-changed') {
    void getEffectiveGrantedOrigins()
      .then(() => sendExtensionStatus())
      .then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return
  retryAt = null
  void requestConnection('alarm')
})
chrome.runtime.onStartup.addListener(() => void requestConnection('chrome-startup'))
chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
  void requestConnection('extension-installed')
})
chrome.tabs.onRemoved.addListener((tabId) => {
  void getControlledTabId().then((controlledTabId) => {
    if (controlledTabId === tabId) void setControlledTabId(null)
  })
})
chrome.permissions.onAdded.addListener(() => void sendExtensionStatus())
chrome.permissions.onRemoved.addListener(() => {
  void getEffectiveGrantedOrigins().then(() => sendExtensionStatus())
})

void (async () => {
  const saved = await chrome.storage.session.get('orbitConnectionLifecycle')
  const lifecycle = saved.orbitConnectionLifecycle
  if (isPlainObject(lifecycle)) {
    retryAttempt = Number.isInteger(lifecycle.retryAttempt) ? lifecycle.retryAttempt : 0
    retryAt = Number.isFinite(lifecycle.retryAt) ? lifecycle.retryAt : null
    lastError = isPlainObject(lifecycle.lastError) ? lifecycle.lastError : null
  }
  await getGrantedOriginAllowlist()
  await requestConnection('service-worker-startup')
})()
