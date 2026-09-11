import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRouteState } from '@shared/types'
import { applyChatEvent, settleChatMessages } from '@/utils/messageReducer'
import { normalizeChatMessage } from '@/utils/normalize'
import { reconcileChatHistory } from '@/utils/chatHistory'
import { chatMessagesToUi } from '@/components/workspace/viewModels'
import { buildMessageTimelineRows } from '@/utils/turnTrace'
import { projectChatEvent } from '../../src/server/chatEventProjection'

function state(): ChatRouteState { return { route: { sessionId: 's', profile: 'p' }, messages: [], isStreaming: false, isQueued: false,
  historySynced: true, hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0, isLoadingHistory: false, generation: 1 } }
const user = (id: string): ChatMessage => ({ id, sessionId: 's', role: 'user', content: 'pwd', timestamp: 1, stage: 'settled' })

describe('ordinary tool lifecycle and authoritative history', () => {
  it('counts one invocation across generating/start/complete in both realtime and durable projection', () => {
    let current = state(), durable: Record<string, any> | undefined
    for (const [type, payload] of [
      ['message.start', {}], ['tool.generating', { name: 'terminal' }],
      ['tool.start', { tool_id: 'call-1', name: 'terminal', args: { command: 'pwd' } }],
      ['tool.complete', { tool_id: 'call-1', name: 'terminal', result: { output: '/work', exit_code: 0 } }],
      ['message.complete', { text: '/work', status: 'complete' }],
    ] as Array<[string, any]>) {
      current = applyChatEvent(current, { type, payload })
      durable = projectChatEvent(type, payload, durable, 'event:1', 1000) ?? durable
    }
    expect(current.messages.flatMap(message => message.toolCalls ?? [])).toHaveLength(1)
    expect(durable!.tool_calls).toHaveLength(1)
    expect(durable!.tool_calls[0].status).toBe('completed')
    expect(buildMessageTimelineRows(chatMessagesToUi(current.messages)).filter(row => row.kind === 'trace').map(row => row.status)).toEqual(['success'])
  })

  it.each(['message.complete', 'error'])('settles every unfinished tool on %s without inventing success', type => {
    let current = state()
    for (const [event, payload] of [['message.start', {}], ['tool.start', { tool_id: 'call', name: 'terminal' }], ['message.interim', { text: '稍等' }], [type, { text: '结束' }]] as Array<[string, any]>)
      current = applyChatEvent(current, { type: event, payload })
    expect(current.messages.some(message => message.isStreaming)).toBe(false)
    expect(current.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.status)).toEqual(['interrupted'])
    expect(settleChatMessages(current.messages)).toEqual(current.messages)
  })

  it('recognizes persisted event status aliases and nonzero tool exit codes', () => {
    const message = normalizeChatMessage({ id: '1', role: 'assistant', tool_calls: [
      { id: 'empty', status: 'tool.complete' }, { id: 'failed', status: 'tool.complete', result: { exit_code: 1, error: null } },
    ] }, 's')
    expect(message.toolCalls?.map(tool => tool.status)).toEqual(['completed', 'failed'])
    const rows = chatMessagesToUi([message, normalizeChatMessage({ id: '2', role: 'tool', tool_call_id: 'empty', content: '{"exit_code":1}' }, 's')])
    expect(rows[0]!.tools?.every(tool => tool.status === 'error')).toBe(true)
  })

  it('replaces stale live projections by identified completed turns while retaining real repeated sends and active tail', () => {
    const first = user('1'), second = user('2')
    const stale: ChatMessage = { id: 'stream:p:s:1:x', sessionId: 's', role: 'assistant', content: '/work', timestamp: 2, stage: 'streaming', isStreaming: true }
    const final = normalizeChatMessage({ id: '10', role: 'assistant', content: '/work', timestamp: 2 }, 's')
    const active = { ...stale, id: 'stream:p:s:2:y', timestamp: 4 }
    const result = reconcileChatHistory([first, stale, second, active], [first, final], true)
    expect(result.map(message => message.id)).toEqual(['1', '2', '10', active.id])
    expect(result.at(-1)?.isStreaming).toBe(true)
  })

  it('restores a canonical tool row whose text was overwritten by a live final answer', () => {
    const call = normalizeChatMessage({ id: '1018', role: 'assistant', content: '', tool_calls: [{ id: 'call-2', function: { name: 'terminal' } }] }, 's')
    const final = normalizeChatMessage({ id: '1020', role: 'assistant', content: '给你图片', timestamp: 3 }, 's')
    const result = reconcileChatHistory([user('1'), { ...call, content: '给你图片' }], [user('1'), call, final], false)
    expect(result.filter(message => message.content === '给你图片')).toHaveLength(1)
    expect(result.find(message => message.id === '1018')?.content).toBe('')
  })
  it('keeps an active turn when a newer user message is queued after it', () => {
    const live: ChatMessage = { id: 'stream:p:s:1:x', role: 'assistant', sessionId: 's', content: '当前输出', timestamp: 2, stage: 'streaming', isStreaming: true }
    const interim = normalizeChatMessage({ id: '10', role: 'assistant', content: '之前的阶段性说明', timestamp: 1.5 }, 's')
    expect(reconcileChatHistory([user('1'), live, { ...user('queue'), timestamp: 3 }], [user('1'), interim], true))
      .toContainEqual(live)
  })
  it('counts a stable tool ID once when persisted history overlaps a live projection', () => {
    const live = normalizeChatMessage({ id: 'stream:p:s:1:x', role: 'assistant', status: 'streaming', tool_calls: [{ id: 'call', name: 'terminal', result: 'done' }] }, 's')
    const stored = normalizeChatMessage({ id: '10', role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'terminal' } }] }, 's')
    const tools = chatMessagesToUi([user('1'), live, stored]).flatMap(message => message.tools ?? [])
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'call', status: 'success', output: 'done' })
  })
})
