import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RealtimeConnectionState, RpcEventFrame, SessionSummary } from '@shared/types'
import { routeKey } from '@/utils/id'

const realtime = vi.hoisted(() => ({
  event: undefined as ((event: RpcEventFrame['params']) => void) | undefined,
  state: undefined as ((state: RealtimeConnectionState) => void) | undefined,
  request: vi.fn(),
}))
const api = vi.hoisted(() => ({ getMessages: vi.fn() }))
vi.mock('@/api/realtime', () => ({
  RpcError: class extends Error {},
  ChatRpcSocket: class {
    onEvent(handler: typeof realtime.event) { realtime.event = handler }
    onState(handler: typeof realtime.state) { realtime.state = handler }
    async connect() { realtime.state?.('ready') }
    close() {}
    async request(...args: unknown[]) { return realtime.request(...args) }
  },
}))
vi.mock('@/api/sessions', () => ({
  getMessages: api.getMessages, getSession: vi.fn(), getSessions: vi.fn(),
  deleteSession: vi.fn(), getSessionUnread: vi.fn(), markSessionRead: vi.fn(), updateSession: vi.fn(),
}))
vi.mock('@/api/profiles', () => ({ getModels: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'viewer' }, activeProfile: { name: 'alpha' },
    status: 'authenticated', isAuthenticated: true,
  }),
}))

import { useChatStore } from '@/stores/chat'

function session(id = 'stored-1'): SessionSummary {
  return { id, profile: 'alpha', owned: true, source: 'ios', title: '跨端聊天',
    messageCount: 0, toolCallCount: 0, startedAt: 1, updatedAt: 2 }
}
function emit(type: string, payload: Record<string, unknown> = {}) {
  realtime.event?.({ type, session_id: 'runtime-1', profile: 'alpha', payload: payload as never })
}

describe('cross-client chat subscriptions', () => {
  let chat: ReturnType<typeof useChatStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    realtime.request.mockReset().mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1', running: false })
    api.getMessages.mockReset().mockResolvedValue({ messages: [], total: 0, returned: 0, hasMore: false })
    chat = useChatStore()
    chat.sessions = [session()]
  })
  afterEach(() => { chat.disconnect(); vi.useRealTimers() })

  it('subscribes a viewer before another device starts, then shows thinking, tools, text and completion', async () => {
    await chat.selectSession('stored-1', 'alpha')
    expect(realtime.request).toHaveBeenCalledExactlyOnceWith('session.resume', {
      session_id: 'stored-1', profile: 'alpha', source: 'web', omit_messages: true,
    })
    expect(chat.sessions[0].updatedAt).toBe(2)
    emit('message.start')
    emit('thinking.delta', { text: '正在检查' })
    expect(chat.isStreaming).toBe(true)
    expect(chat.activeRouteState?.liveStatus).toBe('正在检查')
    emit('tool.start', { tool_id: 'tool-1', name: 'read_file' })
    expect(chat.messages.at(-1)?.toolCalls?.[0]).toMatchObject({ name: 'read_file', status: 'running' })
    emit('tool.complete', { tool_id: 'tool-1', name: 'read_file', result: 'ok' })
    emit('message.delta', { text: '检查完成' })
    expect(chat.messages.at(-1)?.content).toBe('检查完成')
    emit('message.complete', { text: '检查完成' })
    expect(chat.isStreaming).toBe(false)
    expect(chat.activeRouteState?.liveStatus).toBeUndefined()
    expect(chat.messages.at(-1)?.toolCalls?.[0].status).toBe('completed')
  })

  it('restores a run opened before its first text, so tool events are not dropped', async () => {
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1',
      running: true, inflight: { streaming: true, assistant: '' } })
    await chat.selectSession('stored-1', 'alpha')
    expect(chat.isStreaming).toBe(true)
    expect(chat.messages).toHaveLength(1)
    emit('tool.start', { tool_id: 'tool-1', name: 'terminal' })
    expect(chat.messages[0].toolCalls?.[0].name).toBe('terminal')
  })

  it('restores a partial answer and appends later deltas without an extra row', async () => {
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1',
      running: true, inflight: { assistant: '前半段' } })
    await chat.selectSession('stored-1', 'alpha')
    emit('message.delta', { text: '后半段' })
    expect(chat.messages.map(message => message.content)).toEqual(['前半段后半段'])
  })

  it('resubscribes an idle viewer after disconnection and discovers a remote run', async () => {
    await chat.selectSession('stored-1', 'alpha')
    expect(chat.isStreaming).toBe(false)
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1',
      running: true, inflight: { assistant: '断线期间开始的回复' } })
    vi.useFakeTimers()
    realtime.state?.('failed')
    await vi.advanceTimersByTimeAsync(500)
    expect(realtime.request).toHaveBeenCalledTimes(2)
    expect(chat.isStreaming).toBe(true)
    expect(chat.messages.at(-1)?.content).toBe('断线期间开始的回复')
  })

  it('does not repeatedly resume a subscribed session when revisiting it', async () => {
    await chat.selectSession('stored-1', 'alpha')
    await chat.selectSession('stored-1', 'alpha')
    expect(realtime.request).toHaveBeenCalledTimes(1)
    expect(api.getMessages).toHaveBeenCalledTimes(1)
  })

  it('settles a run and clears an interaction completed while the viewer was offline', async () => {
    await chat.selectSession('stored-1', 'alpha')
    emit('message.start')
    emit('message.delta', { text: '部分回复' })
    emit('thinking.delta', { text: '等待确认' })
    emit('approval.request', { request_id: 'approval-1' })
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1',
      running: false, inflight: { assistant: '完整回复', streaming: false } })
    vi.useFakeTimers()
    realtime.state?.('failed')
    await vi.advanceTimersByTimeAsync(500)
    expect(chat.isStreaming).toBe(false)
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]).toMatchObject({ content: '完整回复', stage: 'settled', isStreaming: false })
    expect(chat.activeRouteState?.liveStatus).toBeUndefined()
    expect(chat.pendingApproval).toBeUndefined()
  })

  it('does not duplicate completed history from a retained inactive snapshot', async () => {
    api.getMessages.mockResolvedValue({ messages: [{ id: 'answer-1', sessionId: 'stored-1',
      role: 'assistant', content: '已完成回复', timestamp: 1, stage: 'settled' }], total: 1, returned: 1, hasMore: false })
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'stored-1',
      running: false, inflight: { assistant: '已完成回复', streaming: false } })
    await chat.selectSession('stored-1', 'alpha')
    expect(chat.messages.map(message => message.id)).toEqual(['answer-1'])
  })

  it.each([false, undefined])('keeps history-only sessions unattached with owned=%s', async owned => {
    chat.sessions[0].owned = owned
    await chat.selectSession('stored-1', 'alpha')
    realtime.state?.('ready')
    expect(realtime.request).not.toHaveBeenCalled()
  })

  it('never creates a runtime for an unsent draft on ready', () => {
    const id = chat.createSession('alpha')
    chat.routes[routeKey('alpha', id)].historySynced = true
    realtime.state?.('ready')
    expect(realtime.request).not.toHaveBeenCalled()
  })

  it('retains readable history when subscribing fails and can retry on selection', async () => {
    realtime.request.mockRejectedValueOnce(new Error('connection lost'))
    await chat.selectSession('stored-1', 'alpha')
    expect(chat.historySynced).toBe(true)
    expect(chat.activeRouteState?.error).toBe('connection lost')
    await chat.selectSession('stored-1', 'alpha')
    expect(chat.activeRouteState?.runtimeSessionId).toBe('runtime-1')
  })
})
