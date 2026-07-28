import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundTarget } from '../security/protectedTargets'
import {
  inspectActiveDesktopWindow,
  performDesktopElementAction,
  resetDesktopAutomationForTests
} from './desktopAutomationService'
import { DEFAULT_ORBIT_SETTINGS, setSettingsStorageForTests } from './settingsService'
import type { WindowController } from './windowInputService'
import type { runFixedWindowsOperation } from './windowsFixedOperationRunner'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitTest'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  }
}))

function enableScreenAwareness(): void {
  const storage = {
    store: { ...DEFAULT_ORBIT_SETTINGS, screenAwarenessEnabled: true },
    set(settings) {
      this.store = settings
    }
  }
  setSettingsStorageForTests(storage)
}

function target(windowHandle = 101): ForegroundTarget {
  return {
    windowHandle,
    title: 'Calculator',
    className: 'ApplicationFrameWindow',
    processName: 'CalculatorApp.exe',
    focusedClassName: 'Button',
    isPasswordField: false
  }
}

function controller(active: { value: ForegroundTarget }): WindowController {
  return {
    findWindow: vi.fn(() => active.value.windowHandle),
    getForegroundTarget: vi.fn(() => active.value),
    getWindowBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
    getProcessAgeMs: vi.fn(() => 10_000),
    activate: vi.fn(() => true),
    show: vi.fn(() => true),
    move: vi.fn(() => true),
    requestClose: vi.fn(() => true),
    typeUnicodeText: vi.fn(() => true),
    pressEnter: vi.fn(() => true),
    focusSpotifySearch: vi.fn(() => true),
    selectAllText: vi.fn(() => true),
    pressTab: vi.fn(() => true),
    clickScreenPoint: vi.fn(() => true)
  }
}

function rawElement(
  name = 'Open',
  pattern: 'invoke' | 'toggle' | 'select' = 'invoke'
): Record<string, unknown> {
  return {
    runtimeId: [42, 101, 7],
    role: 'Button',
    name,
    enabled: true,
    offscreen: false,
    isPassword: false,
    depth: 2,
    bounds: { x: 100, y: 120, width: 80, height: 32 },
    patterns: [pattern]
  }
}

afterEach(() => {
  resetDesktopAutomationForTests()
  setSettingsStorageForTests(undefined)
})

describe('desktop UI Automation references', () => {
  it('exposes opaque refs and resolves them to a fixed runtime ID only after foreground revalidation', async () => {
    enableScreenAwareness()
    const active = { value: target() }
    const windowController = controller(active)
    const runner = vi.fn(async (operationId: string, parameters: unknown) => {
      if (operationId === 'desktop.inspectActiveWindow') {
        return {
          ok: true as const,
          message: 'inspected',
          data: { windowHandle: 101, elements: [rawElement()], truncated: false }
        }
      }
      expect(parameters).toEqual({ windowHandle: 101, runtimeId: [42, 101, 7] })
      return {
        ok: true as const,
        message: 'invoked',
        data: { name: 'Open', role: 'Button', action: 'invoke' }
      }
    }) as unknown as typeof runFixedWindowsOperation

    const snapshot = await inspectActiveDesktopWindow(
      new AbortController().signal,
      windowController,
      runner
    )
    expect(snapshot).toMatchObject({
      ok: true,
      data: { windowTitle: 'Calculator', elements: [{ name: 'Open', role: 'Button' }] }
    })
    const ref = snapshot.ok ? snapshot.data?.elements[0]?.ref : undefined
    expect(ref).toMatch(/^[0-9a-f-]{36}$/u)
    expect(JSON.stringify(snapshot)).not.toContain('[42,101,7]')

    const result = await performDesktopElementAction(
      'invoke',
      { elementRef: ref ?? '' },
      new AbortController().signal,
      { controller: windowController, runner }
    )
    expect(result).toMatchObject({ ok: true, data: { action: 'invoke' } })
  })

  it('rejects a stale ref when the foreground window changes', async () => {
    enableScreenAwareness()
    const active = { value: target() }
    const windowController = controller(active)
    const runner = vi.fn(async () => ({
      ok: true as const,
      message: 'inspected',
      data: { windowHandle: 101, elements: [rawElement()], truncated: false }
    })) as unknown as typeof runFixedWindowsOperation
    const snapshot = await inspectActiveDesktopWindow(
      new AbortController().signal,
      windowController,
      runner
    )
    const ref = snapshot.ok ? (snapshot.data?.elements[0]?.ref ?? '') : ''
    active.value = target(202)

    await expect(
      performDesktopElementAction('invoke', { elementRef: ref }, new AbortController().signal, {
        controller: windowController,
        runner
      })
    ).resolves.toMatchObject({ ok: false, code: 'DESKTOP_WINDOW_CHANGED' })
  })

  it.each(['invoke', 'toggle', 'select'] as const)(
    'does not allow an automatic %s for a consequential control',
    async (action) => {
      enableScreenAwareness()
      const active = { value: target() }
      const windowController = controller(active)
      const runner = vi.fn(async () => ({
        ok: true as const,
        message: 'inspected',
        data: {
          windowHandle: 101,
          elements: [rawElement('Delete account', action)],
          truncated: false
        }
      })) as unknown as typeof runFixedWindowsOperation
      const snapshot = await inspectActiveDesktopWindow(
        new AbortController().signal,
        windowController,
        runner
      )
      const ref = snapshot.ok ? (snapshot.data?.elements[0]?.ref ?? '') : ''

      await expect(
        performDesktopElementAction(action, { elementRef: ref }, new AbortController().signal, {
          controller: windowController,
          runner
        })
      ).resolves.toMatchObject({ ok: false, code: 'DESKTOP_CONFIRMATION_REQUIRED' })
    }
  )
})
