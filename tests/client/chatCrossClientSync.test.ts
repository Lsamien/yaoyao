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
  it.each(['image_path', 'path', 'ref_path'])('preserves uploaded image %s in pending and canonical messages', async field => {
    const client = await open()
    const paths = ['/home/user/.hermes/images/照片 one.png', '/tmp/photo-two.png']
    let uploaded = 0
    wire.request.mockImplementation((method: string) => Promise.resolve(
      method === 'image.attach_bytes' ? { [field]: paths[uploaded++] } : {},
    ))
    await chat.send('查看图片', paths.map((_, index) => new File(['image'], `photo-${index}.png`, { type: 'image/png' })))
    const submission = wire.request.mock.calls.find(([method]) => method === 'prompt.submit')![1]
    expect(submission.text).toBe([
      '查看图片',
      `[用户附加图片：photo-0.png]\n@image:${paths[0]}\n[screenshot]`,
      `[用户附加图片：photo-1.png]\n@image:${paths[1]}\n[screenshot]`,
    ].join('\n\n'))
    const pending = chat.messages.find(message => message.role === 'user')!
    expect(pending.attachments?.map(file => file.path)).toEqual(paths)
    const checkDownloads = () => chat.messages[0]!.attachments?.forEach((file, index) => {
      const url = new URL(file.url!, 'https://yaoyao.test')
      expect(url.pathname).toBe('/api/files/download')
      expect(url.searchParams.get('path')).toBe(paths[index])
      expect(url.searchParams.get('profile')).toBe('p')
    })
    checkDownloads()
    await client.changed(snapshot([{
      id: 'canonical-image', seq: 1, revision: 1, role: 'user', status: 'complete',
      client_message_id: pending.clientMessageId, content: submission.text,
    }]))
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('查看图片')
    expect(chat.messages[0]!.attachments?.map(file => file.path)).toEqual(paths)
    checkDownloads()
  })
  it('does not fabricate an image path when an older upload response omits it', async () => {
    await open()
    wire.request.mockResolvedValue({})
    await chat.send('', [new File(['image'], 'photo.png', { type: 'image/png' })])
    const submission = wire.request.mock.calls.find(([method]) => method === 'prompt.submit')![1]
    expect(submission.text).toBe('[用户附加图片：photo.png]\n[screenshot]')
    expect(chat.messages[0]!.attachments?.[0]?.url).toBeUndefined()
  })

  it('keeps a model-switch confirmation through transcript updates and sends after confirmation', async () => {
    const client = await open()
    const model = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [model]
    wire.request.mockImplementation(async (method, params) => {
      if (method === 'session.resume') return { session_id: 'runtime', stored_session_id: 's', running: false }
      if (method === 'config.set' && params.key === 'model') return params.confirm_expensive_model
        ? { value: model.id, scope: 'session' }
        : { confirm_required: true, confirm_message: 'Switching this long conversation loses its cached input.' }
      return {}
    })
    await chat.setModel(model)
    await expect(chat.send('待发送')).rejects.toThrow('请先确认模型切换')
    const confirmation = chat.pendingApproval
    expect(confirmation?.message).toContain('cached input')
    await client.changed(snapshot([answer()], 's', { pendingApproval: null }))
    expect(chat.pendingApproval).toEqual(confirmation)

    await chat.respondToApproval(confirmation!.id, 'once')
    expect(wire.request).toHaveBeenCalledWith('config.set', expect.objectContaining({
      key: 'model', confirm_expensive_model: true,
    }))
    expect(chat.pendingApproval).toBeUndefined()
    wire.request.mockClear()
    await chat.send('确认后继续')
    expect(wire.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ text: '确认后继续' }), expect.anything(), expect.anything())
    expect(wire.request.mock.calls.some(([method, params]) => method === 'config.set' && params.key === 'model')).toBe(false)
  })
  it('keeps native approvals separate and dismisses a superseded model confirmation', async () => {
    const client = await open()
    const first = { id: 'model-b', provider: 'provider', name: 'B' }
    const second = { id: 'model-c', provider: 'provider', name: 'C' }
    wire.request.mockImplementation(async (method, params) => method === 'config.set' && params.key === 'model'
      ? { confirm_required: true, confirm_message: `Confirm ${params.value}` } : {})
    await chat.setModel(first)
    const staleId = chat.pendingApproval!.id
    await chat.setModel(second)
    const confirmation = chat.pendingApproval!
    expect(confirmation.id).not.toBe(staleId)
    await client.changed(snapshot([], 's', { pendingApproval: { request_id: 'tool-approval', message: '允许工具' } }))
    expect(chat.pendingApproval?.id).toBe(confirmation.id)
    wire.request.mockClear()
    await chat.respondToApproval(staleId, 'once')
    expect(wire.request).not.toHaveBeenCalled()
    await chat.respondToApproval(confirmation.id, 'deny')
    expect(chat.pendingApproval?.id).toBe('tool-approval')
    await chat.respondToApproval('tool-approval', 'once')
    expect(wire.request).toHaveBeenCalledWith('approval.respond', expect.objectContaining({ choice: 'once' }))
  })
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
