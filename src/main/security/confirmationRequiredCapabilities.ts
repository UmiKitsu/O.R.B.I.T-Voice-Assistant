export const confirmationRequiredCapabilities = new Set([
  'system.lock',
  'system.signOut',
  'system.restart',
  'system.shutdown',
  'network.disableWifi',
  'network.disableBluetooth',
  'application.closePotentiallyUnsaved',
  'application.closeAll',
  'communication.sendMessage',
  'communication.sendEmail',
  'communication.joinCall',
  'communication.leaveCall',
  'settings.changeImportantSetting'
])
