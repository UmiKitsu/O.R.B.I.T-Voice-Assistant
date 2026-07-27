import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundTarget } from '../security/protectedTargets'
import type { PolicyEngine, PolicyResult } from '../security/policyEngine'
import type { WindowController } from '../services/windowInputService'
import { createCapabilityRuntime } from './capabilityRuntime'

const safeTarget: ForegroundTarget = {
  windowHandle: 42,
  title: 'Chat with Alex',
  className: 'Chrome_WidgetWin_1',
  processName: 'chrome.exe',
  focusedClassName: 'Edit',
  isPasswordField: false
}

const controller: WindowController = {
  findWindow: vi.fn(() => 42),
  getForegroundTarget: vi.fn(() => safeTarget),
  getWindowBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
  activate: vi.fn(() => true),
  show: vi.fn(() => true),
  move: vi.fn(() => true),
  requestClose: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

function runtime(): PolicyEngine {
  return createCapabilityRuntime({ windowController: controller })
}

async function execute(capability: string, parameters: unknown): Promise<PolicyResult> {
  return runtime().evaluateAndExecute({ capability, parameters, summary: capability })
}

describe('Phase 15 window and input capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(controller.getForegroundTarget).mockReturnValue(safeTarget)
  })

  it.each([
    ['application.focus', 'activate'],
    ['application.minimize', 'show'],
    ['application.maximize', 'show'],
    ['application.restore', 'show'],
    ['application.closeSafe', 'requestClose']
  ] as const)(
    'executes registered %s through the typed window controller',
    async (name, method) => {
      await expect(execute(name, { application: 'Chrome' })).resolves.toMatchObject({
        status: 'executed',
        result: { ok: true }
      })
      expect(controller[method]).toHaveBeenCalled()
    }
  )

  it('moves and resizes while preserving unspecified bounds', async () => {
    await execute('window.move', { application: 'Chrome', x: -1200, y: 40 })
    expect(controller.move).toHaveBeenNthCalledWith(1, 42, {
      x: -1200,
      y: 40,
      width: 800,
      height: 600
    })

    await execute('window.resize', { application: 'Chrome', width: 1200, height: 700 })
    expect(controller.move).toHaveBeenNthCalledWith(2, 42, {
      x: 10,
      y: 20,
      width: 1200,
      height: 700
    })
  })

  it('accepts only plain text and rejects key arrays, scripts, and control keys', async () => {
    await expect(execute('keyboard.typeSafeText', { text: 'Hello, Alex.' })).resolves.toMatchObject(
      {
        status: 'executed',
        result: { ok: true }
      }
    )

    for (const parameters of [
      { keys: ['CTRL', 'ALT', 'DELETE'] },
      { script: 'sendKeys("^s")' },
      { text: 'save\u0000now' },
      { text: 'press enter\n' },
      { text: 'hello', keys: ['CTRL', 'S'] }
    ]) {
      await expect(execute('keyboard.typeSafeText', parameters)).resolves.toMatchObject({
        status: 'invalid-parameters'
      })
    }
    expect(controller.typeUnicodeText).toHaveBeenCalledTimes(1)
  })

  it('blocks all automated typing when the foreground target is protected', async () => {
    vi.mocked(controller.getForegroundTarget).mockReturnValue({
      ...safeTarget,
      title: 'Windows PowerShell',
      processName: 'powershell.exe'
    })

    await expect(
      execute('keyboard.typeSafeText', { text: 'harmless-looking text' })
    ).resolves.toMatchObject({
      status: 'executed',
      result: { ok: false, code: 'PROTECTED_TARGET' }
    })
    expect(controller.typeUnicodeText).not.toHaveBeenCalled()
  })

  it('requires an exact confirmation before typing and sending a message', async () => {
    const engine = runtime()
    const request = {
      capability: 'communication.sendMessage',
      parameters: { recipient: 'Alex', text: 'I will be there at 5 PM' },
      summary: 'model-controlled summary is ignored'
    }

    const pending = await engine.evaluateAndExecute(request)
    expect(pending).toMatchObject({
      status: 'confirmation-required',
      confirmation: {
        summary: 'This will send “I will be there at 5 PM” to Alex. Do you want to continue?'
      }
    })
    expect(controller.typeUnicodeText).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
    if (pending.status !== 'confirmation-required') throw new Error('Expected confirmation.')

    expect(engine.approveConfirmation(pending.confirmation.requestId)).toBe(true)
    await expect(
      engine.evaluateAndExecute({
        ...request,
        confirmationRequestId: pending.confirmation.requestId
      })
    ).resolves.toMatchObject({ status: 'executed', result: { ok: true } })
    expect(controller.typeUnicodeText).toHaveBeenCalledWith('I will be there at 5 PM')
    expect(controller.pressEnter).toHaveBeenCalledOnce()
  })

  it('does not send when focus changes after message text is typed', async () => {
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeTarget)
      .mockReturnValueOnce({ ...safeTarget, windowHandle: 99, title: 'Different window' })
    const engine = runtime()
    const request = {
      capability: 'communication.sendMessage',
      parameters: { recipient: 'Alex', text: 'Hello' },
      summary: 'Send a message'
    }
    const pending = await engine.evaluateAndExecute(request)
    if (pending.status !== 'confirmation-required') throw new Error('Expected confirmation.')
    engine.approveConfirmation(pending.confirmation.requestId)

    await expect(
      engine.evaluateAndExecute({
        ...request,
        confirmationRequestId: pending.confirmation.requestId
      })
    ).resolves.toMatchObject({
      status: 'executed',
      result: { ok: false, code: 'TARGET_CHANGED' }
    })
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })
})
