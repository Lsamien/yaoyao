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

  it('reconciles a background session after cache synchronization before reusing it', async () => {
    const first = 'background-sync-first', second = 'background-sync-second'
    chat.sessions = [session(first), session(second)]
    realtime.request.mockImplementation((_method: string, params: Record<string, string>) => Promise.resolve({
      session_id: `runtime-${params.session_id}`, stored_session_id: params.session_id, running: false,
    }))
    const user = { id: 'user-background', serverMessageId: 'user-background', sessionId: first,
      role: 'user', content: '第一个问题', timestamp: 1, stage: 'settled' }
    let synchronized = false
    api.getMessages.mockImplementation((id: string) => Promise.resolve({
      messages: id === first ? [user, { id: synchronized ? 'server-final' : 'event:interim',
        serverMessageId: synchronized ? 'server-final' : undefined, sessionId: first,
        role: 'assistant', content: synchronized ? '后台完成的完整结果' : '旧的中间结果', timestamp: 2, stage: 'settled' }] : [],
      total: id === first ? 2 : 0, returned: id === first ? 2 : 0, hasMore: false,
    }))
    await chat.selectSession(first, 'alpha')
    await chat.selectSession(second, 'alpha')
    synchronized = true
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: first })
    expect(chat.activeSessionId).toBe(second)
    expect(chat.messages).toEqual([])
    await chat.selectSession(first, 'alpha')
    await vi.waitFor(() => expect(chat.messages.map(message => message.content)).toEqual(['第一个问题', '后台完成的完整结果']))
    expect(realtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0)
  })

  it('coalesces history invalidations that arrive while an older snapshot is loading', async () => {
    const id = 'sync-during-history-load'
    chat.sessions = [session(id)]
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: id, running: false })
    const page = (text: string) => ({ messages: [{ id: 'answer-sync', serverMessageId: 'answer-sync',
      sessionId: id, role: 'assistant', content: text, timestamp: 1, stage: 'settled' }], total: 1, returned: 1, hasMore: false })
    api.getMessages.mockResolvedValue(page('原缓存'))
    await chat.selectSession(id, 'alpha')
    let release!: (value: unknown) => void
    api.getMessages.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: id })
    await vi.waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2))
    api.getMessages.mockResolvedValue(page('较新完整历史'))
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: id })
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: id })
    release(page('已过时快照'))
    await vi.waitFor(() => expect(chat.messages.map(message => message.content)).toEqual(['较新完整历史']))
    expect(api.getMessages).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(chat.activeRouteState?.isLoadingHistory).toBe(false))
    expect(chat.historySynced).toBe(true)
  })

  it('merges synchronized history into the current route when SSE replaces its state during the read', async () => {
    const id = 'stream-during-history-load'
    chat.sessions = [session(id)]
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: id, running: false })
    const page = (text: string) => ({ messages: [
      { id: 'prior-user', serverMessageId: 'prior-user', sessionId: id, role: 'user', content: '之前的问题', timestamp: 1, stage: 'settled' },
      { id: 'prior-answer', serverMessageId: 'prior-answer', sessionId: id, role: 'assistant', content: text, timestamp: 2, stage: 'settled' },
    ], total: 2, returned: 2, hasMore: false })
    api.getMessages.mockResolvedValue(page('旧正文'))
    await chat.selectSession(id, 'alpha')
    let release!: (value: unknown) => void
    api.getMessages.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: id })
    await vi.waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2))
    emit('run.peer_user_message', { message_id: 'live-user', client_message_id: 'live-client', text: '新问题', timestamp: 3, status: 'accepted' })
    emit('message.start')
    emit('message.delta', { text: '新回复正在继续' })
    release(page('之前的完整正文'))
    await vi.waitFor(() => expect(chat.messages.find(message => message.id === 'prior-answer')?.content).toBe('之前的完整正文'))
    expect(chat.messages.at(-1)?.content).toBe('新回复正在继续')
    expect(chat.isStreaming).toBe(true)
    await vi.waitFor(() => expect(chat.activeRouteState?.isLoadingHistory).toBe(false))
  })

  it('keeps loaded older messages and follows up a synchronization received during pagination', async () => {
    const id = 'sync-during-older-page'
    chat.sessions = [session(id)]
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: id, running: false })
    const recent = (text: string) => ({ messages: [{ id: 'recent-answer', serverMessageId: 'recent-answer',
      sessionId: id, role: 'assistant', content: text, timestamp: 2, stage: 'settled' }], total: 2, returned: 1, hasMore: true })
    api.getMessages.mockResolvedValue(recent('旧的最新页'))
    await chat.selectSession(id, 'alpha')
    let release!: (value: unknown) => void
    api.getMessages.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = chat.loadOlder()
    await vi.waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2))
    emit('session.info', { model: 'new-model' })
    api.getMessages.mockResolvedValue(recent('补齐后的最新页'))
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: id })
    release({ messages: [{ id: 'older-user', serverMessageId: 'older-user', sessionId: id,
      role: 'user', content: '之前加载的老消息', timestamp: 1, stage: 'settled' }], total: 2, returned: 1, hasMore: false })
    await older
    await vi.waitFor(() => expect(chat.messages.map(message => message.content)).toEqual(['之前加载的老消息', '补齐后的最新页']))
    expect(api.getMessages).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(chat.activeRouteState?.isLoadingHistory).toBe(false))
  })

  it('reconciles synchronized history before a delayed submit receipt without duplicating or demoting the user row', async () => {
    chat.sessions = [session('identity-session')]
    realtime.request.mockResolvedValue({ session_id: 'runtime-1', stored_session_id: 'identity-session', running: false })
    await chat.selectSession('identity-session', 'alpha')
    let accept: (value: unknown) => void = () => {}
    realtime.request.mockImplementation((method: string) => method === 'prompt.submit'
      ? new Promise(resolve => { accept = resolve }) : Promise.resolve({}))
    const sending = chat.send('查看服务器情况')
    await vi.waitFor(() => expect(realtime.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(true))
    const local = chat.messages.find(message => message.role === 'user')!
    const persisted = { ...local, id: '1155', serverMessageId: '1155', stage: 'settled' as const }
    api.getMessages.mockResolvedValue({ messages: [persisted], total: 1, returned: 1, hasMore: false })
    emit('sessions.changed', { reason: 'cache.synced', profile: 'alpha', session_id: 'identity-session' })
    await vi.waitFor(() => expect(chat.messages[0]?.id).toBe('1155'))
    accept({ status: 'streaming' })
    await sending
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(chat.messages[0]).toMatchObject({ id: '1155', clientMessageId: local.clientMessageId, stage: 'settled' })
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
