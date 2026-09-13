import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, matchedRouteKey } from 'vue-router'
import ConversationsView from '../../src/client/views/ConversationsView.vue'
import { apiRequest } from '../../src/client/api/client'
import type { WorkspaceLifecyclePreview } from '../../src/shared/workspaceLifecycle'

vi.mock('../../src/client/api/client', () => ({ apiRequest: vi.fn(), setApiCsrfToken: vi.fn(), ApiError: class extends Error {} }))
vi.mock('../../src/client/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'owner' }, profiles: [], refreshProfileAvatars: async () => {} }) }))
vi.mock('../../src/client/stores/theme', () => ({ useThemeStore: () => ({}) }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(apiRequest).mockReset() })

async function setup(kind: 'direct' | 'group', remove: () => Promise<void> = async () => {}, groups: WorkspaceLifecyclePreview['groups'] = [], initiallyArchived = true) {
  let archived = [{ id: 'archived', name: '旧聊天', kind, archived: initiallyArchived, memberIds: ['bot'], updatedAt: 1 }]
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push('/conversations'); await router.isReady()
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === '/api/app/capabilities') return { features: [], csrfToken: 'fixture-csrf' } as never
    if (path === '/api/app/workspace/snapshot') return { agents: [{ id: 'bot', name: '旧聊天', archived: true }], conversations: archived, details: [], cursor: 1 } as never
    if (path.endsWith('/lifecycle')) {
      if (options?.method !== 'POST') return { name: '旧聊天', kind, groups, confirmationToken: 'a'.repeat(64) } as never
      await remove()
      const action = (options.body as { action: string }).action
      if (action === 'delete') archived = []
      else archived = archived.map(item => ({ ...item, archived: action === 'archive' }))
      return {} as never
    }
    if (path === '/api/app/agents') return { agents: [{ id: 'bot', name: '旧聊天', archived: true }] } as never
    if (path === '/api/app/conversations') return { conversations: archived, cursor: 1 } as never
    if (path.startsWith('/api/app/events')) return { events: [], cursor: 1 } as never
    return {} as never
  })
  wrapper = shallowMount(ConversationsView, { attachTo: document.body, global: {
    provide: { [matchedRouteKey as symbol]: shallowRef(router.currentRoute.value.matched[0]) },
    plugins: [router], stubs: { WorkspaceShell: { template: '<div><slot name="sidebar" /><slot /></div>' }, FloatingResourceSearch: false, Teleport: false },
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
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    expect(router.currentRoute.value.path).toBe('/conversations')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旧聊天')
  })

  it.each(['direct', 'group'] as const)('deletes an archived %s with the confirmed snapshot and updates the open search', async kind => {
    await setup(kind)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const button = document.querySelector<HTMLButtonElement>('.search-delete')!
    button.focus(); button.click()
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/api/app/conversations/archived/lifecycle', { method: 'POST', body: { action: 'delete', confirmationToken: 'a'.repeat(64) } })
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
    expect(vi.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    reject(new Error('此 Bot 仍是群聊成员'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('此 Bot 仍是群聊成员')
    expect(button.disabled).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旧聊天')
  })
  it('restores a chat without opening it and updates both archive counts', async () => {
    const router = await setup('direct')
    document.querySelector<HTMLButtonElement>('.search-restore')!.click()
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/api/app/conversations/archived/lifecycle', { method: 'POST', body: { action: 'restore' } })
    expect(router.currentRoute.value.path).toBe('/conversations')
    expect(document.querySelector('[role="tab"][aria-label="未归档"]')?.textContent).toContain('1')
    expect(document.querySelector('[role="tab"][aria-label="已归档"]')?.textContent).toContain('0')
  })
  it.each(['archive', 'delete'] as const)('warns about group membership before %s from the chat menu', async operation => {
    await setup('direct', async () => {}, [{ id: 'group', name: '设计群', administrator: false }], false)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrapper!.findComponent({ name: 'ConversationList' }).vm.$emit(operation, 'archived')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('「设计群」'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('先从这些群聊移除'))
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('blocks a group administrator and asks for a transfer instead of deleting', async () => {
    await setup('direct', async () => {}, [{ id: 'group', name: '管理群', administrator: true }])
    const confirm = vi.spyOn(window, 'confirm')
    document.querySelector<HTMLButtonElement>('.search-delete')!.click()
    await flushPromises()
    expect(confirm).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('「管理群」的管理者，请先转交管理权')
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('shows menu failures outside the chat pane so the list-only layout can display them', async () => {
    await setup('direct', async () => {}, [{ id: 'group', name: '管理群', administrator: true }], false)
    document.querySelector<HTMLButtonElement>('[aria-label="关闭搜索"]')!.click()
    wrapper!.findComponent({ name: 'ConversationList' }).vm.$emit('archive', 'archived')
    await flushPromises()
    const alert = document.querySelector('.lifecycle-error')!
    expect(alert.textContent).toContain('请先转交管理权')
    expect(alert.parentElement).toBe(document.body)
    document.querySelector<HTMLButtonElement>('[aria-label="关闭聊天操作提示"]')!.click()
    await flushPromises()
    expect(document.querySelector('.lifecycle-error')).toBeNull()
  })
})
