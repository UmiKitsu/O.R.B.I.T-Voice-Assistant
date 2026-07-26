import { contextBridge, ipcRenderer } from 'electron'

const titan = {
  ping: (): void => ipcRenderer.send('ping'),
  getVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  })
}

contextBridge.exposeInMainWorld('titan', titan)
