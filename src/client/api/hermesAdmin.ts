import { apiRequest } from './client'

export interface HermesCredential {
  key: string
  isSet: boolean
  preview: string | null
  description: string
  url: string | null
  category: string
  secret: boolean
  advanced: boolean
  provider: string
  providerLabel: string
  custom: boolean
  readonly: boolean
}

export interface AuxiliaryTask {
  task: string
  provider: string
  model: string
  base_url?: string
  label?: string
  hint?: string
}

export interface AuxiliaryModels {
  tasks: AuxiliaryTask[]
  main?: { provider?: string; model?: string }
  providers?: Array<{ id: string; label: string }>
}

export interface OAuthProvider {
  id: string
  name: string
  flow: string
  web_flow?: string
  cli_command?: string | null
  docs_url?: string | null
  disconnectable?: boolean
  disconnect_hint?: string | null
  status?: { logged_in?: boolean; source_label?: string | null; token_preview?: string | null }
}

export interface OAuthSession {
  session_id: string
  status?: string
  flow?: string
  user_code?: string
  verification_url?: string
  expires_in?: number
  error_message?: string | null
}

const query = (profile: string) => profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''

export async function listHermesCredentials(profile: string): Promise<HermesCredential[]> {
  return (await apiRequest<{ variables: HermesCredential[] }>(`/api/app/admin/hermes/credentials${query(profile)}`)).variables ?? []
}

export async function saveHermesCredential(profile: string, key: string, value: string): Promise<void> {
  await apiRequest('/api/app/admin/hermes/credentials', { method: 'PUT', body: { profile, key, value } })
}

export async function deleteHermesCredential(profile: string, key: string): Promise<void> {
  await apiRequest('/api/app/admin/hermes/credentials', { method: 'DELETE', body: { profile, key } })
}

export async function getAuxiliaryModels(profile: string): Promise<AuxiliaryModels> {
  return apiRequest<AuxiliaryModels>(`/api/app/admin/hermes/auxiliary${query(profile)}`)
}

export async function setAuxiliaryModel(profile: string, task: string, provider: string, model: string): Promise<AuxiliaryModels> {
  return apiRequest<AuxiliaryModels>('/api/app/admin/hermes/auxiliary', { method: 'PUT', body: { profile, task, provider, model } })
}

export async function listOAuthProviders(profile: string): Promise<OAuthProvider[]> {
  return (await apiRequest<{ providers?: OAuthProvider[] }>(`/api/app/admin/hermes/oauth${query(profile)}`)).providers ?? []
}

const oauthPath = (provider: string, action = '') => `/api/app/admin/hermes/oauth/${encodeURIComponent(provider)}${action ? `/${action}` : ''}`

export async function startOAuth(profile: string, provider: string): Promise<OAuthSession> {
  return apiRequest<OAuthSession>(oauthPath(provider, 'start'), { method: 'POST', body: { profile } })
}

export async function pollOAuth(profile: string, provider: string, sessionId: string): Promise<OAuthSession> {
  return apiRequest<OAuthSession>(oauthPath(provider, 'poll'), { method: 'POST', body: { profile, sessionId } })
}

export async function cancelOAuth(profile: string, provider: string, sessionId: string): Promise<void> {
  await apiRequest(oauthPath(provider, 'cancel'), { method: 'POST', body: { profile, sessionId } })
}

export async function submitOAuthToken(profile: string, provider: string, token: string): Promise<void> {
  await apiRequest(oauthPath(provider, 'token'), { method: 'POST', body: { profile, token } })
}

export async function disconnectOAuth(profile: string, provider: string): Promise<void> {
  await apiRequest(oauthPath(provider), { method: 'DELETE', body: { profile } })
}
