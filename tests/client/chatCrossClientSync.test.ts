import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TranscriptSnapshot } from '@shared/chatTranscript'
import type { RpcEventFrame, RealtimeConnectionState } from '@shared/types'
const wire = vi.hoisted(() => ({
  event: undefined as ((e: RpcEventFrame['params']) => void) | undefined,
  state: undefined as ((s: RealtimeConnectionState) => void) | undefined,
  request: vi.fn(),
  clients: [] as any[],
  owner: 0,
  supported: true,
}))
const api = vi.hoisted(() => ({ messages: vi.fn(), sessions: vi.fn() }))
vi.mock('@/api/realtime', () => ({
  RpcError: class extends Error {},
  ChatRpcSocket: class {
    get transcriptSupported() {
      return wire.supported
    }
    onEvent(f: typeof wire.event) {
      wire.event = f
    }
    onState(f: typeof wire.state) {
      wire.state = f
    }
    async connect() {
      wire.state?.('ready')
    }
    close() {}
    async request(...args: unknown[]) {
      return wire.request(...args)
    }
  },
}))
vi.mock('@/api/chatTranscript', () => ({
  ChatTranscriptClient: class {
    close = vi.fn()
    loadOlder = vi.fn()
    restore = vi.fn()
    run = vi.fn()
    constructor(
      readonly profile: string,
      readonly id: string,
      readonly changed: (value: TranscriptSnapshot) => Promise<void>,
      readonly failed: (error: Error) => void,
    ) {
      wire.clients.push(this)
    }
  },
}))
vi.mock('@/api/sessions', () => ({
  getMessages: api.messages,
  getSessions: api.sessions,
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionUnread: vi.fn(),
  markSessionRead: vi.fn(),
  updateSession: vi.fn(),
  requestHistorySync: vi.fn(),
}))
vi.mock('@/api/profiles', () => ({ getModels: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: `v2-viewer-${wire.owner}` },
    activeProfile: { name: 'p' },
    status: 'authenticated',
    isAuthenticated: true,
  }),
}))
import { useChatStore } from '@/stores/chat'
import { ScopedCache } from '@/utils/cache'
function session(id = 's', owned = true) {
  return {
    id,
    profile: 'p',
    owned,
    source: 'web',
    title: id,
    messageCount: 0,
    toolCallCount: 0,
    startedAt: 1,
    updatedAt: 1,
  }
}
function snapshot(messages: any[], id = 's', extra: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
  return {
    protocol: 'ordinary-chat-transcript-v2',
    epoch: 'test',
    cursor: 1,
    profile: 'p',
    sessionId: id,
    messages,
    session: {},
    hasOlder: false,
    total: messages.length,
    state: 'current',
    running: false,
    queued: false,
    ...extra,
  }
}
const answer = (content = '规范正文', extra = {}) => ({
  id: 'canonical-answer',
  seq: 2,
  revision: 1,
  source_message_id: 'upstream',
  turn_id: 'turn',
  role: 'assistant',
  content,
  status: 'complete',
  ...extra,
})
function emit(type: string, payload: any = {}) {
  wire.event?.({ type, session_id: 'runtime', profile: 'p', payload })
}
describe('ordinary v2 cross-client store', () => {
  let chat: ReturnType<typeof useChatStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    wire.owner++
    wire.clients = []
    wire.supported = true
    wire.request
      .mockReset()
      .mockResolvedValue({ session_id: 'runtime', stored_session_id: 's', running: false })
    api.messages.mockReset().mockResolvedValue({ messages: [], total: 0, returned: 0, hasMore: false })
    api.sessions.mockReset().mockResolvedValue({ items: [session()] })
    chat = useChatStore()
    chat.sessions = [session()]
  })
  afterEach(() => {
    chat.disconnect()
    vi.useRealTimers()
  })
  async function open(id = 's') {
    await chat.selectSession(id, 'p')
    await vi.waitFor(() => expect(wire.clients.some((c) => c.id === id)).toBe(true))
    return wire.clients.filter((c) => c.id === id).at(-1)!
  }
  it('renders only canonical messages and ignores raw upstream bodies and completions', async () => {
    const client = await open()
    await client.changed(snapshot([answer('前半', { status: 'streaming' })], 's', { running: true }))
    emit('message.delta', { text: '不应追加' })
    emit('message.interim', { text: '不应重复' })
    emit('message.complete', { text: '不应替换' })
    expect(chat.messages.map((m) => m.content)).toEqual(['前半'])
    expect(chat.isStreaming).toBe(true)
    await client.changed(snapshot([answer('完整正文', { revision: 2 })], 's', { cursor: 2 }))
    expect(chat.messages.map((m) => m.content)).toEqual(['完整正文'])
    expect(chat.isStreaming).toBe(false)
    expect(api.messages).not.toHaveBeenCalled()
  })
  it('keeps checkpoint state when a usage update replaces the route during outbox persistence', async () => {
    const client = await open()
    const original = ScopedCache.prototype.set
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const spy = vi.spyOn(ScopedCache.prototype, 'set').mockImplementation(async function(this: ScopedCache<unknown>, scope, key, value, durable) {
      if ((this as unknown as { namespace: string }).namespace === 'ordinary-outbox-v2') {
        entered()
        await gate
      }
      await original.call(this, scope, key, value, durable)
    })
    const saving = client.changed(snapshot([answer('正在处理', { status: 'streaming' })], 's', {
      running: true, liveStatus: '正在思考', pendingApproval: { request_id: 'approval-1', message: '请确认' },
    }))
    try {
      await started
      wire.event?.({ type: 'session.usage', session_id: 's', profile: 'p', payload: { input_tokens: 7 } })
      release()
      await saving
      expect(chat.messages.map(m => m.content)).toEqual(['正在处理'])
      expect(chat.isStreaming).toBe(true)
      expect(chat.pendingApproval?.id).toBe('approval-1')
      expect(chat.contextUsage?.inputTokens).toBe(7)
    } finally {
      release()
      await saving.catch(() => {})
      spy.mockRestore()
    }
  })
  it('does not materialize a resume snapshot beside the canonical reply', async () => {
    wire.request.mockResolvedValue({
      session_id: 'runtime',
      stored_session_id: 's',
      running: true,
      inflight: { assistant: '旧恢复快照' },
    })
    const client = await open()
    await client.changed(snapshot([answer('当前正文')]))
    expect(chat.messages.map((m) => m.content)).toEqual(['当前正文'])
    expect(chat.messages[0]!.id).toBe('canonical-answer')
  })
  it('restores tools and pending interactions from the canonical snapshot', async () => {
    const client = await open()
    await client.changed(
      snapshot(
        [
          answer('', {
            status: 'streaming',
            tool_calls: [{ id: 'tool', name: 'terminal', status: 'running' }],
          }),
        ],
        's',
        {
          running: true,
          pendingApproval: { request_id: 'approval', message: '允许执行' },
          pendingClarification: { request_id: 'clarify', question: '请选择' },
        },
      ),
    )
    expect(chat.messages[0]!.toolCalls?.[0]?.id).toBe('tool')
    expect(chat.pendingApproval?.id).toBe('approval')
    expect(chat.pendingClarification?.id).toBe('clarify')
    await client.changed(
      snapshot([answer()], 's', { cursor: 2, pendingApproval: null, pendingClarification: null }),
    )
    expect(chat.pendingApproval).toBeUndefined()
    expect(chat.pendingClarification).toBeUndefined()
  })
  it('rejects a closed session callback after switching to another conversation', async () => {
    const first = await open()
    chat.sessions.push(session('second'))
    wire.request.mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'second' })
    const second = await open('second')
    await second.changed(snapshot([answer('第二个会话')], 'second'))
    await first.changed(snapshot([answer('旧回调')]))
    expect(chat.activeSessionId).toBe('second')
    expect(chat.messages[0]!.content).toBe('第二个会话')
  })
  it('does not let a late submit receipt re-open a completed turn or duplicate the user', async () => {
    const client = await open()
    let accept!: (value: any) => void
    wire.request.mockImplementation((method: string) =>
      method === 'prompt.submit'
        ? new Promise((resolve) => {
            accept = resolve
          })
        : Promise.resolve({}),
    )
    const sending = chat.send('问题')
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
    const local = chat.messages.find((m) => m.role === 'user')!
    await client.changed(
      snapshot(
        [
          {
            id: 'canonical-user',
            seq: 1,
            revision: 2,
            source_message_id: 'persisted-user',
            client_message_id: local.clientMessageId,
            role: 'user',
            content: '问题',
            status: 'complete',
          },
          answer(),
        ],
        's',
        { cursor: 3, running: false },
      ),
    )
    accept({ status: 'streaming' })
    await sending
    expect(chat.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(chat.messages[0]!.stage).toBe('settled')
    expect(chat.isStreaming).toBe(false)
  })
  it('keeps a pending local input during a new generation replacement', async () => {
    const client = await open()
    let reject!: (error: Error) => void
    wire.request.mockImplementation((method: string) =>
      method === 'prompt.submit'
        ? new Promise((_resolve, r) => {
            reject = r
          })
        : Promise.resolve({}),
    )
    const sending = chat.send('待确认').catch(() => {})
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    const local = chat.messages[0]!.id
    await client.changed(snapshot([answer('历史重建')], 's', { epoch: 'rebuilt' }))
    expect(chat.messages.some((m) => m.id === local)).toBe(true)
    reject(new Error('connection lost'))
    await sending
  })
  it('uses transcript pagination without requesting legacy message pages', async () => {
    const client = await open()
    await client.changed(snapshot([answer()], 's', { hasOlder: true }))
    await chat.loadOlder()
    expect(client.loadOlder).toHaveBeenCalledOnce()
    expect(api.messages).not.toHaveBeenCalled()
  })
  it('requires v2 and never falls back to legacy history for owned chat', async () => {
    wire.supported = false
    await expect(chat.selectSession('s', 'p')).rejects.toThrow('升级服务端')
    expect(api.messages).not.toHaveBeenCalled()
  })
  it('keeps read-only native history outside the ordinary transcript', async () => {
    chat.sessions = [session('s', false)]
    await chat.selectSession('s', 'p')
    expect(api.messages).toHaveBeenCalledOnce()
    expect(wire.request).not.toHaveBeenCalled()
  })
})
