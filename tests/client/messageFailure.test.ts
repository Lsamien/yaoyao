import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { collapseDuplicateFailures, messageFailure } from '@/utils/messageFailure'
import MessageFailureNotice from '@/components/messages/MessageFailureNotice.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import { workspaceMessagesToUi } from '@/components/workspace/viewModels'
import type { UiMessage } from '@/components/messages/types'

const error = 'Codex stream produced no SSE events for 120s after the first parsed event (threshold: 120s)'
const failed: UiMessage = { id: 'answer', role: 'assistant', content: error, error, status: 'failed', runId: 'run', createdAt: 1000 }
const duplicate: UiMessage = { id: 'system', role: 'system', content: `执行失败：${error}`, status: 'failed', runId: 'run', createdAt: 1200 }

describe('conversation failure presentation', () => {
  it('folds diagnostics while preserving partial replies and user content', () => {
    expect(messageFailure(failed)).toMatchObject({ title: '响应超时', detail: error, replacesContent: true })
    expect(messageFailure({ ...failed, content: '已完成第一步。' })).toMatchObject({ replacesContent: false, detail: error })
    expect(messageFailure({ ...failed, role: 'user' })).toMatchObject({ title: '消息未发送', replacesContent: false })
    expect(messageFailure({ ...failed, error: undefined, content: '已完成第一步。' })).toMatchObject({ title: '回复暂时中断', replacesContent: false })
    expect(messageFailure({ ...failed, content: `Provider didn’t respond in time on any of 3 attempts — temporarily unavailable.\nProvider said: ${error}` })?.replacesContent).toBe(true)
    expect(messageFailure({ ...failed, status: 'settled', error: undefined })).toBeUndefined()
    expect(messageFailure({ ...failed, taskReference: { conversationId: 'c', taskId: 't' } })).toBeUndefined()
  })

  it('folds only a matching adjacent system failure from the same run', () => {
    expect(collapseDuplicateFailures([failed, duplicate])).toEqual([failed])
    for (const changed of [{ ...duplicate, runId: 'next' }, { ...duplicate, content: '执行失败：Other error' }, { ...duplicate, attachments: [{ id: 'f', name: '结果' }] }]) {
      expect(collapseDuplicateFailures([failed, changed])).toHaveLength(2)
    }
    expect(collapseDuplicateFailures([failed, { id: 'user', role: 'user', content: '重试' }, duplicate])).toHaveLength(3)
    expect(collapseDuplicateFailures([{ ...failed, runId: undefined }, { ...duplicate, runId: undefined }])).toHaveLength(1)
    expect(collapseDuplicateFailures([{ ...failed, runId: undefined }, { ...duplicate, runId: undefined, createdAt: 9000 }])).toHaveLength(2)
    expect(failed.content).toBe(error)
  })

  it('uses a native disclosure with the complete original diagnostic', () => {
    const wrapper = mount(MessageFailureNotice, { props: { failure: messageFailure(failed)! } })
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('summary').text()).toBe('响应超时')
    expect(wrapper.get('summary').text()).not.toContain('SSE')
    expect(wrapper.get('pre').text()).toBe(error)
    expect(wrapper.get('[role="status"]').text()).toBe('响应超时')
    wrapper.unmount()
  })

  it.each([MessageTimeline, WorkspaceMessageTimeline])('uses the same disclosure and keeps partial content in each timeline', async component => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    Element.prototype.scrollTo = vi.fn()
    const wrapper = mount(component, { props: { messages: [failed, duplicate], identity: 'test' }, global: { stubs: { AgentAvatar: true, MarkdownContent: { props: ['content'], template: '<p class="answer">{{ content }}</p>' } } } })
    expect(wrapper.findAll('.failure-notice')).toHaveLength(1)
    expect(wrapper.findAll('.answer')).toHaveLength(0)
    await wrapper.setProps({ messages: [{ ...failed, content: '已完成第一步。' }] })
    expect(wrapper.get('.answer').text()).toBe('已完成第一步。')
    expect(wrapper.findAll('.failure-notice')).toHaveLength(1)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('keeps workspace diagnostics available to the shared timeline', () => {
    const [message] = workspaceMessagesToUi([{ id: 'a', conversationId: 'c', seq: 1, role: 'assistant', content: '部分回复', reasoning: '', status: 'failed', error, runId: 'run', attachments: [], tools: [], createdAt: 1000 }])
    expect(message).toMatchObject({ error, runId: 'run' })
  })
})
