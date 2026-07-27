import type { PolicyRequest } from '../security/policyEngine'

function action(capability: string, parameters: unknown, summary: string): PolicyRequest {
  return { capability, parameters, summary }
}

export function routeDeterministicCommand(message: string): PolicyRequest | null {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const lower = normalized.toLocaleLowerCase()

  if (/^(tell me |what(?:'s| is) )?(the )?(current )?time$/.test(lower)) {
    return action('system.getTime', {}, 'Read the local system time')
  }

  if (
    /^(tell me |what(?:'s| is) )?(the )?(current |today'?s )?date$/.test(lower) ||
    /^(what day is it|what is today'?s date)$/.test(lower)
  ) {
    return action('system.getDate', {}, 'Read the local system date')
  }

  const youtubeSearch = normalized.match(/^(?:search youtube for|youtube search for)\s+(.+)$/i)
  if (youtubeSearch) {
    return action('browser.searchYouTube', { query: youtubeSearch[1].trim() }, 'Search YouTube')
  }

  const webSearch = normalized.match(/^(?:search (?:the web|google) for)\s+(.+)$/i)
  if (webSearch) {
    return action('browser.searchWeb', { query: webSearch[1].trim() }, 'Search the web')
  }

  if (/^(?:open|go to) youtube$/.test(lower)) {
    return action('browser.openUrl', { url: 'https://www.youtube.com/' }, 'Open YouTube')
  }

  const fixedActions: ReadonlyArray<[RegExp, string, string]> = [
    [
      /^(?:play|pause|play or pause|play pause)(?: the)?(?: music| media)?$/,
      'media.playPause',
      'Play or pause media'
    ],
    [/^(?:next|next track|skip)(?: song| track)?$/, 'media.next', 'Play the next track'],
    [/^(?:previous|previous track|last track)$/, 'media.previous', 'Play the previous track'],
    [/^(?:volume up|turn (?:the )?volume up)$/, 'audio.volumeUp', 'Raise the volume'],
    [/^(?:volume down|turn (?:the )?volume down)$/, 'audio.volumeDown', 'Lower the volume'],
    [/^(?:mute|mute (?:the )?(?:audio|volume))$/, 'audio.mute', 'Send the audio mute key'],
    [/^(?:unmute|unmute (?:the )?(?:audio|volume))$/, 'audio.unmute', 'Send the audio mute key']
  ]

  for (const [pattern, capability, summary] of fixedActions) {
    if (pattern.test(lower)) return action(capability, {}, summary)
  }

  const applicationRequest = normalized.match(/^(?:open|launch|start)\s+(.+)$/i)
  if (applicationRequest) {
    return action(
      'application.launch',
      { application: applicationRequest[1].trim() },
      'Open a registered application'
    )
  }

  return null
}
