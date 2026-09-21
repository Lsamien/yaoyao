import type { ServerIdentity } from '@shared/serverIdentity'
import { fetchServerIdentity, onServerIdentity } from '@/api/serverIdentity'
import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AuthStatus, BootstrapResponse, CurrentUser, Profile } from '@shared/types'
import * as authApi from '@/api/auth'
import { ApiError, clearApiSecurityContext, onApiUnauthorized } from '@/api/client'

function message(error: unknown): string {
  return error instanceof Error ? error.message : '认证请求失败'
}

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus>('checking')
  const serverIdentity = ref<ServerIdentity>()
  let identityRequest = 0
  const user = ref<CurrentUser>()
  const profiles = ref<Profile[]>([])
  const activeProfileName = ref('')
  const csrfToken = ref('')
  const error = ref<string>()
  const authRequired = ref(true)
  const setupRequired = ref(false)
  const insecureLan = ref(false)
  const groupUploadsEnabled = ref(false)
  const upstreamReady = ref(false)
  const upstreamError = ref<string>()

  const activeProfile = computed(() => profiles.value.find(profile => profile.name === activeProfileName.value)
    ?? profiles.value.find(profile => profile.isDefault)
    ?? profiles.value[0])
  const isBotOnly = computed(() => Boolean(user.value && user.value.role !== 'admin'))
  const isAuthenticated = computed(() => status.value === 'authenticated')

  function acceptServerIdentity(value: ServerIdentity): void {
    if (serverIdentity.value?.serverId === value.serverId && serverIdentity.value.revision > value.revision) return
    if (serverIdentity.value?.serverId === value.serverId && serverIdentity.value.revision === value.revision && serverIdentity.value.name === value.name && serverIdentity.value.displayName === value.displayName) return
    serverIdentity.value = value
  }
  async function refreshServerIdentity(): Promise<void> {
    if (!isAuthenticated.value) return
    const generation = ++identityRequest, account = user.value?.id
    try {
      const value = await fetchServerIdentity()
      if (generation === identityRequest && isAuthenticated.value && user.value?.id === account) acceptServerIdentity(value)
    } catch { /* An older/offline server keeps the last known display name. */ }
  }
  const stopIdentity = onServerIdentity(value => { if (isAuthenticated.value) acceptServerIdentity(value) })
  const refreshIdentityOnFocus = () => { void refreshServerIdentity() }
  if (typeof window !== 'undefined') window.addEventListener('focus', refreshIdentityOnFocus)
  onScopeDispose(() => { stopIdentity(); if (typeof window !== 'undefined') window.removeEventListener('focus', refreshIdentityOnFocus) })

  function publish(response: BootstrapResponse): void {
    if (response.serverIdentity) acceptServerIdentity(response.serverIdentity)
    authRequired.value = response.authRequired
    setupRequired.value = Boolean(response.setupRequired)
    csrfToken.value = response.csrfToken
    insecureLan.value = Boolean(response.insecureLan)
    groupUploadsEnabled.value = Boolean(response.groupUploadsEnabled)
    upstreamReady.value = Boolean(response.upstreamReady)
    upstreamError.value = response.upstreamError
    profiles.value = response.profiles
    user.value = response.user ?? (!response.authRequired
      ? { id: 'local', username: '本机 Hermes', role: 'local' }
      : undefined)
    if (!profiles.value.some(profile => profile.name === activeProfileName.value)) {
      activeProfileName.value = profiles.value.find(profile => profile.isDefault)?.name ?? profiles.value[0]?.name ?? ''
    }
    status.value = user.value ? 'authenticated' : 'anonymous'
    error.value = undefined
  }

  function expire(): void {
    if (status.value === 'anonymous' || status.value === 'checking') return
    status.value = 'expired'
    user.value = undefined
    serverIdentity.value = undefined; identityRequest++
    profiles.value = []
    activeProfileName.value = ''
    csrfToken.value = ''
    clearApiSecurityContext()
  }

  onApiUnauthorized(expire)

  async function authorizeComputerAfterExplicitLogin(response: BootstrapResponse): Promise<void> {
    if (response.user?.role !== 'admin' || !window.yaoyaoDesktop?.authorizeComputer) return
    try { await window.yaoyaoDesktop.authorizeComputer(response.csrfToken) }
    catch { /* Account login still succeeds; the desktop process presents the recovery error. */ }
  }

  async function bootstrap(): Promise<void> {
    status.value = 'checking'
    error.value = undefined
    try { publish(await authApi.bootstrap()) }
    catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) status.value = 'anonymous'
      else status.value = 'error'
      error.value = message(cause)
      user.value = undefined
      profiles.value = []
    }
  }

  async function login(input: authApi.LoginInput): Promise<void> {
    status.value = 'authenticating'
    error.value = undefined
    try {
      const response = await authApi.login(input)
      await authorizeComputerAfterExplicitLogin(response)
      publish(response)
    }
    catch (cause) {
      status.value = 'anonymous'
      error.value = message(cause)
      throw cause
    }
  }

  async function setup(input: authApi.LoginInput): Promise<void> {
    status.value = 'authenticating'
    error.value = undefined
    try {
      const response = await authApi.setup(input)
      await authorizeComputerAfterExplicitLogin(response)
      publish(response)
    }
    catch (cause) {
      status.value = 'anonymous'
      error.value = message(cause)
      throw cause
    }
  }

  async function logout(): Promise<void> {
    try { await authApi.logout() } catch { /* local state still signs out */ }
    status.value = 'anonymous'
    user.value = undefined
    serverIdentity.value = undefined; identityRequest++
    profiles.value = []
    activeProfileName.value = ''
    csrfToken.value = ''
    clearApiSecurityContext()
    try { publish(await authApi.bootstrap()) } catch { status.value = 'anonymous' }
  }

  function selectProfile(name: string): void {
    if (!profiles.value.some(profile => profile.name === name)) throw new Error(`未知 Profile：${name}`)
    activeProfileName.value = name
  }

  async function refreshProfiles(): Promise<void> {
    const nextProfiles = await authApi.fetchProfiles()
    profiles.value = nextProfiles
    if (!nextProfiles.some(profile => profile.name === activeProfileName.value)) {
      activeProfileName.value = nextProfiles.find(profile => profile.isDefault)?.name ?? nextProfiles[0]?.name ?? ''
    }
  }

  async function refreshProfileAvatars(): Promise<void> {
    const identities = await authApi.fetchProfileIdentities(profiles.value)
    profiles.value = profiles.value.map(profile => ({
      ...profile,
      ...(identities[profile.name] ? {
        agentName: identities[profile.name]!.displayName,
        agentAvatar: identities[profile.name]!.avatar,
      } : {}),
    }))
  }

  async function changeCredentials(input: { currentPassword: string; newPassword: string; username?: string }): Promise<void> {
    user.value = await authApi.changeCredentials(input)
    await bootstrap()
  }
  async function updateAccountAvatar(avatar: string | null): Promise<void> {
    user.value = await authApi.updateAccountAvatar(avatar)
  }

  return {
    serverIdentity, acceptServerIdentity, refreshServerIdentity,
    status, user, profiles, activeProfileName, activeProfile, csrfToken, error, authRequired, setupRequired, insecureLan, groupUploadsEnabled,
    upstreamReady, upstreamError, isAuthenticated, isBotOnly, bootstrap, login, setup, logout, selectProfile, refreshProfiles, refreshProfileAvatars,
    changeCredentials, updateAccountAvatar, expire,
  }
})
