import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { routeKey } from '@/utils/id'

const realtime = vi.hoisted(() => ({
  eventHandler: undefined as ((event: unknown) => void) | undefined,
  request: vi.fn(),
}))
const sessionsApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  getMessages: vi.fn(),
  getSessions: vi.fn(),
  requestHistorySync: vi.fn(),
}))

vi.mock('@/api/realtime', () => {
  class RpcError extends Error {}
  class ChatRpcSocket {
    onState(): void {}
    onEvent(handler: (event: unknown) => void): void { realtime.eventHandler = handler }
    async connect(): Promise<void> {}
    close(): void {}
    async request(...args: unknown[]): Promise<unknown> { return realtime.request(...args) }
  }
  return { ChatRpcSocket, RpcError }
})

vi.mock('@/api/sessions', () => ({
  deleteSession: vi.fn(),
  getMessages: sessionsApi.getMessages,
  getSession: sessionsApi.getSession,
  getSessions: sessionsApi.getSessions,
  requestHistorySync: sessionsApi.requestHistorySync,
  getSessionUnread: vi.fn(),
  markSessionRead: vi.fn(),
  updateSession: vi.fn(),
}))
vi.mock('@/api/profiles', () => ({ getModels: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'account-1' },
    activeProfile: { name: 'alpha' },
    status: 'authenticated',
  }),
}))

import { useChatStore } from '@/stores/chat'

describe('chat model realtime synchronization', () => {
  beforeEach(() => {
    realtime.eventHandler = undefined
    realtime.request.mockReset().mockResolvedValue({})
    sessionsApi.getMessages.mockReset()
    sessionsApi.requestHistorySync.mockReset().mockResolvedValue(undefined)
    sessionsApi.getSession.mockReset()
    sessionsApi.getSessions.mockReset().mockResolvedValue({ items: [], nextCursor: null })
    setActivePinia(createPinia())
  })

  it('applies another viewer model switch to the active selector and session summary', () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' },
      runtimeSessionId: 'runtime-1', messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel

    realtime.eventHandler?.({
      type: 'session.info', session_id: 'runtime-1',
      payload: { info: { model: newModel.id, provider: newModel.provider } },
    })

    expect(chat.selectedModel).toEqual(newModel)
    expect(chat.sessions[0]).toMatchObject({ model: newModel.id, provider: newModel.provider })
  })

  it('reconciles the active model through REST when another client owns realtime events', async () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel
    sessionsApi.getSession.mockResolvedValue({
      ...chat.sessions[0], model: newModel.id, provider: newModel.provider,
    })

    await chat.refreshActiveSessionModel()

    expect(sessionsApi.getSession).toHaveBeenCalledWith('session-1', 'alpha')
    expect(chat.selectedModel).toEqual(newModel)
  })

  it('releases the local model guard after a failed switch', async () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, runtimeSessionId: 'runtime-1',
      messages: [], historySynced: true, hasMoreBefore: false, loadedMessageCount: 0,
      messageTotal: 0, isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel
    realtime.request.mockRejectedValueOnce(new Error('switch failed'))

    await expect(chat.setModel(newModel)).rejects.toThrow('switch failed')
    expect(chat.selectedModel).toEqual(oldModel)

    realtime.eventHandler?.({
      type: 'session.info', session_id: 'runtime-1',
      payload: { model: newModel.id, provider: newModel.provider },
    })
    expect(chat.selectedModel).toEqual(newModel)
  })

  it('does not resume an old session merely to show its context usage', async () => {
    const chat = useChatStore()
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '旧会话',
      messageCount: 1, toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }

    await chat.selectSession('session-1', 'alpha')
    await Promise.resolve()

    expect(realtime.request).not.toHaveBeenCalled()
  })

  it('debounces global session changes and reloads the visible server projection', async () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      sessionsApi.getSessions.mockResolvedValue({
        items: [{
          id: 'ios-session', profile: 'alpha', source: 'web', title: 'iOS 新会话',
          messageCount: 2, toolCallCount: 0, startedAt: 2, updatedAt: 2,
        }],
        nextCursor: null,
      })

      realtime.eventHandler?.({ type: 'sessions.changed', payload: {} })
      realtime.eventHandler?.({ type: 'sessions.changed', payload: {} })
      realtime.eventHandler?.({ type: 'sessions.changed', payload: {} })

      expect(sessionsApi.getSessions).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)

      expect(sessionsApi.getSessions).toHaveBeenCalledTimes(1)
      expect(sessionsApi.getSessions).toHaveBeenCalledWith('alpha', undefined, 100, 'chat')
      expect(chat.sessions).toEqual([
        expect.objectContaining({ id: 'ios-session', title: 'iOS 新会话' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['session.title', 'session.title.updated'])(
    'applies %s immediately and schedules one authoritative list refresh',
    async eventType => {
      vi.useFakeTimers()
      try {
        const chat = useChatStore()
        chat.sessions = [{
          id: 'session-1', profile: 'alpha', source: 'web', title: '新会话',
          messageCount: 2, toolCallCount: 0, startedAt: 1, updatedAt: 1,
        }]
        chat.routes[routeKey('alpha', 'session-1')] = {
          route: { profile: 'alpha', sessionId: 'session-1' }, runtimeSessionId: 'runtime-1',
          messages: [], historySynced: true, hasMoreBefore: false, loadedMessageCount: 0,
          messageTotal: 0, isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
        }
        sessionsApi.getSessions.mockResolvedValue({
          items: [{ ...chat.sessions[0], title: '服务端自动标题' }],
          nextCursor: null,
        })

        realtime.eventHandler?.({
          type: eventType,
          session_id: 'runtime-1',
          payload: { session_id: 'session-1', title: '服务端自动标题' },
        })

        expect(chat.sessions[0].title).toBe('服务端自动标题')
        expect(sessionsApi.getSessions).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(200)
        expect(sessionsApi.getSessions).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )
  it('uses a synchronized route without history reads and forces refresh only on request', async () => {
    const chat = useChatStore()
    const key = routeKey('alpha', 'session-1')
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[key] = {
      route: { profile: 'alpha', sessionId: 'session-1' },
      messages: [
        { id: 'old', sessionId: 'session-1', role: 'assistant', content: 'old history', timestamp: 1, stage: 'settled' },
        { id: 'unsent', sessionId: 'session-1', role: 'user', content: 'keep failed send', timestamp: 2, stage: 'failed' },
      ], historySynced: true, hasMoreBefore: false, loadedMessageCount: 1, messageTotal: 1,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    for (let i = 0; i < 5; i++) await chat.selectSession('session-1', 'alpha')
    expect(sessionsApi.getMessages).not.toHaveBeenCalled()
    sessionsApi.getMessages.mockResolvedValue({ messages: [
      { id: 'new', sessionId: 'session-1', role: 'assistant', content: 'authoritative', timestamp: 1, stage: 'settled' },
    ], returned: 1, total: 1, hasMore: false })
    await chat.forceRefreshHistory()
    expect(sessionsApi.requestHistorySync).toHaveBeenCalledWith('session-1','alpha')
    expect(sessionsApi.getMessages).not.toHaveBeenCalled()
    expect(chat.messages.map(message => message.id)).toEqual(['old', 'unsent'])
    expect(chat.routes[key].error).toContain('后台补齐')
  })

})
