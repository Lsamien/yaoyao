import { apiRequest } from './client'
import type { ServerIdentity } from '@shared/serverIdentity'

const listeners = new Set<(identity: ServerIdentity) => void>()
export function serverIdentityValue(value: unknown): ServerIdentity | undefined {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  if (typeof v.serverId !== 'string' || typeof v.name !== 'string' || typeof v.displayName !== 'string'
    || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || v.displayName.length > 255) return
  return v as unknown as ServerIdentity
}
export function publishServerIdentity(value: unknown): void {
  const identity = serverIdentityValue(value)
  if (identity) for (const listener of listeners) listener(identity)
}
export function onServerIdentity(listener: (identity: ServerIdentity) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const fetchServerIdentity = () => apiRequest<ServerIdentity>('/api/app/server-identity')
export const saveServerIdentity = (name: string, expectedRevision: number, expectedServerId: string) =>
  apiRequest<ServerIdentity>('/api/app/server-identity', { method: 'PUT', body: { name, expectedRevision, expectedServerId } })
