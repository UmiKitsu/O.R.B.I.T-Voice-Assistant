/* eslint-disable @typescript-eslint/explicit-function-return-type */

export async function setYouTubePlayback(shouldPlay) {
  const video = document.querySelector('video.html5-main-video, video')
  if (!(video instanceof HTMLVideoElement)) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYER_NOT_FOUND',
      message: 'The YouTube media player was not found.',
      recoverable: true
    }
  }
  if (shouldPlay) {
    try {
      await video.play()
    } catch {
      return {
        ok: false,
        code: 'YOUTUBE_AUTOPLAY_BLOCKED',
        message: 'Chrome blocked YouTube playback.',
        recoverable: true
      }
    }
    const initialTime = Math.max(0, video.currentTime || 0)
    await new Promise((resolve) => setTimeout(resolve, 900))
    if (video.paused || video.ended || video.currentTime <= initialTime + 0.15) {
      return {
        ok: false,
        code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED',
        message: 'Orbit could not verify that the YouTube video resumed.',
        recoverable: true
      }
    }
  } else {
    video.pause()
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (!video.paused) {
      return {
        ok: false,
        code: 'YOUTUBE_PAUSE_NOT_VERIFIED',
        message: 'Orbit could not verify that the YouTube video paused.',
        recoverable: true
      }
    }
  }
  const url = new URL(location.href)
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message: shouldPlay ? 'Verified YouTube playback.' : 'Verified YouTube pause.',
    data: {
      videoId: url.searchParams.get('v') ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: Math.round(video.volume * 100),
      currentTime: Math.max(0, video.currentTime || 0),
      ...(Number.isFinite(video.duration) && video.duration >= 0
        ? { duration: video.duration }
        : {}),
      confirmedPlaying: !video.paused && !video.ended
    }
  }
}

export async function navigateYouTubePlayer(direction) {
  const initialUrl = new URL(location.href)
  const initialVideoId = initialUrl.searchParams.get('v')
  if (!initialVideoId) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYER_NOT_FOUND',
      message: 'The current YouTube video could not be identified.',
      recoverable: true
    }
  }
  const selector = direction === 'next' ? '.ytp-next-button' : '.ytp-prev-button'
  const button = document.querySelector(selector)
  const unavailableCode =
    direction === 'next' ? 'YOUTUBE_NEXT_UNAVAILABLE' : 'YOUTUBE_PREVIOUS_UNAVAILABLE'
  const unavailableMessage =
    direction === 'next'
      ? 'No next YouTube video is available.'
      : 'No previous YouTube video is available.'
  if (
    !(button instanceof HTMLElement) ||
    button.getAttribute('aria-disabled') === 'true' ||
    button.hasAttribute('disabled')
  ) {
    return {
      ok: false,
      code: unavailableCode,
      message: unavailableMessage,
      recoverable: true
    }
  }
  button.click()
  const deadline = Date.now() + 12000
  let changedVideo = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const currentVideoId = new URL(location.href).searchParams.get('v')
    if (currentVideoId && currentVideoId !== initialVideoId) {
      changedVideo = document.querySelector('video.html5-main-video, video')
      if (changedVideo instanceof HTMLVideoElement) break
    }
  }
  if (!(changedVideo instanceof HTMLVideoElement)) {
    return {
      ok: false,
      code: 'YOUTUBE_SPA_NAVIGATION_TIMEOUT',
      message: 'YouTube did not finish changing videos.',
      recoverable: true
    }
  }
  const newVideoId = new URL(location.href).searchParams.get('v')
  const initialTime = Math.max(0, changedVideo.currentTime || 0)
  await new Promise((resolve) => setTimeout(resolve, 1400))
  const verifiedVideoId = new URL(location.href).searchParams.get('v')
  if (verifiedVideoId !== newVideoId) {
    return {
      ok: false,
      code: 'YOUTUBE_TARGET_CHANGED',
      message: 'The YouTube video changed again before playback could be verified.',
      recoverable: true
    }
  }
  if (
    newVideoId === initialVideoId ||
    changedVideo.paused ||
    changedVideo.ended ||
    changedVideo.currentTime <= initialTime + 0.2
  ) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED',
      message: 'The YouTube video changed, but advancing playback was not verified.',
      recoverable: true
    }
  }
  const rawTitle = document.querySelector('h1 yt-formatted-string')?.textContent || document.title
  return {
    ok: true,
    message:
      direction === 'next'
        ? 'Verified the next YouTube video.'
        : 'Verified the previous YouTube video.',
    data: {
      videoId: verifiedVideoId ?? undefined,
      title: rawTitle.replace(/\s*-\s*YouTube\s*$/, '').trim() || undefined,
      url: location.href,
      paused: changedVideo.paused,
      ended: changedVideo.ended,
      muted: changedVideo.muted,
      volume: Math.round(changedVideo.volume * 100),
      currentTime: Math.max(0, changedVideo.currentTime || 0),
      ...(Number.isFinite(changedVideo.duration) && changedVideo.duration >= 0
        ? { duration: changedVideo.duration }
        : {}),
      confirmedPlaying: !changedVideo.paused && !changedVideo.ended
    }
  }
}
