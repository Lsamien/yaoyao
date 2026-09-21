import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { systemMessageNotice } from '@/utils/systemMessageNotice'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'

const assignment: UiMessage = { id: 'assigned', role: 'system', content: '由管理员分派的子任务：终审文章\n\n- 核验来源\n- 检查配图' }

describe('system event disclosures', () => {
  it('classifies role-only assignments without treating real replies as notices', () => {
    expect(systemMessageNotice(assignment)).toEqual({ title: '已分派子任务', icon: 'branch' })
    expect(systemMessageNotice({ ...assignment, role: 'assistant' })).toBeUndefined()
    expect(systemMessageNotice({ ...assignment, role: 'user' })).toBeUndefined()
    expect(systemMessageNotice({ ...assignment, communication: { direction: 'incoming', peerId: 'p', peerName: '竹儿', peerAvatar: '', peerKind: 'agent', content: assignment.content } })).toBeUndefined()
  })

  it('distinguishes background completion, interruption and missing exit status', () => {
    const message: UiMessage = { id: 'process', role: 'system', content: 'process', timelineKind: 'background-process' }
    expect(systemMessageNotice(message)?.title).toBe('后台子任务已结束')
    expect(systemMessageNotice({ ...message, timelineMetadata: { exit_code: null } })?.title).toBe('后台子任务已结束')
    expect(systemMessageNotice({ ...message, timelineMetadata: { exit_code: 0 } })?.title).toBe('后台子任务已完成')
    expect(systemMessageNotice({ ...message, timelineMetadata: { exit_code: 1 } })?.title).toBe('后台子任务失败')
    expect(systemMessageNotice({ ...message, timelineMetadata: { exit_code: 143, signal: 'SIGTERM' } })?.title).toBe('后台子任务已终止')
  })

  it.each([MessageTimeline, WorkspaceMessageTimeline])('keeps full requirements behind a short title in both timelines', async component => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    Element.prototype.scrollTo = vi.fn()
    const wrapper = mount(component, { props: { identity: 'test', messages: [assignment] }, global: { stubs: { AgentAvatar: true, MarkdownContent: { props: ['content'], template: '<p>{{ content }}</p>' } } } })
    expect(wrapper.get('summary').text()).toBe('已分派子任务')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('.system-message-notice__details').text()).toContain('核验来源')
    expect(wrapper.find('.message__content').exists()).toBe(false)
    await nextTick()
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})
