import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, matchedRouteKey } from 'vue-router'
import ConversationsView from '../../src/client/views/ConversationsView.vue'
import { apiRequest } from '../../src/client/api/client'

vi.mock('../../src/client/api/client', () => ({ apiRequest: vi.fn(), ApiError: class extends Error {} }))
vi.mock('../../src/client/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'owner' }, profiles: [], refreshProfileAvatars: async () => {} }) }))
vi.mock('../../src/client/stores/theme', () => ({ useThemeStore: () => ({}) }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.mocked(apiRequest).mockReset() })

async function setup(kind: 'direct' | 'group', remove: () => Promise<void> = async () => {}) {
  let archived = [{ id: 'archived', name: '旧聊天', kind, archived: true, memberIds: ['bot'], updatedAt: 1 }]
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push('/conversations'); await router.isReady()
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (options?.method === 'DELETE') { await remove(); archived = []; return {} as never }
    if (path === '/api/app/agents') return { agents: [{ id: 'bot', name: '旧聊天', archived: true }] } as never
    if (path === '/api/app/conversations') return { conversations: archived, cursor: 1 } as never
    if (path.startsWith('/api/app/events')) return { events: [], cursor: 1 } as never
    return {} as never
  })
  wrapper = shallowMount(ConversationsView, { attachTo: document.body, global: {
    provide: { [matchedRouteKey as symbol]: shallowRef(router.currentRoute.value.matched[0]) },
    plugins: [router], stubs: { WorkspaceShell: { template: '<div><slot /></div>' }, FloatingResourceSearch: false, Teleport: false },
  } })
  await flushPromises()
  document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search', { detail: { section: 'groups' } }))
  await flushPromises()
  expect(document.querySelector('.search-delete')).toBeNull()
  document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="已归档"]')!.click()
  await flushPromises()
  return router
}

describe('archived chat deletion from search', () => {
  it('keeps the archived result and route when confirmation is cancelled', async () => {
    const router = await setup('direct')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    document.querySelector<HTMLButtonElement>('.search-delete')!.click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('永久删除 Bot「旧聊天」'))
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
    expect(router.currentRoute.value.path).toBe('/conversations')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旧聊天')
  })

  it.each([['direct', '/api/app/agents/bot'], ['group', '/api/app/conversations/archived']] as const)('deletes an archived %s through its own endpoint and updates the open search', async (kind, endpoint) => {
    await setup(kind)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const button = document.querySelector<HTMLButtonElement>('.search-delete')!
    button.focus(); button.click()
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith(endpoint, { method: 'DELETE' })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('没有已归档聊天')
    expect(document.querySelector('[role="tab"][aria-label="已归档"]')?.textContent).toContain('0')
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] input'))
  })

  it('disables repeated deletion and keeps server errors inside search', async () => {
    let reject!: (error: Error) => void
    await setup('direct', () => new Promise<void>((_, fail) => { reject = fail }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const button = document.querySelector<HTMLButtonElement>('.search-delete')!
    button.click(); await flushPromises()
    expect(button.disabled).toBe(true)
    button.click()
    expect(vi.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
    reject(new Error('此 Bot 仍是群聊成员'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('此 Bot 仍是群聊成员')
    expect(button.disabled).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旧聊天')
  })
})
