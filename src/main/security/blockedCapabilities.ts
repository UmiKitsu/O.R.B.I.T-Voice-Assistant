export const blockedCapabilities = new Set([
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

  'software.uninstall',

  'registry.write',
  'drive.format',
  'drive.partition',

  'security.disableProtection',
  'security.bypassUac',
  'security.obtainCredentials',

  'process.stopCritical',
  'service.change',
  'driver.change',
  'firewall.change',
  'boot.change',
  'permission.change',
  'system.elevate'
])
