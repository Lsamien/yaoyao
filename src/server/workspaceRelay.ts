import { createHash } from 'node:crypto'
import type { WorkspaceAgent, WorkspaceMessage } from '../shared/workspace.js'
import { mentionableText, mentionedAgents } from './workspaceMentions.js'

type Member = Pick<WorkspaceAgent, 'id' | 'name'>
export const REPEATED_RELAY_NOTICE = '检测到重复协作，已停止重复分支；其他已安排工作继续执行。'

// Deliberately anchored: a receipt followed by an unfamiliar clause or a new
// instruction must retain the old routing behavior, not guess that work is done.
function acknowledgement(text: string, allowReceipt = true): boolean {
  if (/^(?:(?:终审|审核|复核|验收|任务|工作|本轮)(?:已|已经)?\s*)?(?:已|已经|仍|维持|继续维持)?(?:通过|完成|结束|确认|保持不变|不变)(?:了|啦)?$/u.test(text)) return true
  if (/^(?:无|没有|暂无)(?:新事实|新任务|新派工|新工作|新进展)$/u.test(text)) return true
  if (/^(?:本轮)?(?:无需|不用|不要|不必|不再|不)(?:再|继续|重复)?(?:处理|回复|核验|确认|派工|协作|跟进)$/u.test(text)) return true
  if (/^(?:等|等待|等候|待)(?:(?:用户|人类|你|您|[\p{L}\p{N}]{1,12}(?:哥|姐|老师|先生|女士))(?:的)?)?(?:新|进一步|下一步|群发|发布)?(?:指令|指示)(?:即可)?$/u.test(text)) return true
  if (/^(?:等待|等候)(?:用户|人类|你|您)(?:的)?(?:确认|回复)$/u.test(text)) return true
  if (/^(?:acknowledged|received|noted|thanks|thank you|approved|done|completed|no new (?:tasks?|work)|waiting for (?:the )?(?:user|your) (?:instructions?|input|confirmation))$/iu.test(text)) return true
  const receipt = allowReceipt && /^(?:已收到|收到|谢谢|感谢|已阅|知悉|明白|了解|好的?)(?:了)?\s*(.*)$/u.exec(text)
  return !!receipt && (!receipt[1] || /^(?:你|您)?的?(?:结果|回复|反馈|确认|消息|通知|意见|结论)$/u.test(receipt[1]) || acknowledgement(receipt[1], false))
}

function reportLabel(text: string): boolean {
  // Quoted paths/IDs were removed by mentionableText. These labels merely
  // accompany a closing receipt; by themselves they never end a discussion.
  return /^(?:交付状态[（(]不变[）)]|发布目录|交付目录|产物目录|入草稿箱(?:\s*Media\s*ID)?)\s*[:：]?$/iu.test(text)
}

/** Only assistant output uses this policy. User mentions keep their exact API. */
export function botRelayIntent(text: string, members: Member[]): {
  mentionedIds: string[]; targetIds: string[]; acknowledgementOnly: boolean
} {
  const plain = mentionableText(text).replace(/\*\*|__/g, '')
  const mentionedIds = mentionedAgents(plain, members)
  const names = [...members.map(m => m.name), 'all', '所有人'].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(?<![A-Za-z0-9_.%+/@-])@(?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_])`, 'giu')
  const targets = new Set<string>(), receipts = new Set<string>()
  let subject: string[] = [], hasReceipt = false, allClosing = true, unscopedAction = false
  for (const clause of plain.split(/[,，、。！？!?;；:：\n]+/u).map(s => s.trim()).filter(Boolean)) {
    const named = mentionedAgents(clause, members)
    if (named.length) subject = named
    const body = clause.replace(pattern, '').replace(/^[\s\-•]+|[\s.:：~～]+$/gu, '').trim()
    const closing = acknowledgement(body), label = reportLabel(body)
    if (closing) { hasReceipt = true; for (const id of subject) receipts.add(id) }
    else if (!label) {
      allClosing = false
      if (!subject.length) unscopedAction = true
      for (const id of subject) targets.add(id)
    }
  }
  return {
    mentionedIds,
    targetIds: mentionedIds.filter(id => unscopedAction || targets.has(id) || !receipts.has(id)),
    acknowledgementOnly: hasReceipt && allClosing,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}

function prose(text: string): string {
  // Formatting whitespace is not progress, but whitespace within code, paths
  // and business tool arguments/results may be significant. Leave those intact.
  return text.normalize('NFC').split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`)/g)
    .map((part, index) => index % 2 ? part : part.replace(/\s+/gu, ' ')).join('').trim()
}

/** Strip transport metadata only at the envelope level. IDs/times inside a
 * tool's arguments or result are business data and must still count as change. */
function toolValue(tool: Record<string, unknown>): unknown {
  const metadata = new Set(['id', 'tool_id', 'call_id', 'callId', 'tool_call_id', 'request_id', 'requestId', 'event_id', 'eventId', 'session_id', 'turn_id', 'timestamp', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'duration', 'durationMs', 'elapsedMs'])
  return Object.fromEntries(Object.entries(tool).filter(([key]) => !metadata.has(key)))
}

export function relayMessageValue(message: WorkspaceMessage): unknown {
  return {
    role: message.role, agentId: message.agentId, content: prose(message.content), status: message.status, error: message.error,
    tools: message.tools.map(toolValue),
    // An artifact ID identifies a real deliverable, unlike a message/event ID.
    attachments: message.attachments.map(({ createdAt: _time, conversationId: _chat, messageId: _message, ...file }) => file),
  }
}

export function relayFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
