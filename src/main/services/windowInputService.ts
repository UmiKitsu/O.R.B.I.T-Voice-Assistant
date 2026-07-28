import * as koffi from 'koffi'
import type { ActionResult } from '../../shared/types'
import {
  detectProtectedTarget,
  type ForegroundTarget,
  type ProtectedTargetDecision
} from '../security/protectedTargets'

export type WindowBounds = { x: number; y: number; width: number; height: number }
export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore' | 'closeSafe'

export type WindowController = {
  findWindow(application: string): number | null
  getForegroundTarget(): ForegroundTarget | null
  getWindowBounds(windowHandle: number): WindowBounds | null
  getProcessAgeMs(windowHandle: number): number | null
  activate(windowHandle: number): boolean
  show(windowHandle: number, command: 'minimize' | 'maximize' | 'restore'): boolean
  move(windowHandle: number, bounds: WindowBounds): boolean
  requestClose(windowHandle: number): boolean
  typeUnicodeText(text: string): boolean
  pressEnter(): boolean
  focusSpotifySearch(): boolean
  selectAllText(): boolean
  pressTab(): boolean
}

type NativeFunctions = {
  enumWindows: (callback: unknown, parameter: number) => boolean
  isWindowVisible: (windowHandle: number) => boolean
  getWindowText: (windowHandle: number, buffer: Buffer, length: number) => number
  getClassName: (windowHandle: number, buffer: Buffer, length: number) => number
  getForegroundWindow: () => number
  getWindowThreadProcessId: (windowHandle: number, processId: Uint32Array) => number
  getGuiThreadInfo: (threadId: number, info: Record<string, unknown>) => boolean
  sendMessage: (windowHandle: number, message: number, wParam: number, lParam: number) => number
  showWindow: (windowHandle: number, command: number) => boolean
  setForegroundWindow: (windowHandle: number) => boolean
  getWindowRect: (windowHandle: number, rect: Record<string, number>) => boolean
  moveWindow: (
    windowHandle: number,
    x: number,
    y: number,
    width: number,
    height: number,
    repaint: boolean
  ) => boolean
  postMessage: (windowHandle: number, message: number, wParam: number, lParam: number) => boolean
  sendInput: (count: number, inputs: KeyboardInputEvent[], inputSize: number) => number
  openProcess: (access: number, inheritHandle: boolean, processId: number) => number
  queryProcessImageName: (
    process: number,
    flags: number,
    buffer: Buffer,
    size: Uint32Array
  ) => boolean
  closeHandle: (handle: number) => boolean
  getProcessTimes: (
    process: number,
    creationTime: Record<string, number>,
    exitTime: Record<string, number>,
    kernelTime: Record<string, number>,
    userTime: Record<string, number>
  ) => boolean
  inputSize: number
  enumWindowsCallback: unknown
}

type KeyboardInputEvent = {
  type: number
  u: {
    ki: {
      wVk: number
      wScan: number
      dwFlags: number
      time: number
      dwExtraInfo: number
    }
  }
}

let nativeFunctions: NativeFunctions | undefined
let enumeratedWindows: number[] | undefined

function readWideString(
  reader: (windowHandle: number, buffer: Buffer, length: number) => number,
  windowHandle: number
): string {
  const buffer = Buffer.alloc(1_024)
  const length = reader(windowHandle, buffer, 512)
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : ''
}
function readProcessName(native: NativeFunctions, processId: number): string {
  const processHandle = native.openProcess(0x1000, false, processId)
  if (!processHandle) return ''
  try {
    const buffer = Buffer.alloc(1_024)
    const size = new Uint32Array([512])
    if (!native.queryProcessImageName(processHandle, 0, buffer, size)) return ''
    const executablePath = buffer.toString('utf16le', 0, size[0] * 2)
    return executablePath.split(/[\\/]/u).at(-1) ?? ''
  } finally {
    native.closeHandle(processHandle)
  }
}

function loadNativeFunctions(): NativeFunctions {
  if (process.platform !== 'win32') {
    throw new Error('Window and input control is available only on Windows.')
  }
  if (nativeFunctions) return nativeFunctions

  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const rectType = koffi.struct('ORBIT_RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long'
  })
  koffi.struct('ORBIT_FILETIME', {
    dwLowDateTime: 'uint32_t',
    dwHighDateTime: 'uint32_t'
  })
  koffi.struct('ORBIT_GUITHREADINFO', {
    cbSize: 'uint32_t',
    flags: 'uint32_t',
    hwndActive: 'uintptr_t',
    hwndFocus: 'uintptr_t',
    hwndCapture: 'uintptr_t',
    hwndMenuOwner: 'uintptr_t',
    hwndMoveSize: 'uintptr_t',
    hwndCaret: 'uintptr_t',
    rcCaret: rectType
  })
  const mouseInput = koffi.struct('ORBIT_WINDOW_MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const keyboardInput = koffi.struct('ORBIT_WINDOW_KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const hardwareInput = koffi.struct('ORBIT_WINDOW_HARDWAREINPUT', {
    uMsg: 'uint32_t',
    wParamL: 'uint16_t',
    wParamH: 'uint16_t'
  })
  const input = koffi.struct('ORBIT_WINDOW_INPUT', {
    type: 'uint32_t',
    u: koffi.union({ mi: mouseInput, ki: keyboardInput, hi: hardwareInput })
  })
  const callbackPrototype = koffi.proto(
    'bool __stdcall ORBIT_ENUMWINDOWSPROC(uintptr_t windowHandle, intptr_t parameter)'
  )
  const enumWindowsCallback = koffi.register((windowHandle: number) => {
    enumeratedWindows?.push(windowHandle)
    return true
  }, koffi.pointer(callbackPrototype))

  nativeFunctions = {
    openProcess: kernel32.func(
      'uintptr_t __stdcall OpenProcess(uint32_t access, bool inheritHandle, uint32_t processId)'
    ) as NativeFunctions['openProcess'],
    queryProcessImageName: kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, void *buffer, uint32_t *size)'
    ) as NativeFunctions['queryProcessImageName'],
    closeHandle: kernel32.func(
      'bool __stdcall CloseHandle(uintptr_t handle)'
    ) as NativeFunctions['closeHandle'],
    getProcessTimes: kernel32.func(
      'bool __stdcall GetProcessTimes(uintptr_t process, _Out_ ORBIT_FILETIME *creationTime, _Out_ ORBIT_FILETIME *exitTime, _Out_ ORBIT_FILETIME *kernelTime, _Out_ ORBIT_FILETIME *userTime)'
    ) as NativeFunctions['getProcessTimes'],
    enumWindows: user32.func(
      'bool __stdcall EnumWindows(ORBIT_ENUMWINDOWSPROC *callback, intptr_t parameter)'
    ) as NativeFunctions['enumWindows'],
    isWindowVisible: user32.func(
      'bool __stdcall IsWindowVisible(uintptr_t windowHandle)'
    ) as NativeFunctions['isWindowVisible'],
    getWindowText: user32.func(
      'int __stdcall GetWindowTextW(uintptr_t windowHandle, void *buffer, int length)'
    ) as NativeFunctions['getWindowText'],
    getClassName: user32.func(
      'int __stdcall GetClassNameW(uintptr_t windowHandle, void *buffer, int length)'
    ) as NativeFunctions['getClassName'],
    getForegroundWindow: user32.func(
      'uintptr_t __stdcall GetForegroundWindow()'
    ) as NativeFunctions['getForegroundWindow'],
    getWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(uintptr_t windowHandle, uint32_t *processId)'
    ) as NativeFunctions['getWindowThreadProcessId'],
    getGuiThreadInfo: user32.func(
      'bool __stdcall GetGUIThreadInfo(uint32_t threadId, _Inout_ ORBIT_GUITHREADINFO *info)'
    ) as NativeFunctions['getGuiThreadInfo'],
    sendMessage: user32.func(
      'intptr_t __stdcall SendMessageW(uintptr_t windowHandle, uint32_t message, uintptr_t wParam, intptr_t lParam)'
    ) as NativeFunctions['sendMessage'],
    showWindow: user32.func(
      'bool __stdcall ShowWindow(uintptr_t windowHandle, int command)'
    ) as NativeFunctions['showWindow'],
    setForegroundWindow: user32.func(
      'bool __stdcall SetForegroundWindow(uintptr_t windowHandle)'
    ) as NativeFunctions['setForegroundWindow'],
    getWindowRect: user32.func(
      'bool __stdcall GetWindowRect(uintptr_t windowHandle, _Out_ ORBIT_RECT *rect)'
    ) as NativeFunctions['getWindowRect'],
    moveWindow: user32.func(
      'bool __stdcall MoveWindow(uintptr_t windowHandle, int x, int y, int width, int height, bool repaint)'
    ) as NativeFunctions['moveWindow'],
    postMessage: user32.func(
      'bool __stdcall PostMessageW(uintptr_t windowHandle, uint32_t message, uintptr_t wParam, intptr_t lParam)'
    ) as NativeFunctions['postMessage'],
    sendInput: user32.func(
      'unsigned int __stdcall SendInput(unsigned int count, ORBIT_WINDOW_INPUT *inputs, int inputSize)'
    ) as NativeFunctions['sendInput'],
    inputSize: koffi.sizeof(input),
    enumWindowsCallback
  }
  return nativeFunctions
}

function inputEvent(scanCode: number, keyUp: boolean, unicode = true): KeyboardInputEvent {
  return {
    type: 1,
    u: {
      ki: {
        wVk: unicode ? 0 : scanCode,
        wScan: unicode ? scanCode : 0,
        dwFlags: (unicode ? 0x4 : 0) | (keyUp ? 0x2 : 0),
        time: 0,
        dwExtraInfo: 0
      }
    }
  }
}

export const windowsController: WindowController = {
  findWindow(application) {
    const native = loadNativeFunctions()
    const requested = application.trim().toLocaleLowerCase()
    if (!requested) return null
    enumeratedWindows = []
    try {
      native.enumWindows(native.enumWindowsCallback, 0)
      return (
        enumeratedWindows.find((windowHandle) => {
          if (!native.isWindowVisible(windowHandle)) return false
          const title = readWideString(native.getWindowText, windowHandle).toLocaleLowerCase()
          const processId = new Uint32Array(1)
          native.getWindowThreadProcessId(windowHandle, processId)
          const processName = readProcessName(native, processId[0])
            .replace(/\.exe$/i, '')
            .toLocaleLowerCase()
          return title.includes(requested) || processName === requested
        }) ?? null
      )
    } finally {
      enumeratedWindows = undefined
    }
  },

  getForegroundTarget() {
    const native = loadNativeFunctions()
    const windowHandle = native.getForegroundWindow()
    if (!windowHandle) return null
    const processId = new Uint32Array(1)
    const threadId = native.getWindowThreadProcessId(windowHandle, processId)
    const guiInfo: Record<string, unknown> = {
      cbSize: 72,
      flags: 0,
      hwndActive: 0,
      hwndFocus: 0,
      hwndCapture: 0,
      hwndMenuOwner: 0,
      hwndMoveSize: 0,
      hwndCaret: 0,
      rcCaret: { left: 0, top: 0, right: 0, bottom: 0 }
    }
    const hasGuiInfo = native.getGuiThreadInfo(threadId, guiInfo)
    const focusedHandle =
      hasGuiInfo && typeof guiInfo.hwndFocus === 'number' ? guiInfo.hwndFocus : 0
    const title = readWideString(native.getWindowText, windowHandle)
    const className = readWideString(native.getClassName, windowHandle)
    const focusedClassName = focusedHandle ? readWideString(native.getClassName, focusedHandle) : ''
    const passwordCharacter = focusedHandle ? native.sendMessage(focusedHandle, 0x00d2, 0, 0) : 0

    return {
      windowHandle,
      title,
      className,
      processName: readProcessName(native, processId[0]),
      focusedClassName,
      isPasswordField: passwordCharacter !== 0
    }
  },

  getWindowBounds(windowHandle) {
    const native = loadNativeFunctions()
    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    if (!native.getWindowRect(windowHandle, rect)) return null
    return {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top
    }
  },

  getProcessAgeMs(windowHandle) {
    const native = loadNativeFunctions()
    const processId = new Uint32Array(1)
    native.getWindowThreadProcessId(windowHandle, processId)
    if (!processId[0]) return null

    const processHandle = native.openProcess(0x1000, false, processId[0])
    if (!processHandle) return null

    try {
      const creationTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
      const exitTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
      const kernelTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
      const userTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
      if (!native.getProcessTimes(processHandle, creationTime, exitTime, kernelTime, userTime)) {
        return null
      }

      const ticks =
        (BigInt(creationTime.dwHighDateTime) << 32n) | BigInt(creationTime.dwLowDateTime)
      const unixMilliseconds = Number(ticks / 10_000n - 11_644_473_600_000n)
      return Math.max(0, Date.now() - unixMilliseconds)
    } finally {
      native.closeHandle(processHandle)
    }
  },

  activate(windowHandle) {
    return loadNativeFunctions().setForegroundWindow(windowHandle)
  },

  show(windowHandle, command) {
    const commandValues = { minimize: 6, maximize: 3, restore: 9 } as const
    loadNativeFunctions().showWindow(windowHandle, commandValues[command])
    return true
  },

  move(windowHandle, bounds) {
    return loadNativeFunctions().moveWindow(
      windowHandle,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      true
    )
  },

  requestClose(windowHandle) {
    return loadNativeFunctions().postMessage(windowHandle, 0x0010, 0, 0)
  },

  typeUnicodeText(text) {
    const native = loadNativeFunctions()
    const inputs = [...text].flatMap((character) => {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined || codePoint > 0xffff) {
        return [...character].flatMap((unit) => [
          inputEvent(unit.charCodeAt(0), false),
          inputEvent(unit.charCodeAt(0), true)
        ])
      }
      return [inputEvent(codePoint, false), inputEvent(codePoint, true)]
    })
    return (
      inputs.length > 0 &&
      native.sendInput(inputs.length, inputs, native.inputSize) === inputs.length
    )
  },

  pressEnter() {
    const native = loadNativeFunctions()
    const inputs = [inputEvent(0x0d, false, false), inputEvent(0x0d, true, false)]
    return native.sendInput(inputs.length, inputs, native.inputSize) === inputs.length
  },

  focusSpotifySearch() {
    const native = loadNativeFunctions()
    const inputs = [
      inputEvent(0x11, false, false),
      inputEvent(0x4b, false, false),
      inputEvent(0x4b, true, false),
      inputEvent(0x11, true, false)
    ]
    return native.sendInput(inputs.length, inputs, native.inputSize) === inputs.length
  },

  selectAllText() {
    const native = loadNativeFunctions()
    const inputs = [
      inputEvent(0x11, false, false),
      inputEvent(0x41, false, false),
      inputEvent(0x41, true, false),
      inputEvent(0x11, true, false)
    ]
    return native.sendInput(inputs.length, inputs, native.inputSize) === inputs.length
  },

  pressTab() {
    const native = loadNativeFunctions()
    const inputs = [inputEvent(0x09, false, false), inputEvent(0x09, true, false)]
    return native.sendInput(inputs.length, inputs, native.inputSize) === inputs.length
  }
}

export function inspectActiveTarget(
  controller: WindowController = windowsController
): { target: ForegroundTarget; decision: ProtectedTargetDecision } | null {
  const target = controller.getForegroundTarget()
  return target ? { target, decision: detectProtectedTarget(target) } : null
}

export async function performWindowAction(
  action: WindowAction,
  application: string,
  controller: WindowController = windowsController
): Promise<ActionResult<{ application: string }>> {
  try {
    const windowHandle = controller.findWindow(application)
    if (!windowHandle) {
      return {
        ok: false,
        code: 'WINDOW_NOT_FOUND',
        message: `I could not find an open window for ${application}.`,
        recoverable: true
      }
    }

    if (action === 'closeSafe') {
      const active = controller.getForegroundTarget()
      if (!active || active.windowHandle !== windowHandle) {
        return {
          ok: false,
          code: 'WINDOW_NOT_ACTIVE',
          message: `I did not close ${application} because it is not the active window.`,
          recoverable: true
        }
      }
      const decision = detectProtectedTarget(active)
      if (decision.protected) {
        return {
          ok: false,
          code: 'PROTECTED_TARGET',
          message: decision.message,
          recoverable: true
        }
      }
      if (/[*•]\s*$|\bunsaved\b/i.test(active?.title ?? '')) {
        return {
          ok: false,
          code: 'POTENTIALLY_UNSAVED',
          message: 'I did not close that window because it may contain unsaved work.',
          recoverable: true
        }
      }
    }

    const succeeded =
      action === 'focus'
        ? controller.activate(windowHandle)
        : action === 'closeSafe'
          ? controller.requestClose(windowHandle)
          : controller.show(windowHandle, action)
    if (!succeeded) throw new Error('Windows rejected the window action.')

    const verbs: Record<WindowAction, string> = {
      focus: 'Focused',
      minimize: 'Minimized',
      maximize: 'Maximized',
      restore: 'Restored',
      closeSafe: 'Requested a safe close for'
    }
    return {
      ok: true,
      message: `${verbs[action]} ${application}.`,
      data: { application }
    }
  } catch {
    return {
      ok: false,
      code: 'WINDOW_ACTION_FAILED',
      message: `The window action for ${application} failed.`,
      recoverable: true
    }
  }
}

export async function moveOrResizeWindow(
  application: string,
  patch: Partial<WindowBounds>,
  controller: WindowController = windowsController
): Promise<ActionResult<WindowBounds>> {
  try {
    const windowHandle = controller.findWindow(application)
    if (!windowHandle) {
      return {
        ok: false,
        code: 'WINDOW_NOT_FOUND',
        message: `I could not find an open window for ${application}.`,
        recoverable: true
      }
    }
    const current = controller.getWindowBounds(windowHandle)
    if (!current) throw new Error('Windows did not return the current window bounds.')
    const bounds = { ...current, ...patch }
    if (!controller.move(windowHandle, bounds)) throw new Error('Windows rejected the move.')
    return {
      ok: true,
      message: `Updated the ${application} window.`,
      data: bounds
    }
  } catch {
    return {
      ok: false,
      code: 'WINDOW_ACTION_FAILED',
      message: `The window action for ${application} failed.`,
      recoverable: true
    }
  }
}

export async function typeSafeText(
  text: string,
  controller: WindowController = windowsController
): Promise<ActionResult> {
  try {
    const inspection = inspectActiveTarget(controller)
    if (!inspection) {
      return {
        ok: false,
        code: 'NO_ACTIVE_TARGET',
        message: 'I could not identify the active input target.',
        recoverable: true
      }
    }
    if (inspection.decision.protected) {
      return {
        ok: false,
        code: 'PROTECTED_TARGET',
        message: inspection.decision.message,
        recoverable: true
      }
    }
    if (!controller.typeUnicodeText(text)) throw new Error('Windows rejected the text input.')
    return { ok: true, message: 'Typed the requested text.' }
  } catch {
    return {
      ok: false,
      code: 'TEXT_INPUT_FAILED',
      message: 'The text could not be typed.',
      recoverable: true
    }
  }
}

export async function sendConfirmedMessage(
  recipient: string,
  text: string,
  controller: WindowController = windowsController
): Promise<ActionResult> {
  try {
    const before = inspectActiveTarget(controller)
    if (!before) {
      return {
        ok: false,
        code: 'NO_ACTIVE_TARGET',
        message: 'I could not identify the active message target.',
        recoverable: true
      }
    }
    if (before.decision.protected) {
      return {
        ok: false,
        code: 'PROTECTED_TARGET',
        message: before.decision.message,
        recoverable: true
      }
    }
    if (!controller.typeUnicodeText(text)) throw new Error('Windows rejected the message text.')

    const immediatelyBeforeSend = inspectActiveTarget(controller)
    if (
      !immediatelyBeforeSend ||
      immediatelyBeforeSend.decision.protected ||
      immediatelyBeforeSend.target.windowHandle !== before.target.windowHandle
    ) {
      return {
        ok: false,
        code: 'TARGET_CHANGED',
        message: 'I typed the message but did not send it because the active target changed.',
        recoverable: true
      }
    }
    if (!controller.pressEnter()) throw new Error('Windows rejected the send key.')
    return { ok: true, message: `Sent the message to ${recipient}.` }
  } catch {
    return {
      ok: false,
      code: 'MESSAGE_SEND_FAILED',
      message: `The message to ${recipient} could not be sent.`,
      recoverable: true
    }
  }
}
