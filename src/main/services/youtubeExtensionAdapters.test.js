/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { describe, expect, it } from 'vitest'
import { evaluateYouTubePlaybackMeasurement } from '../../../resources/orbit-browser-extension/youtube-playback.js'
import { selectFirstRegularYouTubeVideo } from '../../../resources/orbit-browser-extension/youtube-selection.js'

const REGULAR_VIDEO = {
  href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Bohemian Rhapsody',
  advertisement: false,
  shorts: false,
  channel: false,
  playlist: false,
  shelf: false
}

const PLAYING_MEASUREMENT = {
  mediaFound: true,
  expectedVideoId: 'dQw4w9WgXcQ',
  currentVideoId: 'dQw4w9WgXcQ',
  playRejected: false,
  initialTime: 12,
  currentTime: 13.7,
  paused: false,
  ended: false,
  muted: false,
  volume: 50,
  duration: 300,
  title: 'Bohemian Rhapsody',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
}

describe('YouTube result selection fixtures', () => {
  it('skips ads and chooses the first regular watch video', () => {
    expect(
      selectFirstRegularYouTubeVideo([
        { ...REGULAR_VIDEO, advertisement: true, title: 'Sponsored result' },
        REGULAR_VIDEO
      ])
    ).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'Bohemian Rhapsody',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    })
  })

  it('excludes Shorts, channels, playlists, and shelves', () => {
    expect(
      selectFirstRegularYouTubeVideo([
        { ...REGULAR_VIDEO, shorts: true },
        { ...REGULAR_VIDEO, channel: true },
        { ...REGULAR_VIDEO, playlist: true },
        { ...REGULAR_VIDEO, shelf: true },
        { ...REGULAR_VIDEO, href: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'Regular video' }
      ])
    ).toMatchObject({ videoId: '9bZkp7q19f0', title: 'Regular video' })
  })

  it('rejects malformed URLs and unsupported YouTube result types', () => {
    expect(
      selectFirstRegularYouTubeVideo([
        { ...REGULAR_VIDEO, href: 'https://evil.example/watch?v=dQw4w9WgXcQ' },
        { ...REGULAR_VIDEO, href: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
        { ...REGULAR_VIDEO, href: 'https://www.youtube.com/watch?v=bad' },
        { ...REGULAR_VIDEO, title: '   ' },
        REGULAR_VIDEO
      ])
    ).toMatchObject({ videoId: 'dQw4w9WgXcQ' })
  })

  it('fails safely for no results, then succeeds when delayed results arrive', () => {
    expect(selectFirstRegularYouTubeVideo([])).toBeNull()
    expect(selectFirstRegularYouTubeVideo([REGULAR_VIDEO])).toMatchObject({
      videoId: 'dQw4w9WgXcQ'
    })
  })
})

describe('YouTube playback verification fixtures', () => {
  it('reports success only for advancing, unpaused playback', () => {
    expect(evaluateYouTubePlaybackMeasurement(PLAYING_MEASUREMENT)).toMatchObject({
      ok: true,
      data: {
        videoId: 'dQw4w9WgXcQ',
        confirmedPlaying: true,
        paused: false,
        currentTime: 13.7
      }
    })
  })

  it.each([
    [{ ...PLAYING_MEASUREMENT, paused: true }, 'YOUTUBE_AUTOPLAY_BLOCKED'],
    [{ ...PLAYING_MEASUREMENT, playRejected: true }, 'YOUTUBE_AUTOPLAY_BLOCKED'],
    [{ ...PLAYING_MEASUREMENT, currentTime: 12.1 }, 'YOUTUBE_PLAYBACK_NOT_ADVANCING'],
    [{ ...PLAYING_MEASUREMENT, ended: true }, 'YOUTUBE_PLAYBACK_ENDED'],
    [{ tabClosed: true }, 'YOUTUBE_TAB_CLOSED'],
    [{ ...PLAYING_MEASUREMENT, currentVideoId: '9bZkp7q19f0' }, 'YOUTUBE_TARGET_CHANGED'],
    [{ mediaFound: false, expectedVideoId: 'dQw4w9WgXcQ' }, 'YOUTUBE_PLAYER_NOT_FOUND']
  ])('fails honestly for playback state %#', (measurement, code) => {
    expect(evaluateYouTubePlaybackMeasurement(measurement)).toMatchObject({
      ok: false,
      code,
      recoverable: true
    })
  })
})
