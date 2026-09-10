/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  yaoyaoDesktop?: {
    openComputer(id: string): Promise<boolean>
    computerClosed(): Promise<void>
    onComputerClose(callback: () => void): () => void
  }
}
