/* eslint-disable @typescript-eslint/explicit-function-return-type */

export function getInstalledLifecycle(reason) {
  return {
    openOptions: reason === 'install',
    reconnect: true
  }
}
