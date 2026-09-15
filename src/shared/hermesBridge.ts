export type HermesBridgeState = 'ready' | 'missing' | 'outdated' | 'restart-required' | 'disabled' | 'unavailable'
export interface HermesBridgeProfileStatus {
  profile: string
  state: HermesBridgeState
  message: string
  installedVersion?: string
  loadedVersion?: string
  canInstall: boolean
}
export interface HermesBridgeStatus {
  endpoint: string
  local: boolean
  mapped?: boolean
  bundledVersion: string
  checkedAt: number
  installing?: string
  message?: string
  profiles: HermesBridgeProfileStatus[]
}
export interface HermesBridgeInstallResult {
  profile: string
  backup: string
  message: string
  status: HermesBridgeStatus
}
