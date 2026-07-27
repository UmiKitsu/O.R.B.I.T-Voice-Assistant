export const blockedCapabilities = new Set([
  'filesystem.create',
  'filesystem.write',
  'filesystem.append',
  'filesystem.copy',
  'filesystem.move',
  'filesystem.rename',
  'filesystem.delete',
  'filesystem.createDirectory',
  'filesystem.deleteDirectory',
  'filesystem.changePermissions',

  'browser.download',
  'browser.upload',

  'archive.create',
  'archive.extract',

  'shell.execute',
  'powershell.execute',
  'cmd.execute',
  'terminal.typeCommand',
  'script.execute',
  'code.evaluate',

  'software.install',
  'software.uninstall',

  'registry.write',
  'drive.format',
  'drive.partition',

  'security.disableProtection',
  'security.bypassUac',
  'security.obtainCredentials'
])
