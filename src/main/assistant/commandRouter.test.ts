import { describe, expect, it } from 'vitest'
import { routeDeterministicCommand } from './commandRouter'
import { executeDeterministicAction } from './deterministicActionExecutor'

describe('routeDeterministicCommand', () => {
  it.each([
    ['Stop speaking.', 'Stop speaking', 'assistant.stopSpeaking', {}],
    ['Disable Titan.', 'Disable T.I.T.A.N.', 'assistant.disable', {}],
    ['What time is it?', 'Read the local system time', 'system.getTime', {}],
    ["What is today's date?", 'Read the local system date', 'system.getDate', {}],
    ['Play.', 'Play or pause media', 'media.playPause', {}],
    ['Pause.', 'Play or pause media', 'media.playPause', {}],
    ['Mute.', 'Send the audio mute key', 'audio.mute', {}],
    ['Unmute.', 'Send the audio mute key', 'audio.unmute', {}],
    ['Volume up.', 'Raise the volume', 'audio.volumeUp', {}],
    ['Volume down.', 'Lower the volume', 'audio.volumeDown', {}],
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
    expect(routeDeterministicCommand('Delete my Downloads folder.')).toBeNull()
  })

  it.each([
    ['Stop speaking.', 'Speech stopped.', 'stop-speaking'],
    ['Disable Titan.', 'T.I.T.A.N. disabled.', 'disable']
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
