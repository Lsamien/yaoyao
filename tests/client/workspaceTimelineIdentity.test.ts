import { expect, it } from 'vitest'
import { buildMessageTimelineRows } from '@/utils/turnTrace'
import type { UiMessage } from '@/components/messages/types'

it('keeps settled Bot message bodies stable without changing mutable ordinary-chat callers', () => {
  const settled: UiMessage = { id: 'old', role: 'assistant', content: '历史正文', status: 'settled' }
  const live: UiMessage = { id: 'live', role: 'assistant', content: '正在', status: 'streaming' }
  const bodies = new WeakMap<UiMessage, UiMessage>()
  const before = buildMessageTimelineRows([settled, live], bodies)
  const after = buildMessageTimelineRows([settled, { ...live, content: '正在更新' }], bodies)
  expect(after[0]!.kind === 'message' && after[0]!.message).toBe(before[0]!.kind === 'message' && before[0]!.message)
  expect(after[1]!.kind === 'message' && after[1]!.message).not.toBe(before[1]!.kind === 'message' && before[1]!.message)
  live.content = '原地更新的普通聊天'
  const ordinary = buildMessageTimelineRows([live])
  expect(ordinary[0]!.kind === 'message' && ordinary[0]!.message.content).toBe(live.content)
})
