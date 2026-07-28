import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from './capabilityRegistry'
import { registerDesktopCapabilities } from './desktopCapabilities'
import { registerDesktopVisionCapabilities } from './desktopVisionCapabilities'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitTest'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  },
  desktopCapturer: { getSources: vi.fn(async () => []) }
}))

describe('desktop capability boundary', () => {
  it('registers typed UI Automation and visual capabilities with the intended risks', () => {
    const registry = new CapabilityRegistry()
    registerDesktopCapabilities(registry)
    registerDesktopVisionCapabilities(registry)

    expect(registry.get('desktop.inspectActiveWindow')?.risk).toBe('automatic')
    expect(registry.get('desktop.invoke')?.risk).toBe('automatic')
    expect(registry.get('desktop.invokeConsequential')?.risk).toBe('confirmation-required')
    expect(registry.get('desktop.toggleConsequential')?.risk).toBe('confirmation-required')
    expect(registry.get('desktop.selectConsequential')?.risk).toBe('confirmation-required')
    expect(registry.get('desktop.inspectVisually')?.risk).toBe('automatic')
    expect(registry.get('desktop.visualClick')?.risk).toBe('confirmation-required')
  })

  it('accepts only opaque refs and rejects model-provided coordinates or runtime IDs', () => {
    const registry = new CapabilityRegistry()
    registerDesktopCapabilities(registry)
    registerDesktopVisionCapabilities(registry)
    const ref = '2640bb80-7821-42a8-b55d-12964e86ad6a'

    expect(
      registry.get('desktop.invoke')?.parameterSchema.safeParse({ elementRef: ref }).success
    ).toBe(true)
    expect(
      registry
        .get('desktop.invoke')
        ?.parameterSchema.safeParse({ elementRef: ref, runtimeId: [42, 1] }).success
    ).toBe(false)
    expect(
      registry
        .get('desktop.visualClick')
        ?.parameterSchema.safeParse({ visualRef: ref, x: 100, y: 200 }).success
    ).toBe(false)
    expect(
      registry.get('desktop.visualClick')?.parameterSchema.safeParse({ visualRef: ref }).success
    ).toBe(true)
  })
})
