type TitanApi = Record<string, never>

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
