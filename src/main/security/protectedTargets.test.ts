import { describe, expect, it } from 'vitest'
import { detectProtectedTarget, type ForegroundTarget } from './protectedTargets'

function target(patch: Partial<ForegroundTarget>): ForegroundTarget {
  return {
    windowHandle: 1,
    title: 'Ordinary application',
    className: 'Window',
    processName: 'ordinary.exe',
    focusedClassName: 'Edit',
    isPasswordField: false,
    ...patch
  }
}

describe('protected target detection', () => {
  it.each([
    ['powershell', { processName: 'pwsh.exe' }],
    ['command-prompt', { title: 'Administrator: Command Prompt' }],
    ['windows-terminal', { processName: 'WindowsTerminal.exe' }],
    ['developer-console', { title: 'Chrome DevTools - Console' }],
    ['script-interpreter', { processName: 'python.exe' }],
    ['registry-editor', { title: 'Registry Editor' }],
    ['disk-management', { title: 'Disk Management' }],
    ['task-scheduler', { title: 'Task Scheduler' }],
    ['uac', { processName: 'consent.exe' }],
    ['installer', { title: 'Product Setup Wizard' }],
    ['uninstaller', { title: 'Uninstall Product' }]
  ] as const)('blocks %s', (reason, patch) => {
    expect(detectProtectedTarget(target(patch))).toMatchObject({ protected: true, reason })
  })

  it('blocks password fields independently of the containing application', () => {
    expect(detectProtectedTarget(target({ isPasswordField: true }))).toMatchObject({
      protected: true,
      reason: 'password-field'
    })
  })

  it.each([
    ['save-dialog', 'Save As'],
    ['upload-dialog', 'Choose a file to upload'],
    ['download-dialog', 'Save Download'],
    ['archive-extraction-dialog', 'Extract Compressed Folders']
  ] as const)('blocks %s only as a system dialog', (reason, title) => {
    expect(detectProtectedTarget(target({ className: '#32770', title }))).toMatchObject({
      protected: true,
      reason
    })
    expect(detectProtectedTarget(target({ className: 'Chrome_WidgetWin_1', title }))).toEqual({
      protected: false
    })
  })
})
