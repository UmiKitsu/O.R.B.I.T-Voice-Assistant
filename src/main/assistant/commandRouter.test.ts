import { describe, expect, it } from 'vitest'
import { routeDeterministicCommand } from './commandRouter'

describe('routeDeterministicCommand', () => {
  it.each([
    ['Tell me the time.', 'system.getTime', {}],
    ['Tell me the date.', 'system.getDate', {}],
    ['Open YouTube.', 'browser.openUrl', { url: 'https://www.youtube.com/' }],
    ['Search the web for Electron security.', 'browser.searchWeb', { query: 'Electron security' }],
    [
      'Search YouTube for TypeScript tutorials.',
      'browser.searchYouTube',
      { query: 'TypeScript tutorials' }
    ],
    ['Open Calculator.', 'application.launch', { application: 'Calculator' }],
    ['Open File Explorer.', 'application.launch', { application: 'File Explorer' }],
    ['Play or pause.', 'media.playPause', {}],
    ['Volume down.', 'audio.volumeDown', {}]
  ])('routes %s without asking the model', (message, capability, parameters) => {
    expect(routeDeterministicCommand(message)).toMatchObject({ capability, parameters })
  })

  it('returns null for conversation and unsupported actions', () => {
    expect(routeDeterministicCommand('Explain Electron security.')).toBeNull()
    expect(routeDeterministicCommand('Delete my Downloads folder.')).toBeNull()
  })
})
