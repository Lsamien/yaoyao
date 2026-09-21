export const DESKTOP_HOST_PROTOCOL = 1
export interface DesktopHostRecord {
  id: string
  name: string
  tokenHash: string
  enabled: boolean
  createdAt: number
  /** Stable id of the installed Mac. Re-login reuses this row instead of adding another. */
  installId?: string
}
export interface DesktopHostSummary extends Omit<DesktopHostRecord, 'tokenHash'> {
  online: boolean
  lastSeen?: number
  hostName?: string
  platform?: string
  displayName?: string
}
/** Downloaded once as desktop-host.json and imported by the remote Mac App. */
export interface DesktopHostConfiguration {
  protocol: 1
  serverURL: string
  hostId: string
  token: string
  allowInsecureLan?: boolean
}
/** Wire format exchanged between a remote computer and the server. */
export interface DesktopHostExchange {
  host: { id: string; name: string; platform: string; screen: boolean; accessibility: boolean; approved: string[]; full?: string[]; fileTransferVersion?: 1; environment?: import('./botEnvironment.js').DesktopEnvironmentMetadata }
  results: { id: string; value?: unknown; error?: string }[]
}
