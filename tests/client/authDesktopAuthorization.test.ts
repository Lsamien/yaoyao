import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  setup: vi.fn(),
  authorizeComputer: vi.fn(),
  bootstrap: vi.fn(),
  logout: vi.fn(),
  changeCredentials: vi.fn(),
  forgetLogin: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  login: mocks.login,
  setup: mocks.setup,
  bootstrap: mocks.bootstrap,
  logout: mocks.logout,
  fetchProfiles: vi.fn(),
  fetchProfileIdentities: vi.fn(),
  changeCredentials: mocks.changeCredentials,
  updateAccountAvatar: vi.fn(),
}))
vi.mock('@/api/serverIdentity', () => ({ fetchServerIdentity: vi.fn(), onServerIdentity: () => () => {} }))
vi.mock('@/api/client', () => ({
  ApiError: class ApiError extends Error { status = 500 },
  clearApiSecurityContext: vi.fn(),
  onApiUnauthorized: () => () => {},
}))

import { useAuthStore } from '@/stores/auth'

const response = (role: 'admin' | 'user') => ({
  authRequired: true,
  profiles: [],
  csrfToken: 'fresh-csrf',
  user: { id: 'user-1', username: '用户', role },
})

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.login.mockReset()
  mocks.setup.mockReset()
  mocks.authorizeComputer.mockReset()
  mocks.bootstrap.mockReset()
  mocks.logout.mockReset()
  mocks.changeCredentials.mockReset()
  mocks.forgetLogin.mockReset()
  Object.defineProperty(window, 'yaoyaoDesktop', { configurable: true, value: { authorizeComputer: mocks.authorizeComputer, forgetLogin: mocks.forgetLogin } })
})

it('never registers the computer from a login, also for an administrator', async () => {
  for (const role of ['admin', 'user'] as const) {
    mocks.login.mockResolvedValue(response(role))
    const auth = useAuthStore()
    await auth.login({ username: role, password: 'secret' })
    expect(auth.status).toBe('authenticated')
  }
  expect(mocks.authorizeComputer).not.toHaveBeenCalled()
})

it('forgets native authorization on explicit logout even when the server is offline', async () => {
  mocks.login.mockResolvedValue(response('user'))
  const auth = useAuthStore()
  await auth.login({ username: 'member', password: 'secret' })
  mocks.logout.mockRejectedValue(new Error('offline'))
  mocks.bootstrap.mockRejectedValue(new Error('offline'))
  await auth.logout()
  expect(mocks.forgetLogin).toHaveBeenCalledOnce()
  expect(auth.status).toBe('anonymous')
  expect(auth.user).toBeUndefined()
})

it('returns a remote desktop to login after changing its password', async () => {
  mocks.login.mockResolvedValue(response('user'))
  const auth = useAuthStore()
  await auth.login({ username: 'member', password: 'secret' })
  mocks.changeCredentials.mockResolvedValue(response('user').user)
  mocks.bootstrap.mockResolvedValue({ authRequired: true, profiles: [], csrfToken: 'new-csrf' })
  await auth.changeCredentials({ currentPassword: 'secret', newPassword: 'new-secret' })
  expect(mocks.forgetLogin).toHaveBeenCalledOnce()
  expect(auth.status).toBe('anonymous')
})

it('keeps the native local administrator active after setting a remote password', async () => {
  const local = { ...response('admin'), user: { ...response('admin').user, localDesktop: true } }
  mocks.bootstrap.mockResolvedValue(local)
  const auth = useAuthStore()
  await auth.bootstrap()
  mocks.changeCredentials.mockResolvedValue(local.user)
  await auth.changeCredentials({ currentPassword: '', newPassword: 'remote-password' })
  expect(mocks.forgetLogin).not.toHaveBeenCalled()
  expect(auth.status).toBe('authenticated')
  expect(auth.user?.localDesktop).toBe(true)
})
