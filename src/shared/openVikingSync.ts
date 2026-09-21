export interface OpenVikingSyncStatus {
  enabled: boolean
  backfilling: boolean
  pending: number
  complete: number
  failed: number
  lastError?: string
}
