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

  const blockedIntents: ReadonlyArray<[RegExp, string, string]> = [
    [/^delete\s+.+$/, 'filesystem.delete', 'Delete files or folders'],
    [/^move\s+.+$/, 'filesystem.move', 'Move files or folders'],
    [/^rename\s+.+$/, 'filesystem.rename', 'Rename files or folders'],
    [/^download\s+.+$/, 'browser.download', 'Download a file'],
    [/^upload\s+.+$/, 'browser.upload', 'Upload a file'],
    [/^extract\s+.+$/, 'archive.extract', 'Extract an archive'],
    [/^open powershell(?:\s+and\s+.+)?$/, 'powershell.execute', 'Run PowerShell'],
    [/^install\s+.+$/, 'software.install', 'Install software'],
    [/^save\s+.+$/, 'filesystem.write', 'Save or modify a file']
  ]

  for (const [pattern, capability, summary] of blockedIntents) {
    if (pattern.test(lower)) return actionPlan(summary, capability)
  }

  if (/^stop speaking$/.test(lower)) {
    return actionPlan('Stop speaking', 'assistant.stopSpeaking')
  }

  if (/^disable (?:titan|t\.i\.t\.a\.n)$/.test(lower)) {
    return actionPlan('Disable T.I.T.A.N.', 'assistant.disable')
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
    [/^(?:next|next track|skip)(?: song| track)?$/, 'media.next', 'Play the next track'],
    [/^(?:previous|previous track|last track)$/, 'media.previous', 'Play the previous track'],
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
