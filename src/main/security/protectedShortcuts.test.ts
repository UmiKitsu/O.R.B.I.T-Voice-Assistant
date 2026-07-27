import { describe, expect, it } from 'vitest'
import { isProtectedShortcut } from './protectedShortcuts'

describe('protected shortcuts', () => {
  it.each([
    [['Ctrl', 'S'], { fileExplorer: false }],
    [['Ctrl', 'Shift', 'S'], { fileExplorer: false }],
    [['Shift', 'Delete'], { fileExplorer: false }],
    [['Win', 'R'], { fileExplorer: false, automaticTextEntryAfterRun: true }],
    [['Delete'], { fileExplorer: true }],
    [['F2'], { fileExplorer: true }],
    [['Ctrl', 'X'], { fileExplorer: true }],
    [['Ctrl', 'V'], { fileExplorer: true }],
    [['Ctrl', 'Shift', 'N'], { fileExplorer: true }]
  ] as const)('blocks %j in its protected context', (keys, context) => {
    expect(isProtectedShortcut(keys, context)).toBe(true)
  })

  it.each([
    [['Ctrl', 'F'], { fileExplorer: false }],
    [['F2'], { fileExplorer: false }],
    [['Ctrl', 'C'], { fileExplorer: true }],
    [['Win', 'R'], { fileExplorer: false, automaticTextEntryAfterRun: false }]
  ] as const)('does not over-block %j', (keys, context) => {
    expect(isProtectedShortcut(keys, context)).toBe(false)
  })
})
