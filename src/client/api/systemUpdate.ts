import type { JsonValue } from '@shared/types'
import { apiRequest } from './client'

export interface ReleaseManifest {
  schemaVersion: 1
  releaseVersion: string
  webVersion: string
  gitTag: string
}

export type UpdateJobState =
  | 'queued'
  | 'downloading'
  | 'building'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface UpdateJob {
  id: string
  operation: 'update' | 'rollback'
  state: UpdateJobState
  message: string
  createdAt: string
  updatedAt: string
  target?: ReleaseManifest
  error?: string
}

export interface SystemUpdateStatus {
  current: ReleaseManifest
  build?: { commit: string; buildNumber: number; dirty: boolean; artifactDigest?: string }
  installationMode: 'source' | 'release' | 'desktop'
  latest?: ReleaseManifest
  updateAvailable: boolean
  supported: boolean
  unsupportedReason?: string
  canRollback: boolean
  job?: UpdateJob
}

export function systemUpdateStatus(): Promise<SystemUpdateStatus> {
  return apiRequest('/api/app/system/update/status')
}

export function checkSystemUpdate(): Promise<SystemUpdateStatus> {
  return apiRequest('/api/app/system/update/check', { method: 'POST', body: {}, timeoutMs: 90_000 })
}

export function applySystemUpdate(targetVersion: string): Promise<UpdateJob> {
  return apiRequest('/api/app/system/update/apply', {
    method: 'POST',
    body: { targetVersion } as JsonValue,
    timeoutMs: 90_000,
  })
}

export function systemUpdateJob(jobID: string): Promise<UpdateJob> {
  return apiRequest(`/api/app/system/update/jobs/${encodeURIComponent(jobID)}`, {
    notifyUnauthorized: false,
    timeoutMs: 5_000,
  })
}

export function rollbackSystemUpdate(): Promise<UpdateJob> {
  return apiRequest('/api/app/system/update/rollback', { method: 'POST', body: {} })
}
