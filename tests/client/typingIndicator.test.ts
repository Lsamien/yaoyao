import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, type Component } from 'vue'
import TypingIndicator from '@/components/common/TypingIndicator.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'

const AgentAvatarStub = defineComponent({
  props: {
    name: { type: String, required: true },
    avatar: { type: String, default: '' },
    size: { type: Number, required: true },
    state: { type: String, required: true },
  },
  template: `<span class="agent-avatar-stub" :data-name="name" :data-avatar="avatar" :data-size="size" :data-state="state" />`,
})

const stubs = {
  AgentAvatar: AgentAvatarStub,
  EmptyState: true,
  InteractionCard: true,
  MarkdownContent: true,
  ToolTrace: true,
  TurnTrace: true,
  WorkspaceApprovalCard: true,
}

const user: UiMessage = { id: 'user', role: 'user', content: '请继续' }

function streamingAssistant(): UiMessage {
  return {
    id: 'assistant-streaming',
    role: 'assistant',
    author: '流式助手',
    profile: 'streaming-profile',
    content: '正文已经开始输出',
    reasoning: '思考也已经出现',
    status: 'streaming',
    tools: [{ id: 'tool', name: 'read_file', status: 'running' }],
  }
}

function mountTimeline(component: Component, messages: UiMessage[], thinking: boolean) {
  return mount(component, {
    props: {
      ...(component === WorkspaceMessageTimeline ? { identity: 'timeline' } : {}),
      messages,
      thinking,
      agentAvatars: {
        'streaming-profile': 'avatar-streaming',
        'history-profile': 'avatar-history',
      },
    },
    global: { stubs },
  })
}

describe('TypingIndicator', () => {
  it('renders a compact avatar, three dots and status semantics', () => {
    const wrapper = mount(TypingIndicator, {
      props: { avatarName: '丫头', avatar: '' },
    })

    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
    expect(wrapper.attributes('aria-label')).toBe('机器人正在输入')
    expect(wrapper.attributes('data-testid')).toBe('chat-run-thinking-dots')
    expect(wrapper.get('.agent-avatar').attributes('style')).toContain('width: 20px')
    expect(wrapper.findAll('.thinking-indicator__dot')).toHaveLength(3)
    expect(wrapper.text()).not.toMatch(/\d+ 秒/)
    wrapper.unmount()
  })
})

describe('message timeline typing state', () => {
  const timelines: Array<{ name: string; component: Component }> = [
    { name: 'ordinary', component: MessageTimeline },
    { name: 'workspace', component: WorkspaceMessageTimeline },
  ]

  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    delete (Element.prototype as { scrollTo?: () => void }).scrollTo
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each(timelines)('keeps the typing row visible after content, reasoning and tools start ($name)', async ({ component }) => {
    const wrapper = mountTimeline(component, [user, streamingAssistant()], true)

    const indicator = wrapper.get('[data-testid="chat-run-thinking-dots"]')
    expect(indicator.attributes('role')).toBe('status')
    expect(indicator.attributes('aria-label')).toBe('机器人正在输入')
    expect(wrapper.findAll('.thinking-indicator__dot')).toHaveLength(3)
    expect(wrapper.text()).not.toMatch(/\d+ 秒/)
    const avatar = wrapper.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub')
    expect(avatar.attributes('data-name')).toBe('流式助手')
    expect(avatar.attributes('data-avatar')).toBe('avatar-streaming')
    wrapper.unmount()
  })

  it.each(timelines)('hides the typing row when the run is no longer thinking ($name)', ({ component }) => {
    const wrapper = mountTimeline(component, [user, streamingAssistant()], false)

    expect(wrapper.find('[data-testid="chat-run-thinking-dots"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the workspace header avatar and name in sync with reactive identity props', async () => {
    const wrapper = mount(WorkspaceMessageTimeline, {
      props: {
        identity: 'header-identity',
        messages: [],
        title: 'Apple Dev',
        headerAvatarName: 'Apple Dev',
        headerAvatar: 'avatar-initial',
        headerAvatarState: 'working',
      },
      global: { stubs },
    })

    expect(wrapper.get('.timeline-header h2').text()).toBe('Apple Dev')
    expect(wrapper.find('.timeline-state').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已同步')
    expect(wrapper.get('.timeline-header .agent-avatar-stub').attributes()).toMatchObject({
      'data-name': 'Apple Dev',
      'data-avatar': 'avatar-initial',
      'data-state': 'working',
    })

    await wrapper.setProps({
      title: 'iOS 发布',
      headerAvatarName: 'iOS 发布',
      headerAvatar: 'avatar-updated',
      headerAvatarState: 'success',
    })

    expect(wrapper.get('.timeline-header h2').text()).toBe('iOS 发布')
    expect(wrapper.get('.timeline-header .agent-avatar-stub').attributes()).toMatchObject({
      'data-name': 'iOS 发布',
      'data-avatar': 'avatar-updated',
      'data-state': 'success',
    })
    wrapper.unmount()
  })

  it('uses the current Bot before its first token and follows identity changes instead of old messages', async () => {
    const wrapper = mountTimeline(WorkspaceMessageTimeline, [user], true)
    await wrapper.setProps({ thinkingIdentity: { name: '当前 Bot', avatar: 'current-avatar' } })
    const avatar = () => wrapper.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub')
    expect(avatar().attributes('data-avatar')).toBe('current-avatar')
    await wrapper.setProps({ messages: [streamingAssistant(), user], thinkingIdentity: { name: '接手 Bot', avatar: 'next-avatar' } })
    expect(avatar().attributes('data-name')).toBe('接手 Bot')
    expect(avatar().attributes('data-avatar')).toBe('next-avatar')
    await wrapper.setProps({ thinkingIdentity: { name: '接手 Bot', avatar: 'updated-avatar' } })
    expect(avatar().attributes('data-avatar')).toBe('updated-avatar')
    wrapper.unmount()
  })

  it.each(timelines)('reserves the empty logo aspect ratio before the image loads ($name)', ({ component }) => {
    const wrapper = mount(component, {
      props: {
        ...(component === WorkspaceMessageTimeline ? { identity: 'empty-timeline' } : {}),
        messages: [],
        emptyLogo: true,
      },
      global: { stubs },
    })

    const logo = wrapper.get('.new-chat-empty__logo')
    expect(logo.attributes()).toMatchObject({ width: '1024', height: '1024' })
    expect(wrapper.text()).toContain('聊点什么')
    wrapper.unmount()
  })

  it.each(timelines)('falls back from streaming agent to history agent and default agent ($name)', ({ component }) => {
    const streaming = mountTimeline(component, [
      user,
      { id: 'assistant-history', role: 'assistant', author: '历史助手', profile: 'history-profile', content: '旧回复' },
      streamingAssistant(),
    ], true)
    expect(streaming.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub').attributes('data-name')).toBe('流式助手')
    streaming.unmount()

    const history = mountTimeline(component, [
      user,
      { id: 'assistant-history', role: 'assistant', author: '历史助手', profile: 'history-profile', content: '旧回复' },
    ], true)
    expect(history.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub').attributes('data-name')).toBe('历史助手')
    expect(history.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub').attributes('data-avatar')).toBe('avatar-history')
    history.unmount()

    const fallback = mountTimeline(component, [user], true)
    expect(fallback.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub').attributes('data-name')).toBe('夭')
    expect(fallback.get('[data-testid="chat-run-thinking-dots"] .agent-avatar-stub').attributes('data-avatar')).toBe('')
    fallback.unmount()
  })


})
