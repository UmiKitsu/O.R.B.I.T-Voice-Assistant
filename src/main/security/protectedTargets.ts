export type ForegroundTarget = {
  windowHandle: number
  title: string
  className: string
  processName: string
  focusedClassName: string
  isPasswordField: boolean
}

export type ProtectedTargetReason =
  | 'powershell'
  | 'command-prompt'
  | 'windows-terminal'
  | 'developer-console'
  | 'script-interpreter'
  | 'registry-editor'
  | 'disk-management'
  | 'task-scheduler'
  | 'uac'
  | 'installer'
  | 'uninstaller'
  | 'password-field'
  | 'save-dialog'
  | 'upload-dialog'
  | 'download-dialog'
  | 'archive-extraction-dialog'

export type ProtectedTargetDecision =
  { protected: false } | { protected: true; reason: ProtectedTargetReason; message: string }

const protectedPatterns: ReadonlyArray<{
  reason: Exclude<
    ProtectedTargetReason,
    | 'password-field'
    | 'save-dialog'
    | 'upload-dialog'
    | 'download-dialog'
    | 'archive-extraction-dialog'
  >
  pattern: RegExp
}> = [
  { reason: 'powershell', pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b/i },
  { reason: 'command-prompt', pattern: /\b(?:command prompt|cmd(?:\.exe)?)\b/i },
  {
    reason: 'windows-terminal',
    pattern: /\b(?:windows terminal|windowsterminal|wt(?:\.exe)?)\b/i
  },
  {
    reason: 'developer-console',
    pattern: /\b(?:developer tools|devtools|debug console|javascript console)\b/i
  },
  {
    reason: 'script-interpreter',
    pattern: /\b(?:pythonw?|node|wscript|cscript|ruby|perl)(?:\.exe)?\b/i
  },
  { reason: 'registry-editor', pattern: /\b(?:registry editor|regedit(?:\.exe)?)\b/i },
  {
    reason: 'disk-management',
    pattern: /\b(?:disk management|diskmgmt|virtual disk manager)\b/i
  },
  {
    reason: 'task-scheduler',
    pattern: /\b(?:task scheduler|taskschd|mmc\.exe.*task scheduler)\b/i
  },
  {
    reason: 'uac',
    pattern: /\b(?:user account control|consent(?:\.exe)?|credentialui)\b/i
  },
  {
    reason: 'installer',
    pattern: /\b(?:installer|installation|setup(?:\.exe)?|msiexec(?:\.exe)?|install wizard)\b/i
  },
  {
    reason: 'uninstaller',
    pattern: /\b(?:uninstaller|uninstall(?:ation)?|unins\d*(?:\.exe)?)\b/i
  }
]

const dialogPatterns: ReadonlyArray<{
  reason: 'save-dialog' | 'upload-dialog' | 'download-dialog' | 'archive-extraction-dialog'
  pattern: RegExp
}> = [
  {
    reason: 'download-dialog',
    pattern: /\b(?:download|save download|download file)\b/i
  },
  { reason: 'save-dialog', pattern: /\b(?:save|save as|export)\b/i },
  {
    reason: 'upload-dialog',
    pattern: /\b(?:upload|choose (?:a )?file|select (?:a )?file|file upload)\b/i
  },
  {
    reason: 'archive-extraction-dialog',
    pattern: /\b(?:extract|extracting|compressed folders|winrar|7-zip)\b/i
  }
]

const reasonLabels: Record<ProtectedTargetReason, string> = {
  powershell: 'PowerShell',
  'command-prompt': 'Command Prompt',
  'windows-terminal': 'Windows Terminal',
  'developer-console': 'a developer console',
  'script-interpreter': 'a script interpreter',
  'registry-editor': 'Registry Editor',
  'disk-management': 'Disk Management',
  'task-scheduler': 'Task Scheduler',
  uac: 'User Account Control',
  installer: 'an installer',
  uninstaller: 'an uninstaller',
  'password-field': 'a password field',
  'save-dialog': 'a Save dialog',
  'upload-dialog': 'an Upload dialog',
  'download-dialog': 'a Download dialog',
  'archive-extraction-dialog': 'an archive extraction dialog'
}

export function detectProtectedTarget(target: ForegroundTarget): ProtectedTargetDecision {
  if (target.isPasswordField) {
    return protectedDecision('password-field')
  }

  const identity = `${target.processName} ${target.title} ${target.className}`
  for (const candidate of protectedPatterns) {
    if (candidate.pattern.test(identity)) return protectedDecision(candidate.reason)
  }

  // Common file dialogs use this class. Requiring it avoids blocking ordinary web pages
  // merely because their title contains words such as "download".
  if (target.className === '#32770') {
    const dialogIdentity = `${target.title} ${target.focusedClassName}`
    for (const candidate of dialogPatterns) {
      if (candidate.pattern.test(dialogIdentity)) return protectedDecision(candidate.reason)
    }
  }

  return { protected: false }
}

function protectedDecision(reason: ProtectedTargetReason): ProtectedTargetDecision {
  return {
    protected: true,
    reason,
    message: `Automated input is blocked because the active target is ${reasonLabels[reason]}.`
  }
}
