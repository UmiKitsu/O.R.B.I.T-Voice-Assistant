/* eslint-disable @typescript-eslint/explicit-function-return-type */

export function evaluateYouTubePlaybackMeasurement(measurement) {
  if (typeof measurement !== 'object' || measurement === null) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED',
      message: 'The YouTube player returned an invalid verification result.',
      recoverable: true
    }
  }
  if (measurement.tabClosed === true) {
    return {
      ok: false,
      code: 'YOUTUBE_TAB_CLOSED',
      message: 'The controlled YouTube tab closed before playback could be verified.',
      recoverable: true
    }
  }
  if (measurement.mediaFound !== true) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYER_NOT_FOUND',
      message: 'The YouTube media player was not found.',
      recoverable: true
    }
  }
  if (
    typeof measurement.expectedVideoId === 'string' &&
    measurement.currentVideoId !== measurement.expectedVideoId
  ) {
    return {
      ok: false,
      code: 'YOUTUBE_TARGET_CHANGED',
      message: 'The controlled YouTube video changed before verification.',
      recoverable: true
    }
  }
  if (measurement.playRejected === true || measurement.paused === true) {
    return {
      ok: false,
      code: 'YOUTUBE_AUTOPLAY_BLOCKED',
      message: 'The video was opened, but Chrome blocked autoplay, so playback was not verified.',
      recoverable: true
    }
  }
  if (measurement.ended === true) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYBACK_ENDED',
      message: 'The selected YouTube video ended before playback could be verified.',
      recoverable: true
    }
  }
  if (
    typeof measurement.initialTime !== 'number' ||
    typeof measurement.currentTime !== 'number' ||
    measurement.currentTime < measurement.initialTime + 0.2
  ) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYBACK_NOT_ADVANCING',
      message: 'The video opened, but playback time did not advance enough to verify playback.',
      recoverable: true
    }
  }
  if (
    typeof measurement.url !== 'string' ||
    typeof measurement.muted !== 'boolean' ||
    typeof measurement.volume !== 'number'
  ) {
    return {
      ok: false,
      code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED',
      message: 'The YouTube player returned an incomplete playback state.',
      recoverable: true
    }
  }

  return {
    ok: true,
    message: 'YouTube playback was verified.',
    data: {
      videoId:
        typeof measurement.currentVideoId === 'string' ? measurement.currentVideoId : undefined,
      title: typeof measurement.title === 'string' ? measurement.title : undefined,
      url: measurement.url,
      paused: false,
      ended: false,
      muted: measurement.muted,
      volume: Math.max(0, Math.min(100, Math.round(measurement.volume))),
      currentTime: Math.max(0, measurement.currentTime),
      ...(typeof measurement.duration === 'number' && measurement.duration >= 0
        ? { duration: measurement.duration }
        : {}),
      confirmedPlaying: true
    }
  }
}
