import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  setup: vi.fn(),
  authorizeComputer: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  login: mocks.login,
  setup: mocks.setup,
  bootstrap: vi.fn(),
  logout: vi.fn(),
  fetchProfiles: vi.fn(),
  fetchProfileIdentities: vi.fn(),
  changeCredentials: vi.fn(),
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
  Object.defineProperty(window, 'yaoyaoDesktop', { configurable: true, value: { authorizeComputer: mocks.authorizeComputer } })
})

it('re-authorizes the computer only after an explicit administrator login', async () => {
  mocks.login.mockResolvedValue(response('admin'))
  mocks.authorizeComputer.mockResolvedValue({ registered: true, hostId: 'host-1' })
  const auth = useAuthStore()
  await auth.login({ username: 'admin', password: 'secret' })
  expect(mocks.authorizeComputer).toHaveBeenCalledWith('fresh-csrf')
  expect(auth.status).toBe('authenticated')
})

it('does not grant computer control to a non-administrator login', async () => {
  mocks.login.mockResolvedValue(response('user'))
  const auth = useAuthStore()
  await auth.login({ username: 'member', password: 'secret' })
  expect(mocks.authorizeComputer).not.toHaveBeenCalled()
  expect(auth.status).toBe('authenticated')
})

it('keeps the administrator signed in when computer authorization fails', async () => {
  mocks.login.mockResolvedValue(response('admin'))
  mocks.authorizeComputer.mockRejectedValue(new Error('computer offline'))
  const auth = useAuthStore()
  await expect(auth.login({ username: 'admin', password: 'secret' })).resolves.toBeUndefined()
  expect(auth.status).toBe('authenticated')
})
