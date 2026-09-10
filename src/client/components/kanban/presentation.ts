import type { KanbanEvent } from '@/api/kanban'

export const KANBAN_STATUS_META: Record<string, { label: string; color: string; description: string }> = {
  triage: { label: '待分诊', color: '#8b8b86', description: '需要补充或拆解的任务' },
  todo: { label: '待办', color: '#68727e', description: '已明确但尚未进入执行队列' },
  scheduled: { label: '已计划', color: '#8b5cf6', description: '由系统在指定时间唤醒' },
  ready: { label: '就绪', color: '#1677ff', description: '等待调度器分配机器人' },
  running: { label: '进行中', color: '#1a9a68', description: '机器人正在处理' },
  blocked: { label: '已阻塞', color: '#d44848', description: '等待外部输入或恢复' },
  review: { label: '评审中', color: '#c58a15', description: '等待人工或机器人评审' },
  done: { label: '已完成', color: '#66756d', description: '已经完成的任务' },
  archived: { label: '已归档', color: '#999994', description: '已从活动看板移除' },
}

export const LOCKED_KANBAN_TARGETS = new Set(['scheduled', 'running', 'review', 'archived'])

export function statusMeta(status: string) {
  return KANBAN_STATUS_META[status] ?? { label: status, color: '#7c7c78', description: status }
}

export function movableStatuses(columns: string[], current: string): string[] {
  const values = columns.includes(current) ? columns : [current, ...columns]
  return values.filter((status, index) => values.indexOf(status) === index
    && (status === current || !LOCKED_KANBAN_TARGETS.has(status)))
}

export function formatKanbanTime(seconds?: number | null): string {
  if (!seconds) return ''
  const milliseconds = seconds < 10_000_000_000 ? seconds * 1_000 : seconds
  const difference = Date.now() - milliseconds
  if (difference < 60_000) return '刚刚'
  if (difference < 3_600_000) return `${Math.max(1, Math.floor(difference / 60_000))} 分钟前`
  if (difference < 86_400_000) return `${Math.max(1, Math.floor(difference / 3_600_000))} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(milliseconds))
}

function eventPayload(event: KanbanEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    return event.payload as Record<string, unknown>
  }
  if (typeof event.payload !== 'string') return {}
  try {
    const parsed = JSON.parse(event.payload) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

export function eventDescription(event: KanbanEvent): string {
  const payload = eventPayload(event)
  const text = (key: string) => typeof payload[key] === 'string' ? payload[key] as string : ''
  if (event.kind === 'created') return `创建任务${text('assignee') ? `，分配给 ${text('assignee')}` : ''}`
  if (event.kind === 'status') return `移动到 ${statusMeta(text('status')).label}`
  if (event.kind === 'assigned') return text('assignee') ? `分配给 ${text('assignee')}` : '取消分配'
  if (event.kind === 'commented') return `添加评论${text('author') ? ` · ${text('author')}` : ''}`
  if (event.kind === 'claimed' || event.kind === 'spawned') return '机器人开始处理'
  if (event.kind === 'completed') return '任务完成'
  if (event.kind === 'blocked') return `任务阻塞${text('reason') ? ` · ${text('reason')}` : ''}`
  if (event.kind === 'unblocked') return '任务已恢复'
  if (event.kind === 'reclaimed') return '运行已回收'
  return event.kind.replaceAll('_', ' ')
}
