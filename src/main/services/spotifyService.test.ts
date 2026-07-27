import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundTarget } from '../security/protectedTargets'
import { playSpotifyTopResult, type SpotifyPlaybackController } from './spotifyService'

const safeSpotifyTarget: ForegroundTarget = {
  windowHandle: 42,
  title: 'Spotify Premium',
  className: 'Chrome_WidgetWin_0',
  processName: 'Spotify.exe',
  focusedClassName: 'Chrome_RenderWidgetHostHWND',
  isPasswordField: false
}

const controller: SpotifyPlaybackController = {
  findWindow: vi.fn(() => 42),
  getForegroundTarget: vi.fn(() => safeSpotifyTarget),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  chooseSpotifyTopResult: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

const immediateDelay = vi.fn(async () => undefined)

describe('Spotify playback service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(controller.findWindow).mockReturnValue(42)
    vi.mocked(controller.getForegroundTarget).mockReturnValue(safeSpotifyTarget)
    vi.mocked(controller.show).mockReturnValue(true)
    vi.mocked(controller.activate).mockReturnValue(true)
    vi.mocked(controller.focusSpotifySearch).mockReturnValue(true)
    vi.mocked(controller.typeUnicodeText).mockReturnValue(true)
    vi.mocked(controller.chooseSpotifyTopResult).mockReturnValue(true)
    vi.mocked(controller.pressEnter).mockReturnValue(true)
  })

  it('uses the fixed Spotify search sequence and reports only verified playback', async () => {
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({ ...safeSpotifyTarget, title: 'Locked Out of Heaven ? Bruno Mars' })

    await expect(
      playSpotifyTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: immediateDelay
      })
    ).resolves.toEqual({
      ok: true,
      message: 'Playing the top Spotify result for Bruno Mars.',
      data: { application: 'spotify', query: 'Bruno Mars' }
    })

    expect(controller.focusSpotifySearch).toHaveBeenCalledOnce()
    expect(controller.typeUnicodeText).toHaveBeenCalledWith('Bruno Mars')
    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledOnce()
    expect(controller.pressEnter).toHaveBeenCalledOnce()
  })

  it('leaves search visible when playback cannot be confirmed', async () => {
    await expect(
      playSpotifyTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: immediateDelay
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_PLAYBACK_NOT_CONFIRMED',
      message: 'I found Bruno Mars on Spotify, but I could not confirm playback.'
    })
  })

  it('stops if the foreground target changes before selection', async () => {
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({ ...safeSpotifyTarget, processName: 'powershell.exe' })

    await expect(
      playSpotifyTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: immediateDelay
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TARGET_CHANGED' })
    expect(controller.chooseSpotifyTopResult).not.toHaveBeenCalled()
  })
})
