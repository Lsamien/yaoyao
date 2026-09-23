import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, matchedRouteKey } from 'vue-router'
import ConversationsView from '@/views/ConversationsView.vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import { apiRequest } from '@/api/client'

vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), apiRequest: vi.fn(), setApiCsrfToken: vi.fn() }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'owner' }, profiles: [], refreshProfileAvatars: async () => {} }) }))
vi.mock('@/stores/theme', () => ({ useThemeStore: () => ({}) }))
let wrapper: VueWrapper | undefined
const sources: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = []
beforeEach(() => {
  vi.useFakeTimers()
  sources.length = 0
  vi.stubGlobal('EventSource', class extends EventTarget {
    readonly close = vi.fn()
    constructor(readonly url: string) { super(); sources.push(this) }
  })
})
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined
  vi.mocked(apiRequest).mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function mountView(path = '/conversations') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push(path); await router.isReady()
  wrapper = shallowMount(ConversationsView, { global: {
    provide: { [matchedRouteKey as symbol]: shallowRef(router.currentRoute.value.matched[0]) }, plugins: [router],
    stubs: { WorkspaceShell: { template: '<div><slot name="sidebar" /><slot /></div>' }, ComposerShell: { template: '<div />', methods: { filesSnapshot: () => [] } }, Teleport: true },
  } })
  await flushPromises()
}
function successfulResponse(path: string) {
  if (path === '/api/app/capabilities') return { features: [] }
  if (path === '/api/app/workspace/snapshot') return { agents: [], conversations: [], details: [], cursor: 17 }
  throw new Error(`Unexpected request ${path}`)
}
it.each([undefined, null, { agents: [], conversations: [], details: [] }])('recovers incomplete Bot initialization data without requiring a virtual machine', async snapshot => {
  let snapshots = 0
  vi.mocked(apiRequest).mockImplementation(async path => {
    if (path === '/api/app/workspace/snapshot' && snapshots++ === 0) return snapshot as never
    return successfulResponse(path) as never
  })
  await mountView()
  expect(sources).toHaveLength(0)
  expect(wrapper!.get('[role="alert"]').text()).toContain('Bot 会话数据尚未就绪')
  expect(wrapper!.text()).not.toContain('TypeError')
  await vi.advanceTimersByTimeAsync(1500); await flushPromises()
  expect(sources.map(source => source.url)).toEqual(['/api/app/events/stream?after=17'])
  expect(vi.mocked(apiRequest).mock.calls.some(([path]) => /local-vm|computer/.test(path))).toBe(false)
})
it('recovers an initial server outage while the browser stays online', async () => {
  vi.mocked(apiRequest).mockRejectedValueOnce(new Error('服务暂不可用')).mockImplementation(async path => successfulResponse(path) as never)
  await mountView()
  expect(sources).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1500); await flushPromises()
  expect(sources.map(source => source.url)).toEqual(['/api/app/events/stream?after=17'])
  expect(vi.mocked(apiRequest).mock.calls.filter(([path]) => path === '/api/app/capabilities')).toHaveLength(2)
})
it('cancels a scheduled initial recovery when the view is destroyed', async () => {
  vi.mocked(apiRequest).mockRejectedValue(new Error('服务暂不可用'))
  await mountView()
  wrapper!.unmount(); wrapper = undefined
  await vi.advanceTimersByTimeAsync(10_000)
  expect(apiRequest).toHaveBeenCalledTimes(1)
  expect(sources).toHaveLength(0)
})
it('aborts an in-flight snapshot and prevents a late response from connecting after destruction', async () => {
  let signal: AbortSignal | undefined, release!: (value: unknown) => void
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === '/api/app/capabilities') return successfulResponse(path) as never
    signal = options?.signal as AbortSignal
    return new Promise(resolve => { release = resolve })
  })
  await mountView()
  expect(signal?.aborted).toBe(false)
  wrapper!.unmount(); wrapper = undefined
  expect(signal?.aborted).toBe(true)
  release(successfulResponse('/api/app/workspace/snapshot'))
  await flushPromises(); await vi.advanceTimersByTimeAsync(10_000)
  expect(sources).toHaveLength(0)
  expect(apiRequest).toHaveBeenCalledTimes(2)
})
it('cancels recovery while offline and restarts it only when connectivity returns', async () => {
  let online = true
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.mocked(apiRequest).mockRejectedValueOnce(new Error('服务暂不可用')).mockImplementation(async path => successfulResponse(path) as never)
  await mountView()
  online = false; window.dispatchEvent(new Event('offline'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(apiRequest).toHaveBeenCalledTimes(1)
  online = true; window.dispatchEvent(new Event('online')); await flushPromises()
  expect(sources.map(source => source.url)).toEqual(['/api/app/events/stream?after=17'])
})
it('aborts a pending detail on going offline and ignores its late response', async () => {
  let online = true, signal: AbortSignal | undefined, release!: (value: unknown) => void
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (!path.startsWith('/api/app/conversations/')) return successfulResponse(path) as never
    signal = options?.signal as AbortSignal
    return new Promise(resolve => { release = resolve })
  })
  await mountView('/conversations/c')
  expect(signal?.aborted).toBe(false)
  online = false; window.dispatchEvent(new Event('offline'))
  expect(signal?.aborted).toBe(true)
  release({ conversation: { id: 'c', kind: 'direct', name: '迟到会话', memberIds: [], readSeq: 0, lastSeq: 0 }, messages: [], run: null, interactions: [], context: null })
  await flushPromises(); await vi.advanceTimersByTimeAsync(5000)
  expect(wrapper!.findComponent(WorkspaceMessageTimeline).props('title')).not.toBe('迟到会话')
  expect(sources).toHaveLength(0)
})
