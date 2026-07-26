type TitanVersions = {
  electron: string
  chrome: string
  node: string
}

type TitanApi = {
  ping: () => void
  getVersions: () => TitanVersions
}

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
