import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, matchedRouteKey } from 'vue-router'
import ConversationsView from '@/views/ConversationsView.vue'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceConversation } from '@shared/workspace'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn(), setApiCsrfToken: vi.fn(), ApiError: class extends Error {} }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'owner' }, profiles: [], refreshProfileAvatars: async () => {} }) }))
vi.mock('@/stores/theme', () => ({ useThemeStore: () => ({}) }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(apiRequest).mockReset() })

it.each([true, false])('sends the selected delivery mode through the real composer (enabled=%s)', async enabled => {
  const group: WorkspaceConversation = { id: 'group', kind: 'group', name: '开发团队', avatar: '', memberIds: ['bot'], instructions: '', administratorId: 'bot', mode: 'host', autoReplyIds: [], maxReplyRounds: 3, archived: false, pinned: false, readSeq: 0, lastSeq: 0, preview: '', createdAt: 1, updatedAt: 1 }
  const agents = [{ id: 'bot', name: '开发者', avatar: '', instructions: '', nodeId: 'local', profile: 'default', archived: false }]
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === '/api/app/capabilities') return { features: [], csrfToken: 'fixture' } as never
    if (path === '/api/app/workspace/snapshot') return { agents, conversations: [group], cursor: 1, details: [] } as never
    if (path === '/api/app/agents') return { agents } as never
    if (path === '/api/app/agents/sources') return { sources: [] } as never
    if (path === '/api/app/conversations') return { conversations: [group], cursor: 1 } as never
    if (path.startsWith('/api/app/events')) return { events: [], cursor: 1 } as never
    if (path.split('?')[0] === '/api/app/conversations/group') return { conversation: group, messages: [], runs: [], run: null, interactions: [], tasks: [] } as never
    if (path.endsWith('/messages') && options?.method === 'POST') throw new Error('fixture: keep submitted draft')
    return {} as never
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push('/conversations/group'); await router.isReady()
  wrapper = mount(ConversationsView, { shallow: true, attachTo: document.body, global: {
    plugins: [router], provide: { [matchedRouteKey as symbol]: shallowRef(router.currentRoute.value.matched[0]) },
    stubs: { WorkspaceShell: { template: '<div><slot /></div>' }, ComposerShell: false, Teleport: true },
  } })
  await flushPromises()
  const composer = wrapper.getComponent(ComposerShell)
  expect(composer.props('deliveryAvailable')).toBe(true)
  expect(wrapper.find('.delivery-mode').exists()).toBe(false)
  await composer.get('[aria-label="添加"]').trigger('click')
  await composer.findAll('[role="menuitem"]').find(item => item.text().includes('交付目标'))!.trigger('click')
  expect(composer.props('deliveryMode')).toBe(true)
  await composer.get('textarea').setValue('完成交付报告')
  if (!enabled) await composer.get('.composer-delivery-chip').trigger('click')
  await composer.get('[aria-label="发送消息"]').trigger('click')
  await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/conversations/group/messages', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ mode: enabled ? 'goal' : 'chat', content: '完成交付报告' }) }))
  expect(composer.get('textarea').element.value).toBe('完成交付报告')
})
