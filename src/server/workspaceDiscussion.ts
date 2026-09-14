import type { WorkspaceConversation, WorkspaceRun } from '../shared/workspace.js'
import { HttpError } from './errors.js'

export function isDiscussion(c: Pick<WorkspaceConversation, 'kind' | 'collaborationMode'>): boolean {
  return c.kind === 'group' && c.collaborationMode === 'discussion'
}
const chineseNumbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
export function discussionRounds(text: string, explicit?: number): number {
  const match = /(?:讨论|进行|开展|共|总共|恰好|只)?\s*(\d+|十二|十一|十|[一二两三四五六七八九])\s*轮|\b(\d+)\s+rounds?\b/iu.exec(text)
  const requested = explicit ?? (match ? chineseNumbers[match[1]!] ?? Number(match[1] ?? match[2]) : undefined)
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > 12) throw new HttpError(400, '讨论轮数需要在 1 至 12 之间', 'discussion_rounds_invalid')
    return requested
  }
  return /讨论|商量|协作|开会|辩论|评审|互评|多轮|\b(?:discuss|debate|review|collaborate)\b/iu.test(text) ? 2 : 1
}
export function discussionOrder(discussion: NonNullable<WorkspaceRun['discussion']>): Array<{ agentId: string; round: number }> {
  const result: Array<{ agentId: string; round: number }> = []
  for (let round = 0; round < discussion.rounds; round++) {
    for (let index = 0; index < discussion.memberIds.length; index++) result.push({ agentId: discussion.memberIds[(index + round) % discussion.memberIds.length]!, round })
  }
  return result
}
