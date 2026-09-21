import type { UiMessage } from '@/components/messages/types'

/** System events are navigation/disclosures, never part of an assistant's prose. */
export type SystemNoticeIcon = 'info' | 'branch' | 'groups' | 'tools' | 'archive' | 'check' | 'settings' | 'file' | 'brain'

export function systemMessageNotice(message: UiMessage): { title: string; icon: SystemNoticeIcon } | undefined {
  if (message.communication || message.role === 'user') return
  if (message.timelineKind === 'delegation-complete') return { title: '子任务已完成', icon: 'groups' }
  if (message.timelineKind === 'background-process') {
    const code = message.timelineMetadata?.exit_code
    const signal = message.timelineMetadata?.signal
    return { title: signal ? '后台子任务已终止' : code === undefined || code === null ? '后台子任务已结束' : Number(code) === 0 ? '后台子任务已完成' : '后台子任务失败', icon: 'tools' }
  }
  if (message.role !== 'system' && message.timelineKind !== 'system') return
  const content = message.content.trim()
  if (message.timelineMetadata?.eventKind === 'compaction' || /^\[context compaction/i.test(content)) return { title: '上下文已压缩', icon: 'archive' }
  if (/^(?:由管理员分派的子任务|(?:已)?分派(?:了)?(?:终审|子)?任务)/.test(content)) return { title: '已分派子任务', icon: 'branch' }
  if (/^执行失败[：:]/.test(content)) return { title: /timeout|timed?\s*out|超时|no SSE events/i.test(content) ? '响应超时' : '回复暂时中断', icon: 'info' }
  if (/^(?:回复重点|重点提示)[：:]?/.test(content)) return { title: '回复重点', icon: 'info' }
  if (/^(?:任务|子任务).*(?:已完成|完成通知)/.test(content.split('\n')[0] || '')) return { title: '任务已完成', icon: 'check' }
  const model = content.match(/(?:changed to|切换为)\s*([^\s，。\]]+?)(?=\s+via\b|\s*$|\])/i)?.[1]
  return { title: model ? '模型已切换' : '系统提示', icon: model ? 'settings' : 'info' }
}
