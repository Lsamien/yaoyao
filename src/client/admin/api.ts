import { apiRequest, setApiCsrfToken } from '@/api/client'
import { setWebOrigin } from '@/utils/webOrigin'
import type { Profile } from '@shared/types'

export interface ConsoleSession {
  csrfToken: string
  userId: string | null
  version: string
  setupRequired: boolean
  external: boolean
  webPort: number
  user?: { id: string; username: string; avatar?: string; mustChangePassword: boolean }
  expiresAt?: number
  sudoUntil?: number
}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  ip: string
  module: string
  action: string
  target: string
  outcome: 'ok' | 'denied' | 'failed'
  status: number
  detail: string
}

export interface ConsoleOverview {
  version: string
  kernel: { ready: boolean; error?: string; version: string }
  users: { total: number; admins: number; disabled: number; pending: Array<{ id: string; username: string; createdAt: number }> }
  runners: { total: number; online: number }
  desktopHosts: { total: number; online: number; offline: Array<{ id: string; name: string; lastSeen?: number }> }
  push: { configured: boolean; healthy: boolean; registrations: number }
  update?: { current: string; updateAvailable: boolean; latest?: string }
  web: { host: string; port: number }
  console: { host: string; port: number; external: boolean }
  recentAudit: AuditEntry[]
}

const base = '/api/app/console'

function accept(session: ConsoleSession): ConsoleSession {
  setApiCsrfToken(session.csrfToken, session.userId)
  // Registration forms must hand computers the Web's address, not the console's.
  if (session.webPort) setWebOrigin(`${location.protocol}//${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${session.webPort}`)
  return session
}

export async function loadSession(): Promise<ConsoleSession> {
  return accept(await apiRequest<ConsoleSession>(`${base}/session`, { notifyUnauthorized: false }))
}

export async function login(username: string, password: string): Promise<ConsoleSession> {
  return accept(await apiRequest<ConsoleSession>(`${base}/login`, { method: 'POST', body: { username, password }, notifyUnauthorized: false }))
}

export async function logout(): Promise<void> {
  await apiRequest(`${base}/logout`, { method: 'POST', body: {} })
}

export async function confirmPassword(password: string): Promise<number> {
  return (await apiRequest<{ sudoUntil: number }>(`${base}/sudo`, { method: 'POST', body: { password } })).sudoUntil
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiRequest(`${base}/password`, { method: 'POST', body: { currentPassword, newPassword } })
}

export async function changeUsername(username: string, currentPassword: string): Promise<void> {
  await apiRequest(`${base}/username`, { method: 'POST', body: { username, currentPassword } })
}

export async function overview(): Promise<ConsoleOverview> {
  return apiRequest(`${base}/overview`)
}

export async function profiles(): Promise<Profile[]> {
  const rows = (await apiRequest<{ profiles: Array<{ name: string; label: string; isDefault: boolean }> }>(`${base}/profiles`)).profiles
  return rows.map(row => ({ name: row.name, displayName: row.label, isDefault: row.isDefault }))
}

export interface AuditFilter { module?: string; outcome?: string; since?: number; before?: number }

function auditQuery(filter: AuditFilter, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams(extra)
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, String(value))
  const text = query.toString()
  return text ? `?${text}` : ''
}

export async function audit(filter: AuditFilter, limit = 100): Promise<{ entries: AuditEntry[]; modules: string[] }> {
  return apiRequest(`${base}/audit${auditQuery(filter, { limit: String(limit) })}`)
}

export function auditCsvUrl(filter: AuditFilter): string {
  return `${base}/audit.csv${auditQuery(filter)}`
}
