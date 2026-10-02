export type DesktopUpdateAction = 'check' | 'download' | 'cancel' | 'install' | 'open' | 'folder' | 'release'

export interface DesktopUpdateState {
  phase: 'idle' | 'checking' | 'checked' | 'downloading' | 'verifying' | 'preparing' | 'ready' | 'installing' | 'cancelled' | 'failed'
  installMode: 'restart' | 'manual'
  currentVersion: string
  latestVersion?: string
  available: boolean
  received: number
  total: number
  message: string
  error?: string
  retryable?: boolean
  canCancel?: boolean
}
