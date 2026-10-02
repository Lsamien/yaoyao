import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import UnreadPanel from '@/components/app/UnreadPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useUnreadStore } from '@/stores/unread'
import type { UnreadSnapshot } from '@shared/unread'

const snapshot: UnreadSnapshot = {
  total: 5, bot: 2, chat: 3,
  conversations: [
    { mode: 'bot', id: 'bot-1', name: '开发助手', preview: '任务已完成', count: 2, updatedAt: 1, messages: [{ id: 'bot-message', seq: 1, taskId: 'task-1' }] },
    { mode: 'chat', id: 'chat-1', profile: 'ops', name: '运维聊天', preview: '检查结果', count: 3, updatedAt: 2, messages: [{ id: 'chat-message', seq: 2 }] },
  ],
}
const unread = useUnreadStore()

async function mountPanel() {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/conversations', component: { template: '<div />' } },
      { path: '/conversations/:id', component: { template: '<div />' } },
      { path: '/chat/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/conversations')
  await router.isReady()
  const selectProfile = vi.spyOn(useAuthStore(pinia), 'selectProfile').mockResolvedValue(undefined)
  const wrapper = mount(UnreadPanel, {
    attachTo: document.body,
    props: { anchor: { left: 372, top: 86 } },
    global: { plugins: [pinia, router] },
  })
  return { wrapper, router, selectProfile }
}

beforeEach(() => {
  unread.reset()
  unread.snapshot = structuredClone(snapshot)
})
afterEach(() => {
  vi.restoreAllMocks()
  unread.reset()
})

function button(selector: string) { return document.querySelector<HTMLButtonElement>(selector)! }

describe('Unread center', () => {
  it('starts with all modes and marks only the selected mode as read', async () => {
    const read = vi.spyOn(unread, 'read').mockResolvedValue(undefined)
    const { wrapper } = await mountPanel()
    expect(document.querySelector('.unread-header p')?.textContent).toBe('5 条未读 · 2 个会话')
    expect(document.querySelectorAll('.unread-row')).toHaveLength(2)
    button('.unread-filters button:nth-child(2)').click()
    await flushPromises()
    expect(document.querySelector('.unread-header p')?.textContent).toBe('2 条未读 · 1 个会话')
    expect(document.querySelectorAll('.unread-row')).toHaveLength(1)
    button('.unread-clear').click()
    await flushPromises()
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith([snapshot.conversations[0]])
    wrapper.unmount()
  })

  it('preserves unread message navigation without marking unseen messages as read', async () => {
    const read = vi.spyOn(unread, 'read').mockResolvedValue(undefined)
    const { wrapper, router, selectProfile } = await mountPanel()
    button('.unread-row').click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/conversations/bot-1')
    expect(router.currentRoute.value.query).toEqual({ taskId: 'task-1', unread: 'bot-message' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
    document.querySelectorAll<HTMLButtonElement>('.unread-row')[1]!.click()
    await flushPromises()
    expect(selectProfile).toHaveBeenCalledWith('ops')
    expect(router.currentRoute.value.path).toBe('/chat/chat-1')
    expect(router.currentRoute.value.query).toEqual({ profile: 'ops', unread: 'chat-message' })
    expect(read).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps keyboard focus inside the dialog', async () => {
    const { wrapper } = await mountPanel()
    const panel = document.querySelector<HTMLElement>('#unread-center')!
    expect(document.activeElement).toBe(panel)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    const last = [...panel.querySelectorAll('button')].at(-1)!
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(button('.unread-close'))
    wrapper.unmount()
  })

  it('prevents duplicate bulk reads and keeps errors visible for retry', async () => {
    let reject!: (reason: Error) => void
    const read = vi.spyOn(unread, 'read').mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
    const { wrapper } = await mountPanel()
    button('.unread-clear').click()
    await flushPromises()
    expect(button('.unread-clear').disabled).toBe(true)
    expect(button('.unread-clear').textContent).toContain('正在同步')
    button('.unread-clear').click()
    expect(read).toHaveBeenCalledOnce()
    reject(new Error('同步失败，请重试'))
    await flushPromises()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('同步失败，请重试')
    expect(button('.unread-clear').disabled).toBe(false)
    unread.reset()
    await flushPromises()
    expect(document.querySelector('.unread-empty')?.textContent).toContain('暂无未读消息')
    expect(button('.unread-clear').disabled).toBe(true)
    wrapper.unmount()
  })
})
