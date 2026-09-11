import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRouteState, RpcEventFrame } from '@shared/types'
import { applyChatEvent, mergeChatMessages } from '@/utils/messageReducer'
import { estimateConversationTokens } from '@/utils/contextUsage'

function message(id: string, content = '相同内容', clientMessageId?: string): ChatMessage {
  return {
    id, sessionId: 'session-1', profile: 'yaoyao', role: 'user', content,
    clientMessageId, timestamp: 1, stage: 'settled',
  }
}

function state(): ChatRouteState {
  return {
    route: { profile: 'yaoyao', sessionId: 'session-1' }, messages: [], historySynced: true,
    hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0, isLoadingHistory: false,
    isStreaming: false, isQueued: false, generation: 1,
  }
}

function event(type: string, payload: Record<string, unknown>, sessionId = 'session-1'): RpcEventFrame['params'] {
  return { type, session_id: sessionId, profile: 'yaoyao', payload: payload as never }
}

describe('chat message reducer', () => {
  it('estimates visible conversation tokens when Hermes has no live gauge', () => {
    expect(estimateConversationTokens([
      message('one', '你好，Hermes！'),
      { ...message('two', 'The quick brown fox'), role: 'assistant', reasoning: '检查上下文' },
    ])).toBeGreaterThan(0)
  })

  it('preserves repeated user text when server identities differ', () => {
    const merged = mergeChatMessages([message('one')], [message('two')])
    expect(merged).toHaveLength(2)
    expect(merged.map(item => item.content)).toEqual(['相同内容', '相同内容'])
  })

  it('reconciles an optimistic row only by client message identity', () => {
    const optimistic = { ...message('local', 'hello', 'client-1'), stage: 'pending' as const }
    const persisted = { ...message('server-1', 'hello', 'client-1'), serverMessageId: 'server-1' }
    const merged = mergeChatMessages([optimistic], [persisted])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('server-1')
    expect(merged[0].stage).toBe('settled')
  })

  it.each(['append', 'snapshot', 'prepend'] as const)('repairs both cached echoes when history restores identity (%s)', position => {
    const local = { ...message('local', '查看服务器情况', 'client-1'), stage: 'accepted' as const }
    const oldHistory = { ...message('1155', '查看服务器情况'), serverMessageId: '1155', timestamp: 2 }
    const history = { ...oldHistory, clientMessageId: 'client-1' }
    const merged = mergeChatMessages([local, oldHistory], [history], position)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: '1155', clientMessageId: 'client-1', stage: 'settled', timestamp: 2 })
  })

  it('keeps persisted identity and delivery state when a peer receipt arrives after history', () => {
    const current = state()
    current.messages = [{ ...message('1155', '查看服务器情况', 'client-1'), serverMessageId: '1155' }]
    const updated = applyChatEvent(current, event('run.peer_user_message', {
      message_id: 'user:web:prompt:client-1', client_message_id: 'client-1', text: '查看服务器情况', status: 'accepted',
    }))
    expect(updated.messages).toHaveLength(1)
    expect(updated.messages[0]).toMatchObject({ id: '1155', serverMessageId: '1155', stage: 'settled' })
  })

  it('retains two separate identical submissions while reconciling both echoes', () => {
    const local = ['first', 'second'].map(id => ({ ...message(id, '查看服务器情况', id), stage: 'accepted' as const }))
    const history = local.map((row, index) => ({ ...row, id: String(index + 1), serverMessageId: String(index + 1), stage: 'settled' as const }))
    expect(mergeChatMessages(local, history, 'snapshot').map(row => [row.id, row.clientMessageId, row.stage]))
      .toEqual([['1', 'first', 'settled'], ['2', 'second', 'settled']])
  })

  it('keeps history and a realtime assistant reply in chronological order', () => {
    const optimistic = { ...message('local-user', '新问题', 'client-1'), timestamp: 30, stage: 'pending' as const }
    const older = { ...message('history-user', '旧问题'), timestamp: 10, sequence: 10 }
    const newer = {
      ...message('history-answer', '旧回答'), role: 'assistant' as const, timestamp: 20, sequence: 11,
    }
    const streamed = {
      ...message('stream-answer', '新回答'), role: 'assistant' as const, timestamp: 31, stage: 'streaming' as const, isStreaming: true,
    }

    const merged = mergeChatMessages([optimistic], [newer, older], 'snapshot')
    expect(mergeChatMessages(merged, [streamed]).map(item => item.id)).toEqual([
      'history-user', 'history-answer', 'local-user', 'stream-answer',
    ])
  })

  it('replaces a cached iOS marker with an attachment-only normalized message', () => {
    const cached = message('ios-file', '[用户附加文件：车位.pdf]\n@file:`attachments/车位.pdf`')
    const normalized = {
      ...message('ios-file', ''),
      attachments: [{ id: 'ios-file:0', name: '车位.pdf', mimeType: 'application/pdf', size: 0, kind: 'pdf' as const, url: '/attachments/车位.pdf' }],
    }
    const merged = mergeChatMessages([cached], [normalized])
    expect(merged[0]).toMatchObject({ content: '', attachments: [expect.objectContaining({ name: '车位.pdf' })] })
  })

  it('ignores events attributed to another route', () => {
    const original = state()
    const reduced = applyChatEvent(original, event('message.delta', { delta: 'wrong' }, 'session-2'))
    expect(reduced).toBe(original)
    expect(reduced.messages).toEqual([])
  })

  it('uses terminal authoritative output to repair missed deltas', () => {
    let current = applyChatEvent(state(), event('message.start', { message_id: 'assistant-1' }))
    current = applyChatEvent(current, event('message.delta', { message_id: 'assistant-1', delta: '少量' }))
    current = applyChatEvent(current, event('message.complete', {
      message_id: 'assistant-1', text: '完整最终回答', authoritative_output: true,
      usage: { input: 10, output: 20, total: 30 },
    }))
    expect(current.messages).toHaveLength(1)
    expect(current.messages[0].content).toBe('完整最终回答')
    expect(current.messages[0].stage).toBe('settled')
    expect(current.usage?.totalTokens).toBe(30)
  })

  it('starts a new assistant row after a user prompt when an interrupted row is still marked streaming', () => {
    const interrupted = {
      ...message('assistant-old', '上一轮残留'), role: 'assistant' as const, timestamp: 20,
      stage: 'streaming' as const, isStreaming: true,
    }
    const prompt = { ...message('user-new', '再试试'), timestamp: 30, stage: 'accepted' as const }
    const initial = { ...state(), messages: [interrupted, prompt] }

    let current = applyChatEvent(initial, event('run.started', {}))
    current = applyChatEvent(current, event('message.delta', { delta: '新一轮回答' }))

    expect(current.messages).toHaveLength(3)
    expect(current.messages.map(item => item.content)).toEqual(['上一轮残留', '再试试', '新一轮回答'])
    expect(current.messages[0]).toMatchObject({ id: 'assistant-old', isStreaming: false })
    expect(current.messages[2]).toMatchObject({ role: 'assistant', isStreaming: true })
  })

  it('promotes a synthetic streaming row to a server message id without duplicating it', () => {
    const initial = { ...state(), messages: [{ ...message('user-new', '开始'), timestamp: 30 }] }
    let current = applyChatEvent(initial, event('run.started', {}))
    current = applyChatEvent(current, event('message.delta', { message_id: 'assistant-new', delta: '回答' }))

    expect(current.messages).toHaveLength(2)
    expect(current.messages[1]).toMatchObject({ id: 'assistant-new', content: '回答', isStreaming: true })
  })

  it('seals interim commentary so later streamed text stays at the bottom of the turn', () => {
    const initial = { ...state(), messages: [{ ...message('user-new', '检查项目'), timestamp: 100 }] }
    let current = applyChatEvent(initial, event('message.start', {}))
    current = applyChatEvent(current, event('message.delta', { text: '我先读取配置。', timestamp: 101 }))
    current = applyChatEvent(current, event('message.interim', { text: '我先读取配置。', timestamp: 102 }))
    current = applyChatEvent(current, event('tool.start', { tool_id: 'tool-1', name: 'read_file' }))
    current = applyChatEvent(current, event('tool.complete', { tool_id: 'tool-1', name: 'read_file', result: 'ok' }))
    current = applyChatEvent(current, event('message.delta', { text: '配置没有问题。', timestamp: 105 }))

    expect(current.messages.map(item => item.content)).toEqual(['检查项目', '我先读取配置。', '配置没有问题。'])
    expect(current.messages[1]).toMatchObject({ role: 'assistant', isStreaming: false })
    expect(current.messages[2]).toMatchObject({ role: 'assistant', isStreaming: true })
    expect(current.messages[2].toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', status: 'completed' }),
    ])
  })

  it('preserves interim commentary after the final answer completes', () => {
    const initial = { ...state(), messages: [{ ...message('user-new', '执行'), timestamp: 100 }] }
    let current = applyChatEvent(initial, event('message.start', {}))
    current = applyChatEvent(current, event('message.delta', { text: '开始执行。' }))
    current = applyChatEvent(current, event('message.interim', { text: '开始执行。' }))
    current = applyChatEvent(current, event('message.delta', { text: '执行完成。' }))
    current = applyChatEvent(current, event('message.complete', { text: '执行完成。' }))

    expect(current.messages.map(item => item.content)).toEqual(['执行', '开始执行。', '执行完成。'])
    expect(current.messages.slice(1).every(item => item.isStreaming === false)).toBe(true)
  })

  it('settles an identical completion onto the sealed interim instead of duplicating it', () => {
    const initial = { ...state(), messages: [{ ...message('user-new', '执行'), timestamp: 100 }] }
    let current = applyChatEvent(initial, event('message.start', {}))
    current = applyChatEvent(current, event('message.delta', { text: '已经完成。' }))
    current = applyChatEvent(current, event('message.interim', { text: '已经完成。', already_streamed: true }))
    current = applyChatEvent(current, event('message.complete', { text: '已经完成。' }))

    expect(current.messages.map(item => item.content)).toEqual(['执行', '已经完成。'])
    expect(current.messages[1]).toMatchObject({ stage: 'settled', isStreaming: false })
  })

  it('treats message.complete status=error as a failed terminal row', () => {
    let current = applyChatEvent(state(), event('message.start', { message_id: 'assistant-1' }))
    current = applyChatEvent(current, event('message.complete', {
      message_id: 'assistant-1', status: 'error', text: '工具执行失败', error: 'permission denied',
    }))
    expect(current.messages[0]).toMatchObject({ stage: 'failed', isStreaming: false })
    expect(current.error).toContain('permission denied')
  })

  it('maps the current 9119 context usage field names', () => {
    const current = applyChatEvent(state(), event('session.usage', {
      input: 10, output: 20, total: 30, context_used: 12_500, context_max: 114_688, context_percent: 10.9,
    }))
    expect(current.usage).toMatchObject({ contextTokens: 12_500, contextLimit: 114_688, percentUsed: 10.9 })
  })

  it('tracks approval and clarification independently', () => {
    let current = applyChatEvent(state(), event('approval.request', { request_id: 'approval-1', message: '允许吗？' }))
    current = applyChatEvent(current, event('clarify.request', { request_id: 'clarify-1', question: '选哪个？' }))
    expect(current.pendingApproval?.id).toBe('approval-1')
    expect(current.pendingClarification?.id).toBe('clarify-1')
    current = applyChatEvent(current, event('approval.resolved', {}))
    expect(current.pendingApproval).toBeUndefined()
    expect(current.pendingClarification?.id).toBe('clarify-1')
  })
})
