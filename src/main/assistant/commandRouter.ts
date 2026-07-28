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

export function routeDeterministicCommand(message: string): ActionPlan | null {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const lower = normalized.toLocaleLowerCase()

  if (/^open powershell(?:\s+and\s+.+)?$/.test(lower)) {
    return actionPlan('Run PowerShell', 'powershell.execute')
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

  const fixedActions: ReadonlyArray<[RegExp, string, string]> = [
    [
      /^(?:play|pause|play or pause|play pause)(?: the)?(?: music| media)?$/,
      'media.playPause',
      'Play or pause media'
    ],
    [
      /^(?:next|next track|next song|skip|skip it|skip this|skip this song|skip this track)(?: on spotify)?$/,
      'media.next',
      'Play the next track'
    ],
    [
      /^(?:previous|previous track|previous song|last track|go back)(?: on spotify)?$/,
      'media.previous',
      'Play the previous track'
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

function normalizeMediaQuery(value: string): string | null {
  const query = value
    .trim()
    .replace(/^a\s+/i, '')
    .replace(/\s+song$/i, '')
    .trim()
  if (!query || query.length > 200 || /^(?:it|that|this|music|something)$/i.test(query)) return null
  return query
}

export function routeContextualCommand(
  message: string,
  context: import('../../shared/types').AssistantSessionContext
): ActionPlan | null {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
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
  const spotifyQuery = normalizeMediaQuery(directSpotify?.[1] ?? contextualSpotify?.[1] ?? '')
  const youtubeQuery = normalizeMediaQuery(directYouTube?.[1] ?? contextualYouTube?.[1] ?? '')

  if (spotifyQuery) {
    return actionPlan('Play the top matching Spotify track', 'spotify.playSearch', {
      query: spotifyQuery
    })
  }

  if (youtubeQuery) {
    return actionPlan('Open matching music on YouTube', 'youtube.playSearch', {
      query: youtubeQuery
    })
  }

  const preferredQuery = normalizeMediaQuery(normalized.match(/^play\s+(.+)$/i)?.[1] ?? '')
  if (preferredQuery) {
    return actionPlan('Play music using the preferred provider', 'music.playSearch', {
      query: preferredQuery
    })
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
    /^(?:(?:on|in) )?(?:the )?(?:youtube|browser|web|chrome|default browser)$/.test(
      destination
    )
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
