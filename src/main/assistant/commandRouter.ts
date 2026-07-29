import type { ActionPlan } from './actionPlanSchemas'

function actionPlan(
  summary: string,
  capability: string,
  parameters: Record<string, unknown> = {}
): ActionPlan {
  return {
    kind: 'action_plan',
    summary,
    actions: [{ capability, parameters }]
  }
}

const SPOKEN_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}

function parseSpokenNumber(value: string): number | null {
  const normalized = value.trim().toLocaleLowerCase().replaceAll('-', ' ')
  if (/^\d{1,3}$/.test(normalized)) return Number(normalized)
  const tokens = normalized.split(/\s+/).filter((token) => token !== 'and')
  if (tokens.length === 0) return null
  let total = 0
  for (const token of tokens) {
    if (token === 'hundred') {
      if (total < 1 || total > 3) return null
      total *= 100
      continue
    }
    const number = SPOKEN_NUMBERS[token]
    if (number === undefined) return null
    total += number
  }
  return total >= 0 && total <= 300 ? total : null
}

export function routeDeterministicCommand(message: string): ActionPlan | null {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const lower = normalized.toLocaleLowerCase()

  if (/^open powershell$/.test(lower)) {
    return actionPlan('Open a blank PowerShell window', 'application.launch', {
      application: 'powershell'
    })
  }

  if (/^open powershell\s+and\s+.+$/.test(lower)) {
    return actionPlan('Run a raw PowerShell command', 'powershell.execute')
  }

  const deleteRequest = normalized.match(/^delete\s+(.+)$/i)
  if (deleteRequest) {
    return actionPlan('Move an item to the Recycle Bin', 'filesystem.delete', {
      path: deleteRequest[1].trim()
    })
  }

  const moveRequest = normalized.match(/^move\s+(.+?)\s+to\s+(.+)$/i)
  if (moveRequest) {
    return actionPlan('Move a file or folder', 'filesystem.move', {
      source: moveRequest[1].trim(),
      destination: moveRequest[2].trim()
    })
  }

  const copyRequest = normalized.match(/^copy\s+(.+?)\s+to\s+(.+)$/i)
  if (copyRequest) {
    return actionPlan('Copy a file', 'filesystem.copy', {
      source: copyRequest[1].trim(),
      destination: copyRequest[2].trim()
    })
  }

  const renameRequest = normalized.match(/^rename\s+(.+?)\s+to\s+(.+)$/i)
  if (renameRequest) {
    return actionPlan('Rename a file or folder', 'filesystem.rename', {
      source: renameRequest[1].trim(),
      newName: renameRequest[2].trim()
    })
  }

  const createFolderRequest = normalized.match(/^create (?:a )?(?:new )?folder\s+(.+)$/i)
  if (createFolderRequest) {
    return actionPlan('Create a folder', 'filesystem.createDirectory', {
      path: createFolderRequest[1].trim()
    })
  }

  const installRequest = normalized.match(/^install\s+(.+)$/i)
  if (installRequest) {
    return actionPlan('Start a local software installer', 'software.install', {
      installerPath: installRequest[1].trim()
    })
  }

  const appendRequest = normalized.match(/^append\s+(.+?)\s+to\s+(.+)$/i)
  if (appendRequest) {
    return actionPlan('Append text to a file', 'filesystem.append', {
      content: appendRequest[1],
      path: appendRequest[2].trim()
    })
  }

  if (/^(?:list|show) (?:the )?(?:running )?(?:user )?(?:applications|processes)$/.test(lower)) {
    return actionPlan('List ordinary current-user applications', 'process.listUser', { limit: 50 })
  }

  if (/^(?:list|show) (?:the )?(?:available|installed) applications$/.test(lower)) {
    return actionPlan('List available applications', 'application.listAvailable', { limit: 50 })
  }

  if (/^(?:show|tell me) (?:the )?(?:system|computer) information$/.test(lower)) {
    return actionPlan('Read bounded system information', 'system.getInformation')
  }

  if (/^(?:show|tell me) (?:the )?battery(?: status)?$/.test(lower)) {
    return actionPlan('Read the battery status', 'system.getBattery')
  }

  if (/^(?:show|tell me) (?:the )?network status$/.test(lower)) {
    return actionPlan('Read the network status', 'system.getNetworkStatus')
  }

  if (/^lock (?:the )?(?:computer|pc|windows)$/.test(lower)) {
    return actionPlan('Lock Windows', 'system.lock')
  }

  if (/^(?:sign|log) out(?: of windows)?$/.test(lower)) {
    return actionPlan('Sign out of Windows', 'system.signOut')
  }

  if (/^restart (?:the )?(?:computer|pc|windows)$/.test(lower)) {
    return actionPlan('Restart Windows', 'system.restart')
  }

  if (/^(?:shut down|shutdown) (?:the )?(?:computer|pc|windows)$/.test(lower)) {
    return actionPlan('Shut down Windows', 'system.shutdown')
  }

  if (/^stop speaking$/.test(lower)) {
    return actionPlan('Stop speaking', 'assistant.stopSpeaking')
  }

  if (/^disable orbit$/.test(lower)) {
    return actionPlan('Disable Orbit', 'assistant.disable')
  }

  if (
    /^(tell me |what(?:'s| is) )?(the )?(current )?time$/.test(lower) ||
    /^what time is it$/.test(lower)
  ) {
    return actionPlan('Read the local system time', 'system.getTime')
  }

  if (
    /^(tell me |what(?:'s| is) )?(the )?(current |today'?s )?date$/.test(lower) ||
    /^(what day is it|what is today'?s date)$/.test(lower)
  ) {
    return actionPlan('Read the local system date', 'system.getDate')
  }

  const youtubeSearch = normalized.match(/^(?:search youtube for|youtube search for)\s+(.+)$/i)
  if (youtubeSearch) {
    return actionPlan('Search YouTube', 'browser.searchYouTube', {
      query: youtubeSearch[1].trim()
    })
  }

  if (/^search google$/.test(lower)) {
    return actionPlan('Open Google Search', 'browser.openUrl', { url: 'https://www.google.com' })
  }

  const webSearch = normalized.match(/^(?:search (?:the web|google) for)\s+(.+)$/i)
  if (webSearch) {
    return actionPlan('Search the web', 'browser.searchWeb', { query: webSearch[1].trim() })
  }

  if (/^(?:open|go to) youtube$/.test(lower)) {
    return actionPlan('Open YouTube', 'browser.openUrl', { url: 'https://www.youtube.com' })
  }

  if (/^(?:pause) (?:the )?youtube video$/.test(lower)) {
    return actionPlan('Pause the YouTube video', 'youtube.pause')
  }

  if (/^(?:resume|play) (?:the )?youtube video$/.test(lower)) {
    return actionPlan('Resume the YouTube video', 'youtube.play')
  }

  if (/^play or pause (?:the )?youtube video$/.test(lower)) {
    return actionPlan('Play or pause the YouTube video', 'youtube.playPause')
  }

  if (/^(?:next|skip)(?: the)? youtube video$/.test(lower)) {
    return actionPlan('Play the next YouTube video', 'youtube.next')
  }

  if (/^(?:previous|go back to the previous)(?: youtube)? video$/.test(lower)) {
    return actionPlan('Play the previous YouTube video', 'youtube.previous')
  }

  const youtubeSeekRequest = normalized.match(
    /^(?:skip|seek|jump)\s+(forward|ahead|back|backward)\s+(.+?)\s+seconds?$/i
  )
  if (youtubeSeekRequest) {
    const amount = parseSpokenNumber(youtubeSeekRequest[2])
    if (amount !== null && amount > 0) {
      const seconds = /^(?:back|backward)$/i.test(youtubeSeekRequest[1]) ? -amount : amount
      return actionPlan('Seek the YouTube video', 'youtube.seekBy', { seconds })
    }
  }

  const youtubeVolumeRequest = normalized.match(
    /^(?:set|change) (?:the )?(?:youtube |video )?volume to (.+?)(?:\s*(?:percent|%))?$/i
  )
  if (youtubeVolumeRequest && /(?:youtube|video)/i.test(normalized)) {
    const volume = parseSpokenNumber(youtubeVolumeRequest[1])
    if (volume !== null && volume >= 0 && volume <= 100) {
      return actionPlan(`Set the YouTube volume to ${volume} percent`, 'youtube.setVolume', {
        volume
      })
    }
  }

  if (/^(?:make|put) (?:the )?(?:youtube )?video (?:in )?fullscreen$/.test(lower)) {
    return actionPlan('Make the YouTube video fullscreen', 'youtube.fullscreen')
  }

  if (/^(?:mute) (?:the )?(?:youtube )?video$/.test(lower)) {
    return actionPlan('Mute the YouTube video', 'youtube.mute')
  }

  if (/^(?:unmute) (?:the )?(?:youtube )?video$/.test(lower)) {
    return actionPlan('Unmute the YouTube video', 'youtube.unmute')
  }

  if (/^(?:open )?(?:a )?new (?:browser )?tab$/.test(lower)) {
    return actionPlan('Open a new controlled browser tab', 'browser.newTab')
  }

  if (/^(?:close) (?:the )?(?:browser )?tab$/.test(lower)) {
    return actionPlan('Close the controlled browser tab', 'browser.closeTab')
  }

  const switchTabRequest = normalized.match(/^(?:switch|go) to (?:the )?(.+?) tab$/i)
  if (switchTabRequest) {
    return actionPlan('Switch the controlled browser tab', 'browser.switchTab', {
      query: switchTabRequest[1].trim()
    })
  }

  if (/^(?:browser back|go back in (?:the )?browser)$/.test(lower)) {
    return actionPlan('Go back in the controlled browser tab', 'browser.goBack')
  }

  if (/^(?:browser forward|go forward in (?:the )?browser)$/.test(lower)) {
    return actionPlan('Go forward in the controlled browser tab', 'browser.goForward')
  }

  if (/^(?:reload|refresh)(?: the)?(?: browser| page| tab)?$/.test(lower)) {
    return actionPlan('Reload the controlled browser tab', 'browser.reload')
  }

  const scrollRequest = normalized.match(
    /^scroll\s+(up|down|left|right)(?:\s+(\d{2,4})(?:\s+pixels?)?)?$/i
  )
  if (scrollRequest) {
    const amount = scrollRequest[2] ? Number(scrollRequest[2]) : 700
    if (amount >= 100 && amount <= 5_000) {
      return actionPlan('Scroll the controlled browser tab', 'browser.scroll', {
        direction: scrollRequest[1].toLocaleLowerCase(),
        amount
      })
    }
  }

  const setVolumeRequest = normalized.match(
    /^(?:set|change) (?:the )?volume to (\d{1,3})(?:\s*(?:percent|%))?$/i
  )
  if (setVolumeRequest) {
    const volume = Number(setVolumeRequest[1])
    if (volume >= 0 && volume <= 100) {
      return actionPlan(`Set volume to ${volume} percent`, 'audio.setVolume', { volume })
    }
  }

  const windowActionRequest = normalized.match(/^(maximize|minimize|restore|focus)\s+(.+)$/i)
  if (windowActionRequest) {
    const action = windowActionRequest[1].toLocaleLowerCase()
    return actionPlan(
      `${action[0].toLocaleUpperCase()}${action.slice(1)} an application`,
      `application.${action}`,
      { application: windowActionRequest[2].trim() }
    )
  }

  if (
    /^(?:is spotify (?:playing|paused)|what(?:'s| is) playing on spotify|spotify playback status)$/.test(
      lower
    )
  ) {
    return actionPlan('Check Spotify playback state', 'media.getPlaybackState', {
      sourceApplication: 'spotify'
    })
  }
  if (/^(?:pause spotify|pause (?:the )?music on spotify)$/.test(lower)) {
    return actionPlan('Pause Spotify and verify its state', 'media.pause', {
      sourceApplication: 'spotify'
    })
  }
  if (/^(?:resume spotify|resume (?:the )?music on spotify)$/.test(lower)) {
    return actionPlan('Resume Spotify and verify its state', 'media.play', {
      sourceApplication: 'spotify'
    })
  }
  if (
    /^(?:(?:play|go to) (?:the )?)?(?:next(?: song| track)?|skip(?: it| this(?: song| track)?| (?:the )?(?:song|track))?) on spotify$/.test(
      lower
    )
  ) {
    return actionPlan('Play the next Spotify track and read its state', 'media.nextTrack', {
      sourceApplication: 'spotify'
    })
  }
  if (
    /^(?:previous(?: song| track)?|last(?: song| track)|go back(?: one (?:song|track))?|back one (?:song|track)|(?:play|go back to) (?:the )?(?:previous|last) (?:song|track)) on spotify$/.test(
      lower
    )
  ) {
    return actionPlan('Play the previous Spotify track and read its state', 'media.previousTrack', {
      sourceApplication: 'spotify'
    })
  }

  const fixedActions: ReadonlyArray<[RegExp, string, string]> = [
    [
      /^(?:play|pause|play or pause|play pause)(?: the)?(?: music| media)?$/,
      'media.playPause',
      'Play or pause media'
    ],
    [
      /^(?:(?:play|go to) (?:the )?)?(?:next(?: song| track)?|skip(?: it| this(?: song| track)?| (?:the )?(?:song|track))?)(?: on spotify)?$/,
      'media.next',
      'Send the next-track command'
    ],
    [
      /^(?:previous(?: song| track)?|last(?: song| track)|go back(?: one (?:song|track))?|back one (?:song|track)|(?:play|go back to) (?:the )?(?:previous|last) (?:song|track))(?: on spotify)?$/,
      'media.previous',
      'Send the previous-track command'
    ],
    [/^(?:volume up|turn (?:the )?volume up)$/, 'audio.volumeUp', 'Raise the volume'],
    [/^(?:volume down|turn (?:the )?volume down)$/, 'audio.volumeDown', 'Lower the volume'],
    [/^(?:mute|mute (?:the )?(?:audio|volume))$/, 'audio.mute', 'Send the audio mute key'],
    [/^(?:unmute|unmute (?:the )?(?:audio|volume))$/, 'audio.unmute', 'Send the audio mute key']
  ]

  for (const [pattern, capability, summary] of fixedActions) {
    if (pattern.test(lower)) return actionPlan(summary, capability)
  }

  const applicationRequest = normalized.match(/^(?:open|launch|start)\s+(.+)$/i)
  if (applicationRequest) {
    return actionPlan('Open a registered application', 'application.launch', {
      application: applicationRequest[1].trim()
    })
  }

  return null
}

type RoutedPlaybackIntent = 'track' | 'artist'

type ParsedMediaQuery = {
  query: string
  intent?: RoutedPlaybackIntent
}

function validMediaQuery(query: string): string | null {
  const normalized = query.trim()
  if (
    !normalized ||
    normalized.length > 200 ||
    /^(?:it|that|this|music|something)$/i.test(normalized)
  ) {
    return null
  }
  return normalized
}

function parseMediaQuery(value: string): ParsedMediaQuery | null {
  const trimmed = value.trim()
  const artistBy = trimmed.match(/^(?:music|songs?)\s+by\s+(.+)$/i)
  const artistSong = trimmed.match(/^(?:(?:a|some)\s+)?(.+?)\s+(?:song|songs|music)$/i)
  const explicitTrack = trimmed.match(/^(?:the\s+)?(?:song|track)\s+(.+)$/i)

  const query = validMediaQuery(artistBy?.[1] ?? artistSong?.[1] ?? explicitTrack?.[1] ?? trimmed)
  if (!query) return null
  if (artistBy || artistSong) return { query, intent: 'artist' }
  if (explicitTrack) return { query, intent: 'track' }
  return { query }
}

function normalizeMediaQuery(value: string): string | null {
  return parseMediaQuery(value)?.query ?? null
}

function playbackParameters(parsed: ParsedMediaQuery): Record<string, unknown> {
  return parsed.intent ? { query: parsed.query, intent: parsed.intent } : { query: parsed.query }
}

export function routeContextualCommand(
  message: string,
  context: import('../../shared/types').AssistantSessionContext
): ActionPlan | null {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const lower = normalized.toLocaleLowerCase()

  if (context.lastMediaApplication === 'youtube' && context.confirmedYouTubePlayback === true) {
    if (/^(?:pause|pause it|pause the video)$/.test(lower)) {
      return actionPlan('Pause the YouTube video', 'youtube.pause')
    }
    if (/^(?:play|resume|play it|resume it|play the video|resume the video)$/.test(lower)) {
      return actionPlan('Resume the YouTube video', 'youtube.play')
    }
    if (/^(?:next|next video|skip|skip it|skip this|skip this video)$/.test(lower)) {
      return actionPlan('Play the next YouTube video', 'youtube.next')
    }
    if (/^(?:previous|previous video|go back|go back to the previous video)$/.test(lower)) {
      return actionPlan('Play the previous YouTube video', 'youtube.previous')
    }
  }

  if (context.lastMediaApplication === 'spotify') {
    if (/^(?:is it playing|is spotify playing|what(?:'s| is) playing)$/.test(lower)) {
      return actionPlan('Check Spotify playback state', 'media.getPlaybackState', {
        sourceApplication: 'spotify'
      })
    }
    if (/^(?:pause|pause it|pause spotify)$/.test(lower)) {
      return actionPlan('Pause Spotify and verify its state', 'media.pause', {
        sourceApplication: 'spotify'
      })
    }
    if (/^(?:resume|resume it|play it|resume spotify)$/.test(lower)) {
      return actionPlan('Resume Spotify and verify its state', 'media.play', {
        sourceApplication: 'spotify'
      })
    }
    if (/^(?:next|next song|next track|skip|skip it|skip this song|skip this track)$/.test(lower)) {
      return actionPlan('Play the next Spotify track and read its state', 'media.nextTrack', {
        sourceApplication: 'spotify'
      })
    }
    if (/^(?:previous|previous song|previous track|last song|last track|go back)$/.test(lower)) {
      return actionPlan(
        'Play the previous Spotify track and read its state',
        'media.previousTrack',
        {
          sourceApplication: 'spotify'
        }
      )
    }
  }

  const directSpotify = normalized.match(/^play\s+(.+?)\s+(?:on|in)\s+spotify$/i)
  const directYouTube = normalized.match(
    /^play\s+(.+?)\s+(?:on|in)\s+(?:youtube|the browser|browser|the web|web)$/i
  )
  const contextualSpotify =
    context.lastMediaApplication === 'spotify' || context.lastApplication === 'spotify'
      ? normalized.match(/^play\s+(.+)$/i)
      : null
  const contextualYouTube =
    context.lastMediaApplication === 'youtube' ? normalized.match(/^play\s+(.+)$/i) : null
  const spotifyQuery = parseMediaQuery(directSpotify?.[1] ?? contextualSpotify?.[1] ?? '')
  const youtubeQuery = normalizeMediaQuery(directYouTube?.[1] ?? contextualYouTube?.[1] ?? '')

  if (spotifyQuery) {
    return actionPlan(
      'Play the top matching Spotify track',
      'spotify.playSearch',
      playbackParameters(spotifyQuery)
    )
  }

  if (youtubeQuery) {
    return actionPlan('Open matching music on YouTube', 'youtube.playSearch', {
      query: youtubeQuery
    })
  }

  const preferredQuery = parseMediaQuery(normalized.match(/^play\s+(.+)$/i)?.[1] ?? '')
  if (preferredQuery) {
    return actionPlan(
      'Play music using the preferred provider',
      'music.playSearch',
      playbackParameters(preferredQuery)
    )
  }

  const applicationAction = normalized.match(/^(focus|maximize|minimize|restore|close)\s+it$/i)
  if (applicationAction && context.lastApplication) {
    const requestedAction = applicationAction[1].toLocaleLowerCase()
    const capabilityAction = requestedAction === 'close' ? 'closeSafe' : requestedAction
    return actionPlan(
      `${requestedAction[0].toLocaleUpperCase()}${requestedAction.slice(1)} the current application`,
      `application.${capabilityAction}`,
      { application: context.lastApplication }
    )
  }

  return null
}

export function extractAmbiguousMediaQuery(
  message: string,
  context: import('../../shared/types').AssistantSessionContext = {}
): string | null {
  if (context.lastMediaApplication || context.lastApplication === 'spotify') return null

  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const playbackRequest = normalized.match(/^play\s+(.+)$/i)
  return normalizeMediaQuery(playbackRequest?.[1] ?? '')
}

export function getUnclassifiedSpotifyPlaybackQuery(plan: ActionPlan): string | null {
  if (plan.actions.length !== 1) return null
  const [action] = plan.actions
  if (
    !action ||
    !['spotify.playSearch', 'music.playSearch'].includes(action.capability) ||
    Object.hasOwn(action.parameters, 'intent') ||
    typeof action.parameters.query !== 'string'
  ) {
    return null
  }
  return action.parameters.query
}

export function applySpotifyPlaybackIntent(
  plan: ActionPlan,
  intent: RoutedPlaybackIntent
): ActionPlan {
  const query = getUnclassifiedSpotifyPlaybackQuery(plan)
  if (!query) return plan
  return {
    ...plan,
    actions: [
      {
        ...plan.actions[0],
        parameters: { query, intent }
      }
    ]
  }
}

export function routeMediaDestinationResponse(message: string, query: string): ActionPlan | null {
  const destination = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
    .toLocaleLowerCase()

  if (/^(?:on |in )?spotify(?: desktop| app)?$/.test(destination)) {
    return actionPlan('Play the top matching Spotify track', 'spotify.playSearch', { query })
  }

  if (
    /^(?:(?:on|in) )?(?:the )?(?:youtube|browser|web|chrome|default browser)$/.test(destination)
  ) {
    return actionPlan('Open matching music on YouTube', 'youtube.playSearch', { query })
  }

  return null
}

export function isClarificationCancellation(message: string): boolean {
  return /^(?:cancel|never ?mind|stop|no)(?:[.!?]+)?$/i.test(message.trim())
}

export function isConversationResetCommand(message: string): boolean {
  return /^clear (?:the )?conversation(?:[.!?]+)?$/i.test(message.trim())
}

export function routeCommand(
  message: string,
  context: import('../../shared/types').AssistantSessionContext = {}
): ActionPlan | null {
  return routeContextualCommand(message, context) ?? routeDeterministicCommand(message)
}
