import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, matchedRouteKey } from 'vue-router'
import ConversationsView from '@/views/ConversationsView.vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceConversation } from '@shared/workspace'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn(), setApiCsrfToken: vi.fn(), ApiError: class extends Error {} }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'owner' }, profiles: [], refreshProfileAvatars: async () => {} }) }))
vi.mock('@/stores/theme', () => ({ useThemeStore: () => ({}) }))

const originalShowModal = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(apiRequest).mockReset(); HTMLDialogElement.prototype.showModal = originalShowModal; HTMLDialogElement.prototype.close = originalClose })

it.each(['direct', 'group'] as const)('opens and saves the menu target %s while another chat is selected', async kind => {
  const base: WorkspaceConversation = { id: 'current', kind: 'direct', name: '当前聊天', avatar: '', memberIds: ['current-bot'], instructions: '', administratorId: 'current-bot', mode: 'host', autoReplyIds: [], maxReplyRounds: 3, archived: false, pinned: false, readSeq: 0, lastSeq: 0, preview: '', createdAt: 1, updatedAt: 1 }
  const target: WorkspaceConversation = { ...base, id: 'target', kind, name: '目标聊天', memberIds: ['target-bot', ...(kind === 'group' ? ['current-bot'] : [])], administratorId: 'target-bot', instructions: '目标规则', activeAgentStates: kind === 'group' ? { 'target-bot': 'running' } : {} }
  const conversations = [base, target]
  const agents = ['current-bot', 'target-bot'].map(id => ({ id, name: id === 'target-bot' ? '目标机器人' : '当前机器人', avatar: '', instructions: `${id}规则`, nodeId: 'local', profile: 'default', archived: false }))
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  vi.mocked(apiRequest).mockImplementation(async path => {
    if (path === '/api/app/capabilities') return { features: [], csrfToken: 'fixture-csrf' } as never
    if (path === '/api/app/workspace/snapshot') return { agents, conversations, cursor: 1, details: [] } as never
    if (path === '/api/app/agents') return { agents } as never
    if (path === '/api/app/agents/sources') return { sources: [{ nodeId: 'local', profile: 'default', name: '基础机器人' }] } as never
    if (path === '/api/app/conversations') return { conversations, cursor: 1 } as never
    if (path.startsWith('/api/app/events')) return { events: [], cursor: 1 } as never
    const conversation = conversations.find(c => path.split('?')[0] === `/api/app/conversations/${c.id}`)
    if (conversation) return { conversation, messages: [], runs: [], run: null, interactions: [], tasks: [] } as never
    return {} as never
  })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push('/conversations/current'); await router.isReady()
  wrapper = shallowMount(ConversationsView, { attachTo: document.body, global: {
    provide: { [matchedRouteKey as symbol]: shallowRef(router.currentRoute.value.matched[0]) }, plugins: [router],
    stubs: { WorkspaceShell: { template: '<div><slot name="sidebar" /><slot /></div>' }, ComposerShell: { template: '<div />', methods: { filesSnapshot: () => [], attachFiles: async () => {} } }, Teleport: false },
  } })
  await flushPromises()
  wrapper.findComponent({ name: 'ConversationList' }).vm.$emit('settings', 'target')
  await flushPromises()
  const dialog = document.querySelector<HTMLDialogElement>('dialog.editor')!
  expect(dialog.open).toBe(true)
  expect(dialog.querySelector('h2')?.textContent?.trim()).toBe(kind === 'direct' ? '机器人设置' : '群聊设置')
  expect(dialog.querySelector<HTMLInputElement>('input[maxlength="100"]')?.value).toBe(kind === 'direct' ? '目标机器人' : '目标聊天')
  expect(router.currentRoute.value.path).toBe('/conversations/current')
  if (kind === 'group') {
    expect(dialog.querySelector<HTMLInputElement>('input[value="target-bot"]')?.disabled).toBe(true)
    const stop = [...dialog.querySelectorAll('button')].find(button => button.textContent === '停止 目标机器人')!
    stop.click(); await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/api/app/conversations/target/agents/target-bot/stop', expect.objectContaining({ method: 'POST' }))
  }
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith(kind === 'direct' ? '/api/app/agents/target-bot' : '/api/app/conversations/target', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ name: kind === 'direct' ? '目标机器人' : '目标聊天' }) }))
})
