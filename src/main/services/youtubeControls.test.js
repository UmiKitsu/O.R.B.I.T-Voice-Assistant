/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  navigateYouTubePlayer,
  setYouTubePlayback
} from '../../../resources/orbit-browser-extension/youtube-controls.js'

class FakeVideo {
  constructor({ paused = true, currentTime = 0, advanceOnPlay = true, rejectPlay = false } = {}) {
    this.paused = paused
    this.currentTime = currentTime
    this.advanceOnPlay = advanceOnPlay
    this.rejectPlay = rejectPlay
    this.ended = false
    this.muted = false
    this.volume = 0.5
    this.duration = 300
  }

  async play() {
    if (this.rejectPlay) throw new Error('blocked')
    this.paused = false
    if (this.advanceOnPlay) {
      setTimeout(() => {
        this.currentTime += 1
      }, 500)
    }
  }

  pause() {
    this.paused = true
  }
}

class FakeElement {
  constructor({ disabled = false, onClick = () => undefined } = {}) {
    this.disabled = disabled
    this.onClick = onClick
  }

  getAttribute(name) {
    return name === 'aria-disabled' && this.disabled ? 'true' : null
  }

  hasAttribute(name) {
    return name === 'disabled' && this.disabled
  }

  click() {
    this.onClick()
  }
}

let currentVideo
let nextButton
let previousButton
let pageTitle

function setLocation(href) {
  globalThis.location.href = href
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
  globalThis.HTMLVideoElement = FakeVideo
  globalThis.HTMLElement = FakeElement
  globalThis.location = { href: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' }
  currentVideo = new FakeVideo()
  nextButton = new FakeElement({ disabled: true })
  previousButton = new FakeElement({ disabled: true })
  pageTitle = 'Fixture video - YouTube'
  globalThis.document = {
    title: pageTitle,
    querySelector(selector) {
      if (selector === 'video.html5-main-video, video') return currentVideo
      if (selector === '.ytp-next-button') return nextButton
      if (selector === '.ytp-prev-button') return previousButton
      if (selector === 'h1 yt-formatted-string') return { textContent: pageTitle }
      return null
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete globalThis.HTMLVideoElement
  delete globalThis.HTMLElement
  delete globalThis.location
  delete globalThis.document
})

describe('explicit YouTube play and pause controls', () => {
  it('verifies resumed playback only after media time advances', async () => {
    currentVideo = new FakeVideo({ paused: true, currentTime: 10, advanceOnPlay: true })
    const pending = setYouTubePlayback(true)
    await vi.advanceTimersByTimeAsync(901)

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: {
        videoId: 'AAAAAAAAAAA',
        paused: false,
        confirmedPlaying: true,
        currentTime: 11
      }
    })
  })

  it('verifies a separate pause operation', async () => {
    currentVideo = new FakeVideo({ paused: false, currentTime: 20 })
    const pending = setYouTubePlayback(false)
    await vi.advanceTimersByTimeAsync(151)

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { paused: true, confirmedPlaying: false }
    })
  })

  it.each([
    [new FakeVideo({ rejectPlay: true }), 'YOUTUBE_AUTOPLAY_BLOCKED'],
    [new FakeVideo({ advanceOnPlay: false }), 'YOUTUBE_PLAYBACK_NOT_VERIFIED']
  ])('fails honestly when resumed playback cannot be verified', async (video, code) => {
    currentVideo = video
    const pending = setYouTubePlayback(true)
    await vi.advanceTimersByTimeAsync(901)
    await expect(pending).resolves.toMatchObject({ ok: false, code, recoverable: true })
  })
})

describe('YouTube next and previous controls', () => {
  it.each([
    ['next', 'BBBBBBBBBBB'],
    ['previous', 'CCCCCCCCCCC']
  ])('uses the fixed %s control and verifies SPA playback', async (direction, nextVideoId) => {
    currentVideo = new FakeVideo({ paused: false, currentTime: 0, advanceOnPlay: false })
    const button = new FakeElement({
      onClick: () => {
        setLocation(`https://www.youtube.com/watch?v=${nextVideoId}`)
        setTimeout(() => {
          currentVideo.currentTime = 1
        }, 600)
      }
    })
    if (direction === 'next') nextButton = button
    else previousButton = button

    const pending = navigateYouTubePlayer(direction)
    await vi.advanceTimersByTimeAsync(2_001)

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: {
        videoId: nextVideoId,
        paused: false,
        confirmedPlaying: true,
        currentTime: 1
      }
    })
  })

  it.each([
    ['next', 'YOUTUBE_NEXT_UNAVAILABLE'],
    ['previous', 'YOUTUBE_PREVIOUS_UNAVAILABLE']
  ])('returns a clear unavailable result for %s', async (direction, code) => {
    await expect(navigateYouTubePlayer(direction)).resolves.toMatchObject({
      ok: false,
      code,
      recoverable: true
    })
  })

  it('reports a SPA navigation timeout when the video ID never changes', async () => {
    nextButton = new FakeElement()
    const pending = navigateYouTubePlayer('next')
    await vi.advanceTimersByTimeAsync(12_001)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'YOUTUBE_SPA_NAVIGATION_TIMEOUT'
    })
  })

  it('rejects a target that changes again during verification', async () => {
    currentVideo = new FakeVideo({ paused: false, currentTime: 0, advanceOnPlay: false })
    nextButton = new FakeElement({
      onClick: () => {
        setLocation('https://www.youtube.com/watch?v=BBBBBBBBBBB')
        setTimeout(() => {
          currentVideo.currentTime = 1
        }, 600)
        setTimeout(() => {
          setLocation('https://www.youtube.com/watch?v=CCCCCCCCCCC')
        }, 800)
      }
    })
    const pending = navigateYouTubePlayer('next')
    await vi.advanceTimersByTimeAsync(2_001)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'YOUTUBE_TARGET_CHANGED'
    })
  })

  it('does not claim success when the new video is not advancing', async () => {
    currentVideo = new FakeVideo({ paused: false, currentTime: 0, advanceOnPlay: false })
    nextButton = new FakeElement({
      onClick: () => setLocation('https://www.youtube.com/watch?v=BBBBBBBBBBB')
    })
    const pending = navigateYouTubePlayer('next')
    await vi.advanceTimersByTimeAsync(2_001)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED'
    })
  })
})
