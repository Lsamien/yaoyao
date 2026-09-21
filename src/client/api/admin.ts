import type { JsonValue } from '@shared/types'
import { apiRequest } from './client'

export interface ManagedUser {
  id: string
  username: string
  role: 'admin' | 'user'
  registrationStatus?: 'pending' | 'approved'
  assignedProfiles?: string[]
  enabled: boolean
  mustChangePassword: boolean
  createdAt: number
  updatedAt: number
}

export async function listUsers(): Promise<ManagedUser[]> {
  const response = await apiRequest<{ items: ManagedUser[] }>('/api/app/admin/users')
  return response.items
}

export async function createUser(username: string, password: string, assignedProfiles: string[] = []): Promise<ManagedUser> {
  return apiRequest('/api/app/admin/users', {
    method: 'POST', body: { username, password, assignedProfiles } as unknown as JsonValue,
  })
}

export async function updateUser(id: string, input: { enabled?: boolean; password?: string; assignedProfiles?: string[] }): Promise<ManagedUser> {
  return apiRequest(`/api/app/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input as unknown as JsonValue,
  })
}

export async function deleteUser(id: string): Promise<void> {
  await apiRequest(`/api/app/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} })
}

export async function setUpstreamCredentials(username: string, password: string): Promise<void> {
  await apiRequest('/api/app/admin/upstream-credentials', {
    method: 'PUT', body: { username, password } as unknown as JsonValue,
  })
}

export interface UpstreamConnectionStatus {
  endpoint: string
  authMode: 'unknown' | 'loopback-token' | 'loopback-direct' | 'password'
  networkScope: 'local' | 'network'
  webNetworkScope: 'local' | 'network'
  ready: boolean
  error?: string
  lastVerifiedAt?: number
}

export function getUpstreamConnectionStatus(): Promise<UpstreamConnectionStatus> {
  return apiRequest('/api/app/admin/upstream-connection')
}

export interface AllowedHostsSettings {
  source: 'none' | 'file' | 'environment'
  hosts: string[]
  editableHosts: string[]
  environmentHosts: string[]
  configurationError?: string
}

export function getAllowedHostsSettings(): Promise<AllowedHostsSettings> {
  return apiRequest('/api/app/system/allowed-hosts')
}

export function saveAllowedHostsSettings(hosts: string[]): Promise<AllowedHostsSettings> {
  return apiRequest('/api/app/system/allowed-hosts', {
    method: 'PUT', body: { hosts } as unknown as JsonValue,
  })
}

export interface OpenVikingSettings {
  enabled: boolean
  url: string
  accountId: string
  keyConfigured: boolean
  source: 'none' | 'file' | 'environment'
  status: 'disabled' | 'ready' | 'error'
  error?: string
}

export function getOpenVikingSettings(): Promise<OpenVikingSettings> {
  return apiRequest('/api/app/admin/openviking')
}

export function saveOpenVikingSettings(input: Omit<OpenVikingSettings, 'keyConfigured' | 'source' | 'status' | 'error'> & { adminKey?: string }): Promise<OpenVikingSettings> {
  return apiRequest('/api/app/admin/openviking', { method: 'PUT', body: input as unknown as JsonValue })
}

export function approveUser(id: string, assignedProfiles: string[]): Promise<ManagedUser> {
  return apiRequest(`/api/app/admin/users/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { assignedProfiles } })
}
