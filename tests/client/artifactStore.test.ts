import { describe, expect, it } from 'vitest'
import type { ChatMessage, SessionSummary } from '@shared/types'
import { extractArtifacts } from '@/utils/artifacts'

const session: SessionSummary = {
  id: 'session-1', profile: 'yaoyao', source: 'web', title: '产物会话', messageCount: 4,
  toolCallCount: 1, startedAt: 1, updatedAt: 5,
}

function row(id: string, role: ChatMessage['role'], content: string, extras: Partial<ChatMessage> = {}): ChatMessage {
  return { id, sessionId: session.id, profile: session.profile, role, content, timestamp: 2, stage: 'settled', ...extras }
}

describe('artifact extractor', () => {
  it('extracts assistant markdown with readable link titles and ignores user rows', () => {
    const artifacts = extractArtifacts(session, [
      row('user', 'user', '[不要收集](https://private.example/user)'),
      row('assistant', 'assistant', '查看 [发布说明](https://example.com/releases/v1) 和 ![图](/tmp/chart.png)'),
    ])
    expect(artifacts.map(item => item.value)).toEqual(expect.arrayContaining(['https://example.com/releases/v1', '/tmp/chart.png']))
    expect(artifacts.find(item => item.kind === 'link')?.label).toBe('发布说明')
    expect(artifacts.find(item => item.kind === 'image')?.label).toBe('chart.png')
  })

  it('preserves structured attachment metadata for preview', () => {
    const artifacts = extractArtifacts(session, [row('assistant', 'assistant', '', {
      attachments: [{ id: 'attachment-1', name: 'demo.mp4', mimeType: 'video/mp4', size: 10, path: '/tmp/demo.mp4', kind: 'file' }],
    })])
    expect(artifacts[0]).toMatchObject({ kind: 'file', value: '/tmp/demo.mp4', mimeType: 'video/mp4' })
    expect(artifacts[0].attachment?.id).toBe('attachment-1')
  })

  it('excludes files mentioned only in tool results', () => {
    const artifacts = extractArtifacts(session, [row('tool', 'tool', '{"output_path":"/tmp/result.pdf"}', {
      toolCalls: [{ id: 'tool-1', name: 'write', status: 'completed', result: { output_path: '/tmp/result.pdf' } }],
    })])
    expect(artifacts).toEqual([])
  })

  it('collects the delivered body while ignoring reasoning and attached tool details', () => {
    const artifacts = extractArtifacts(session, [row('assistant', 'assistant',
      '<think>[过程](/tmp/private.pdf)</think>[交付](/tmp/result.pdf)', {
        reasoning: '![过程图片](/tmp/process.png)',
        toolCalls: [{ id: 'tool', name: 'read', status: 'completed', arguments: { path: '/tmp/input.pdf' }, result: { path: '/tmp/result.pdf' }, preview: '/tmp/preview.pdf' }],
      })])
    expect(artifacts.map(item => item.value)).toEqual(['/tmp/result.pdf'])
    expect(artifacts[0].messageId).toBe('assistant')
  })

  it('keeps the same artifact path when it was produced by distinct messages', () => {
    const artifacts = extractArtifacts(session, [
      row('assistant-1', 'assistant', '[第一版](/tmp/result.pdf)'),
      row('assistant-2', 'assistant', '[第二版](/tmp/result.pdf)', { timestamp: 3 }),
    ])
    expect(artifacts).toHaveLength(2)
    expect(artifacts.map(item => item.messageId)).toEqual(['assistant-1', 'assistant-2'])
    expect(new Set(artifacts.map(item => item.id)).size).toBe(2)
  })
})
