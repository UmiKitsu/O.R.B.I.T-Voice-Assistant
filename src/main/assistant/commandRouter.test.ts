import { describe, expect, it } from 'vitest'
import {
  extractAmbiguousMediaQuery,
  isClarificationCancellation,
  isConversationResetCommand,
  routeCommand,
  routeDeterministicCommand,
  routeMediaDestinationResponse
} from './commandRouter'
import { executeDeterministicAction } from './deterministicActionExecutor'

describe('routeDeterministicCommand', () => {
  it.each([
    ['Stop speaking.', 'Stop speaking', 'assistant.stopSpeaking', {}],
    ['Disable Orbit.', 'Disable Orbit', 'assistant.disable', {}],
    ['What time is it?', 'Read the local system time', 'system.getTime', {}],
    ["What is today's date?", 'Read the local system date', 'system.getDate', {}],
    ['Play.', 'Play or pause media', 'media.playPause', {}],
    ['Pause.', 'Play or pause media', 'media.playPause', {}],
    ['Mute.', 'Send the audio mute key', 'audio.mute', {}],
    ['Unmute.', 'Send the audio mute key', 'audio.unmute', {}],
    ['Volume up.', 'Raise the volume', 'audio.volumeUp', {}],
    ['Volume down.', 'Lower the volume', 'audio.volumeDown', {}],
    ['Skip it.', 'Send the next-track command', 'media.next', {}],
    [
      'Skip this song on Spotify.',
      'Play the next Spotify track and read its state',
      'media.nextTrack',
      { sourceApplication: 'spotify' }
    ],
    ['Next song.', 'Send the next-track command', 'media.next', {}],
    ['Play the next track.', 'Send the next-track command', 'media.next', {}],
    [
      'Go to the next song on Spotify.',
      'Play the next Spotify track and read its state',
      'media.nextTrack',
      { sourceApplication: 'spotify' }
    ],
    [
      'Go back on Spotify.',
      'Play the previous Spotify track and read its state',
      'media.previousTrack',
      { sourceApplication: 'spotify' }
    ],
    ['Previous song.', 'Send the previous-track command', 'media.previous', {}],
    ['Play the previous track.', 'Send the previous-track command', 'media.previous', {}],
    ['Go back one song.', 'Send the previous-track command', 'media.previous', {}],
    [
      'Go back to the last track on Spotify.',
      'Play the previous Spotify track and read its state',
      'media.previousTrack',
      { sourceApplication: 'spotify' }
    ],
    ['Open YouTube.', 'Open YouTube', 'browser.openUrl', { url: 'https://www.youtube.com' }],
    [
      'Open Calculator.',
      'Open a registered application',
      'application.launch',
      { application: 'Calculator' }
    ],
    [
      'Open File Explorer.',
      'Open a registered application',
      'application.launch',
      { application: 'File Explorer' }
    ],
    [
      'Search the web for Electron security.',
      'Search the web',
      'browser.searchWeb',
      { query: 'Electron security' }
    ],
    [
      'Search YouTube for TypeScript tutorials.',
      'Search YouTube',
      'browser.searchYouTube',
      { query: 'TypeScript tutorials' }
    ],
    ['Pause the YouTube video.', 'Pause the YouTube video', 'youtube.pause', {}],
    ['Resume the YouTube video.', 'Resume the YouTube video', 'youtube.play', {}],
    ['Skip the YouTube video.', 'Play the next YouTube video', 'youtube.next', {}],
    ['Previous YouTube video.', 'Play the previous YouTube video', 'youtube.previous', {}],
    ['Skip forward thirty seconds.', 'Seek the YouTube video', 'youtube.seekBy', { seconds: 30 }],
    ['Skip backward 15 seconds.', 'Seek the YouTube video', 'youtube.seekBy', { seconds: -15 }],
    [
      'Set the video volume to fifty percent.',
      'Set the YouTube volume to 50 percent',
      'youtube.setVolume',
      { volume: 50 }
    ],
    ['Make the video fullscreen.', 'Make the YouTube video fullscreen', 'youtube.fullscreen', {}],
    ['Open a new browser tab.', 'Open a new controlled browser tab', 'browser.newTab', {}],
    ['Close the browser tab.', 'Close the controlled browser tab', 'browser.closeTab', {}],
    ['Go back in the browser.', 'Go back in the controlled browser tab', 'browser.goBack', {}],
    [
      'Scroll down.',
      'Scroll the controlled browser tab',
      'browser.scroll',
      { direction: 'down', amount: 700 }
    ]
  ])('routes %s to a normal action plan', (message, summary, capability, parameters) => {
    expect(routeDeterministicCommand(message)).toEqual({
      kind: 'action_plan',
      summary,
      actions: [{ capability, parameters }]
    })
  })

  it('returns null for conversation and unsupported actions', () => {
    expect(routeDeterministicCommand('Explain Electron security.')).toBeNull()
    expect(routeDeterministicCommand('Disable Titan.')).toBeNull()
  })

  it.each([
    ['Stop speaking.', 'Speech stopped.', 'stop-speaking'],
    ['Disable Orbit.', 'Orbit disabled.', 'disable']
  ])('executes %s through a registered policy capability', async (message, response, effect) => {
    await expect(executeDeterministicAction(message)).resolves.toEqual({
      ok: true,
      message: response,
      data: {
        response,
        effects: [effect]
      }
    })
  })
})

describe('voice-only session controls', () => {
  it.each(['Clear conversation', 'clear the conversation.'])(
    'recognizes %s as a conversation reset',
    (message) => {
      expect(isConversationResetCommand(message)).toBe(true)
    }
  )

  it('does not treat an unrelated clear request as a conversation reset', () => {
    expect(isConversationResetCommand('clear the screen')).toBe(false)
  })
})

describe('context-aware routing', () => {
  it('routes a Spotify follow-up from the last successful application', () => {
    expect(routeCommand('play a Bruno Mars song', { lastApplication: 'spotify' })).toEqual({
      kind: 'action_plan',
      summary: 'Play the top matching Spotify track',
      actions: [
        {
          capability: 'spotify.playSearch',
          parameters: { query: 'Bruno Mars', intent: 'artist' }
        }
      ]
    })
  })

  it.each([
    'play Bruno Mars on Spotify',
    'Play Bruno Mars in Spotify',
    'PLAY Bruno Mars ON SPOTIFY.',
    'play Bruno Mars in spotify!'
  ])('routes %s directly to Spotify without an inferred intent', (message) => {
    expect(routeCommand(message)).toMatchObject({
      actions: [{ capability: 'spotify.playSearch', parameters: { query: 'Bruno Mars' } }]
    })
  })

  it('keeps a specific Spotify track query complete', () => {
    expect(routeCommand('play Locked Out of Heaven on Spotify')).toMatchObject({
      actions: [{ capability: 'spotify.playSearch', parameters: { query: 'Locked Out of Heaven' } }]
    })
  })

  it.each([
    'play Bruno Mars song in Spotify',
    'play Bruno Mars songs in Spotify',
    'play a Bruno Mars song in Spotify',
    'play some Bruno Mars songs on Spotify',
    'play any Bruno Mars song on Spotify',
    'play any song by Bruno Mars on Spotify',
    'play a song of Bruno Mars in Spotify',
    'play some songs from Bruno Mars on Spotify',
    'play music from Bruno Mars in Spotify'
  ])('routes %s directly as a clean artist request', (message) => {
    expect(routeCommand(message)).toMatchObject({
      actions: [
        {
          capability: 'spotify.playSearch',
          parameters: { query: 'Bruno Mars', intent: 'artist' }
        }
      ]
    })
  })

  it('marks explicit artist phrases without calling the classifier', () => {
    expect(routeCommand('play music by Bruno Mars')).toMatchObject({
      actions: [
        {
          capability: 'music.playSearch',
          parameters: { query: 'Bruno Mars', intent: 'artist' }
        }
      ]
    })
  })

  it.each([
    ['Play Bruno Mars', 'Bruno Mars'],
    ['Play Locked Out of Heaven', 'Locked Out of Heaven']
  ])('routes %s to the preferred provider without classification', (message, query) => {
    expect(routeCommand(message)).toMatchObject({
      actions: [{ capability: 'music.playSearch', parameters: { query } }]
    })
  })

  it('resolves safe application pronouns from canonical context', () => {
    expect(routeCommand('maximize it', { lastApplication: 'spotify' })).toMatchObject({
      actions: [{ capability: 'application.maximize', parameters: { application: 'spotify' } }]
    })
    expect(routeCommand('close it', { lastApplication: 'chrome' })).toMatchObject({
      actions: [{ capability: 'application.closeSafe', parameters: { application: 'chrome' } }]
    })
  })

  it.each([
    'play a Bruno Mars song',
    'play any song by Bruno Mars',
    'play one song of Bruno Mars',
    'play some songs from Bruno Mars',
    'play Bruno Mars music'
  ])('routes %s to the preferred provider with a clean artist intent', (message) => {
    expect(routeCommand(message)).toEqual({
      kind: 'action_plan',
      summary: 'Play music using the preferred provider',
      actions: [
        {
          capability: 'music.playSearch',
          parameters: { query: 'Bruno Mars', intent: 'artist' }
        }
      ]
    })
  })

  it('routes an explicit YouTube playback request without Spotify context', () => {
    expect(routeCommand('play Locked Out of Heaven on YouTube')).toEqual({
      kind: 'action_plan',
      summary: 'Open matching music on YouTube',
      actions: [{ capability: 'youtube.playSearch', parameters: { query: 'Locked Out of Heaven' } }]
    })
  })

  it('routes the requested YouTube tutorial phrase and playback follow-ups', () => {
    expect(routeCommand('Play Minecraft tutorials on YouTube.')).toMatchObject({
      actions: [{ capability: 'youtube.playSearch', parameters: { query: 'Minecraft tutorials' } }]
    })
    expect(
      routeCommand('pause it', {
        lastMediaApplication: 'youtube',
        confirmedYouTubePlayback: true
      })
    ).toMatchObject({
      actions: [{ capability: 'youtube.pause', parameters: {} }]
    })
    expect(
      routeCommand('resume it', {
        lastMediaApplication: 'youtube',
        confirmedYouTubePlayback: true
      })
    ).toMatchObject({
      actions: [{ capability: 'youtube.play', parameters: {} }]
    })
    expect(
      routeCommand('skip it', {
        lastMediaApplication: 'youtube',
        confirmedYouTubePlayback: true
      })
    ).toMatchObject({
      actions: [{ capability: 'youtube.next', parameters: {} }]
    })
    expect(
      routeCommand('previous', {
        lastMediaApplication: 'youtube',
        confirmedYouTubePlayback: true
      })
    ).toMatchObject({
      actions: [{ capability: 'youtube.previous', parameters: {} }]
    })
    expect(routeCommand('skip it', { lastMediaApplication: 'spotify' })).toMatchObject({
      actions: [{ capability: 'media.nextTrack', parameters: { sourceApplication: 'spotify' } }]
    })
    expect(
      routeCommand('skip it', {
        lastMediaApplication: 'youtube',
        confirmedYouTubePlayback: false
      })
    ).toMatchObject({
      actions: [{ capability: 'media.next', parameters: {} }]
    })
  })

  it('extracts an ambiguous playback query only when no media destination is known', () => {
    expect(extractAmbiguousMediaQuery('play a Bruno Mars song')).toBe('Bruno Mars')
    expect(
      extractAmbiguousMediaQuery('play a Bruno Mars song', { lastMediaApplication: 'spotify' })
    ).toBeNull()
    expect(extractAmbiguousMediaQuery('play it')).toBeNull()
    expect(routeCommand('play it')).toBeNull()
    expect(routeCommand('play it', { lastMediaApplication: 'spotify' })).toMatchObject({
      actions: [{ capability: 'media.play', parameters: { sourceApplication: 'spotify' } }]
    })
  })

  it('routes a clarified Spotify destination', () => {
    expect(routeMediaDestinationResponse('Spotify', 'Bruno Mars')).toEqual({
      kind: 'action_plan',
      summary: 'Play the top matching Spotify track',
      actions: [{ capability: 'spotify.playSearch', parameters: { query: 'Bruno Mars' } }]
    })
  })

  it('routes a clarified browser destination to YouTube music search', () => {
    expect(routeMediaDestinationResponse('in the browser', 'Locked Out of Heaven')).toEqual({
      kind: 'action_plan',
      summary: 'Open matching music on YouTube',
      actions: [
        {
          capability: 'youtube.playSearch',
          parameters: { query: 'Locked Out of Heaven' }
        }
      ]
    })
  })

  it('recognizes cancellation while waiting for a destination', () => {
    expect(isClarificationCancellation('never mind')).toBe(true)
    expect(isClarificationCancellation('No.')).toBe(true)
    expect(isClarificationCancellation('Spotify')).toBe(false)
  })
})
