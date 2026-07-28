import { describe, expect, it, vi } from 'vitest'
import { sourceMatchesWindow } from './foregroundWindowCaptureService'

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) }
}))

describe('foreground window source matching', () => {
  it('prefers the exact Windows handle encoded by Electron', () => {
    expect(
      sourceMatchesWindow(
        { id: 'window:393794:0', name: 'Duplicate title' } as never,
        393794,
        'Other'
      )
    ).toBe(true)
    expect(
      sourceMatchesWindow({ id: 'window:999:0', name: 'Other' } as never, 393794, 'Other')
    ).toBe(true)
    expect(
      sourceMatchesWindow({ id: 'window:999:0', name: 'Wrong' } as never, 393794, 'Other')
    ).toBe(false)
  })
})
