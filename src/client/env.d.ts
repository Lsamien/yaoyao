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
    openLogin?(): Promise<unknown>
    openUpdates?(): Promise<void>
    modeState?(): Promise<{ mode: 'client' | 'server'; serverURL: string; switching: boolean; platform?: string; supportedModes?: ('client' | 'server')[] }>
    switchMode?(mode: 'client' | 'server'): Promise<{ ok: boolean; error?: string; pendingLogin?: boolean }>
    openRemoteLogin?(): Promise<void>
    authorizeComputer?(csrfToken: string): Promise<{ registered: boolean; hostId?: string }>
    deviceHost?(): Promise<{ deviceHost: string | null }>
    openComputer(id: string, target?: { backend?: import('@shared/managedBrowser').ComputerBackend; host?: string }): Promise<boolean>
    computerTargetChanged?(target: { backend: import('@shared/managedBrowser').ComputerBackend; host?: string }): Promise<void>
    computerClosed(): Promise<void>
    onComputerClose(callback: () => void): () => void
  }
}
