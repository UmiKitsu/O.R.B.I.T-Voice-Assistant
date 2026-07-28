/* eslint-disable @typescript-eslint/explicit-function-return-type */

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function selectFirstRegularYouTubeVideo(candidates) {
  if (!Array.isArray(candidates)) return null

  for (const candidate of candidates.slice(0, 100)) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      candidate.advertisement === true ||
      candidate.shorts === true ||
      candidate.channel === true ||
      candidate.playlist === true ||
      candidate.shelf === true ||
      typeof candidate.href !== 'string' ||
      typeof candidate.title !== 'string'
    ) {
      continue
    }

    let url
    try {
      url = new URL(candidate.href, 'https://www.youtube.com')
    } catch {
      continue
    }

    const videoId = url.searchParams.get('v') ?? ''
    const title = candidate.title.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.youtube.com' ||
      url.pathname !== '/watch' ||
      !VIDEO_ID_PATTERN.test(videoId) ||
      !title
    ) {
      continue
    }

    url.hash = ''
    return { videoId, title, url: url.toString() }
  }

  return null
}
