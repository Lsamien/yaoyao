// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { botRelayIntent, relayFingerprint, relayMessageValue } from '../../src/server/workspaceRelay'
import { mentionedAgents } from '../../src/server/workspaceMentions'
import type { WorkspaceMessage } from '../../src/shared/workspace'

const members = [{ id: 'reviewer', name: '审核' }, { id: 'writer', name: '文案' }, { id: 'lead', name: '竹儿' }]
describe('assistant relay intent', () => {
  it.each([
    '收到 @审核 终审维持通过。\n\n交付状态（不变）：入草稿箱 Media ID `abc123`，发布目录 `/work/final/`。\n等民哥群发指令。',
    '@竹儿 维持通过，**等民哥群发指令**。无新事实、无新派工，本轮不重复核验。',
    '感谢 @审核，等待用户指令。',
    '@审核 已通过。',
    '收到，等待用户指令。',
    'Thanks @审核.\nWaiting for your input',
  ])('does not dispatch a closing receipt: %s', text => {
    expect(botRelayIntent(text, members)).toMatchObject({ targetIds: [], acknowledgementOnly: true })
  })
  it.each([
    '感谢 @审核，请重新检查第二段。',
    '收到 @审核，第二段还有一个问题。',
    '请@审核检查接口，@文案检查数据',
    '@审核 第一步',
    '@审核 继续',
    '@审核',
    '请复核：@审核',
    '请 @审核 等待数据库恢复后重试',
    '@审核 不要修改第一段，请修改第二段',
  ])('keeps new or ambiguous assignments: %s', text => {
    expect(botRelayIntent(text, members).targetIds).toContain('reviewer')
  })
  it('filters targets individually and preserves repeated mention overrides', () => {
    expect(botRelayIntent('感谢 @审核，@文案 请修改第二段', members).targetIds).toEqual(['writer'])
    expect(botRelayIntent('感谢 @审核。@文案 已收到。请 @审核 重新检查。', members).targetIds).toEqual(['reviewer'])
  })
  it('keeps user routing unchanged and ignores quoted, code, URL and email mentions', () => {
    expect(mentionedAgents('感谢 @审核', members)).toEqual(['reviewer'])
    expect(botRelayIntent('收到。\n> @审核\n```\n@文案\n```\n`@竹儿` <quoted_message>@审核</quoted_message>', members).targetIds).toEqual([])
  })
  it('leaves unfamiliar text and long repetitive text to the cycle guard', () => {
    expect(botRelayIntent('本轮还缺少数据', members).acknowledgementOnly).toBe(false)
    expect(botRelayIntent('收到'.repeat(16000) + ' @审核', members).targetIds).toEqual(['reviewer'])
  })
})

const message = (): WorkspaceMessage => ({
  id: 'message-1', conversationId: 'chat', seq: 1, role: 'assistant', agentId: 'reviewer', content: '检查 /work/final 版本 2',
  reasoning: 'thinking', status: 'complete', createdAt: 1,
  tools: [{ id: 'event-1', name: 'check', status: 'tool.complete', createdAt: 1, arguments: { id: 10 }, result: { timestamp: 123, count: 2 } }],
  attachments: [{ id: 'file-1', name: 'report.txt', mimeType: 'text/plain', size: 12, createdAt: 1, messageId: 'message-1' }],
})
const key = (m: WorkspaceMessage) => relayFingerprint(relayMessageValue(m))
describe('relay progress fingerprints', () => {
  it('ignores delivery IDs, timestamps, reasoning, whitespace and object key order', () => {
    const original = message(), other = message()
    other.id = 'message-2'; other.seq = 200; other.createdAt = 10; other.reasoning = 'new thinking'
    other.content = ' 检查   /work/final\n版本 2 '
    other.tools[0] = { ...other.tools[0], id: 'event-2', createdAt: 20, durationMs: 44 }
    other.attachments[0] = { ...other.attachments[0]!, messageId: 'message-2', createdAt: 20 }
    expect(key(other)).toBe(key(original))
    expect(relayFingerprint({ a: 1, b: 2 })).toBe(relayFingerprint({ b: 2, a: 1 }))
  })
  it.each(['content', 'path', 'toolArgument', 'toolResult', 'artifact', 'codeWhitespace', 'argumentWhitespace'] as const)('preserves new business evidence: %s', field => {
    const original = message(), other = message()
    if (field === 'content') other.content = '检查 /work/final 版本 3'
    if (field === 'path') other.content = '检查 /work/next 版本 2'
    if (field === 'toolArgument') other.tools[0]!.arguments = { id: 11 }
    if (field === 'toolResult') other.tools[0]!.result = { timestamp: 124, count: 2 }
    if (field === 'artifact') other.attachments[0]!.id = 'file-2'
    if (field === 'codeWhitespace') { original.content = '`/work/a b`'; other.content = '`/work/a  b`' }
    if (field === 'argumentWhitespace') { original.tools[0]!.arguments = { path: '/work/a b' }; other.tools[0]!.arguments = { path: '/work/a  b' } }
    expect(key(other)).not.toBe(key(original))
  })
})
