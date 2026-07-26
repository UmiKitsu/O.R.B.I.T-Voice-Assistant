import { contextBridge } from 'electron'

const titan = Object.freeze({})

contextBridge.exposeInMainWorld('titan', titan)
