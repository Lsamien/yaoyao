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
    openUpdates?(): Promise<void>
    modeState?(): Promise<{ mode: 'client' | 'server'; serverURL: string; switching: boolean }>
    switchMode?(mode: 'client' | 'server'): Promise<{ ok: boolean; error?: string; pendingLogin?: boolean }>
    openRemoteLogin?(): Promise<void>
    authorizeComputer?(csrfToken: string): Promise<{ registered: boolean; hostId?: string }>
    deviceHost?(): Promise<{ deviceHost: string | null }>
    openComputer(id: string, target?: { backend?: 'desktop' | 'cloud' | 'vm'; host?: string }): Promise<boolean>
    computerTargetChanged?(target: { backend: 'desktop' | 'cloud' | 'vm'; host?: string }): Promise<void>
    computerClosed(): Promise<void>
    onComputerClose(callback: () => void): () => void
  }
}
