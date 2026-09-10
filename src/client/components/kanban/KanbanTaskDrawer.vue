<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { KanbanProfile, KanbanTaskDetail, UpdateKanbanTaskInput } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'
import { eventDescription, formatKanbanTime, movableStatuses, statusMeta } from './presentation'

const props = defineProps<{
  detail?: KanbanTaskDetail
  profiles: KanbanProfile[]
  columns: string[]
  canEdit: boolean
  busy?: boolean
  loading?: boolean
  error?: string
}>()

const emit = defineEmits<{
  save: [input: UpdateKanbanTaskInput]
  comment: [body: string]
  delete: []
}>()

const title = ref('')
const body = ref('')
const status = ref('')
const assignee = ref('')
const priority = ref(0)
const comment = ref('')
const draftTaskId = ref('')

interface TaskDraft {
  title: string
  body: string
  status: string
  assignee: string
  priority: number
}

const baseline = ref<TaskDraft>({ title: '', body: '', status: '', assignee: '', priority: 0 })

const task = computed(() => props.detail?.task)
const statuses = computed(() => movableStatuses(props.columns, task.value?.status || status.value))
const dirty = computed(() => Boolean(task.value) && (
  title.value.trim() !== baseline.value.title
  || body.value !== baseline.value.body
  || status.value !== baseline.value.status
  || assignee.value !== baseline.value.assignee
  || Number(priority.value || 0) !== baseline.value.priority
))

function taskDraft(value: NonNullable<typeof task.value>): TaskDraft {
  return {
    title: value.title || '',
    body: value.body || '',
    status: value.status,
    assignee: value.assignee || '',
    priority: Number(value.priority || 0),
  }
}

function applyTask(value: NonNullable<typeof task.value>): void {
  const next = taskDraft(value)
  draftTaskId.value = value.id
  title.value = next.title
  body.value = next.body
  status.value = next.status
  assignee.value = next.assignee
  priority.value = next.priority
  baseline.value = next
}

function reconcileTask(value: NonNullable<typeof task.value>): void {
  const remote = taskDraft(value)
  const previous = baseline.value
  const reconcile = <T,>(local: T, old: T, next: T): [T, T] => (
    local === old || local === next ? [next, next] : [local, old]
  )
  const [nextTitle, titleBaseline] = reconcile(title.value.trim(), previous.title, remote.title)
  const [nextBody, bodyBaseline] = reconcile(body.value, previous.body, remote.body)
  const [nextStatus, statusBaseline] = reconcile(status.value, previous.status, remote.status)
  const [nextAssignee, assigneeBaseline] = reconcile(assignee.value, previous.assignee, remote.assignee)
  const [nextPriority, priorityBaseline] = reconcile(Number(priority.value || 0), previous.priority, remote.priority)
  title.value = nextTitle
  body.value = nextBody
  status.value = nextStatus
  assignee.value = nextAssignee
  priority.value = nextPriority
  baseline.value = {
    title: titleBaseline,
    body: bodyBaseline,
    status: statusBaseline,
    assignee: assigneeBaseline,
    priority: priorityBaseline,
  }
}

watch(() => props.detail?.task, value => {
  if (!value) return
  if (value.id !== draftTaskId.value) applyTask(value)
  else reconcileTask(value)
}, { immediate: true })

function save(): void {
  if (!task.value || !title.value.trim() || props.busy) return
  const input: UpdateKanbanTaskInput = {}
  if (title.value.trim() !== baseline.value.title) input.title = title.value.trim()
  if (body.value !== baseline.value.body) input.body = body.value
  if (status.value !== baseline.value.status) input.status = status.value
  if (assignee.value !== baseline.value.assignee) input.assignee = assignee.value
  if (Number(priority.value || 0) !== baseline.value.priority) input.priority = Number(priority.value) || 0
  if (Object.keys(input).length) emit('save', input)
}

function sendComment(): void {
  if (!comment.value.trim() || props.busy) return
  emit('comment', comment.value.trim())
  comment.value = ''
}

function metadataText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
</script>

<template>
  <div class="kanban-task-drawer">
    <div v-if="loading && !detail" class="kanban-task-drawer__state">正在读取任务…</div>
    <div v-else-if="error && !detail" class="kanban-task-drawer__state kanban-task-drawer__state--error">{{ error }}</div>
    <template v-else-if="detail && task">
      <header>
        <div><small>{{ task.id }}</small><h2>{{ task.title }}</h2></div>
        <span class="kanban-status" :style="{ '--status-tone': statusMeta(task.status).color }"><i />{{ statusMeta(task.status).label }}</span>
      </header>

      <div v-if="!canEdit" class="kanban-readonly-note"><AppIcon name="alert" :size="14" />当前账号可查看看板，编辑仅限管理员。</div>
      <form class="kanban-task-form" @submit.prevent="save">
        <label><span>标题</span><input v-model="title" :disabled="!canEdit" maxlength="500" required /></label>
        <label><span>描述</span><textarea v-model="body" :disabled="!canEdit" rows="5" placeholder="暂无描述" /></label>
        <div class="kanban-task-form__grid">
          <label><span>状态</span><select v-model="status" :disabled="!canEdit"><option v-for="value in statuses" :key="value" :value="value">{{ statusMeta(value).label }}</option></select></label>
          <label><span>分配给</span><select v-model="assignee" :disabled="!canEdit"><option value="">暂不分配</option><option v-for="profile in profiles" :key="profile.name" :value="profile.name">{{ profile.name }}</option></select></label>
          <label><span>优先级</span><input v-model.number="priority" :disabled="!canEdit" type="number" min="-1000" max="1000" /></label>
          <div class="kanban-task-static"><span>租户</span><strong>{{ task.tenant || '无' }}</strong></div>
        </div>
        <p v-if="error" class="kanban-task-error" role="alert">{{ error }}</p>
        <div v-if="canEdit" class="kanban-task-form__actions"><button type="button" class="danger-button" :disabled="busy" @click="emit('delete')"><AppIcon name="trash" :size="13" />删除</button><button type="submit" class="primary-button" :disabled="busy || !title.trim() || !dirty">{{ busy ? '保存中…' : '保存更改' }}</button></div>
      </form>

      <section v-if="task.latest_summary || task.result" class="kanban-detail-section">
        <h3>结果与交接</h3>
        <p v-if="task.latest_summary">{{ task.latest_summary }}</p>
        <p v-if="task.result && task.result !== task.latest_summary">{{ task.result }}</p>
      </section>

      <section v-if="task.diagnostics?.length" class="kanban-detail-section kanban-detail-section--warning">
        <h3>诊断</h3>
        <article v-for="diagnostic in task.diagnostics" :key="`${diagnostic.kind}:${diagnostic.last_seen_at}`"><strong>{{ diagnostic.title }}</strong><p>{{ diagnostic.detail }}</p></article>
      </section>

      <section class="kanban-detail-section">
        <h3>评论 <span>{{ detail.comments.length }}</span></h3>
        <div v-if="detail.comments.length" class="kanban-comments">
          <article v-for="item in detail.comments" :key="item.id"><header><strong>{{ item.author }}</strong><time>{{ formatKanbanTime(item.created_at) }}</time></header><p>{{ item.body }}</p></article>
        </div>
        <p v-else class="kanban-empty-copy">还没有评论。</p>
        <form v-if="canEdit" class="kanban-comment-form" @submit.prevent="sendComment"><textarea v-model="comment" rows="3" placeholder="补充上下文或给机器人留言" /><button type="submit" :disabled="busy || !comment.trim()">添加评论</button></form>
      </section>

      <section class="kanban-detail-section">
        <h3>运行记录 <span>{{ detail.runs.length }}</span></h3>
        <div v-if="detail.runs.length" class="kanban-runs">
          <article v-for="run in detail.runs" :key="run.id"><header><strong>{{ run.profile || '未指定机器人' }}</strong><span>{{ run.outcome || run.status }}</span></header><p v-if="run.summary">{{ run.summary }}</p><p v-if="run.error" class="run-error">{{ run.error }}</p><pre v-if="metadataText(run.metadata)">{{ metadataText(run.metadata) }}</pre><time>{{ formatKanbanTime(run.started_at) }}<template v-if="run.ended_at"> → {{ formatKanbanTime(run.ended_at) }}</template></time></article>
        </div>
        <p v-else class="kanban-empty-copy">尚未产生运行记录。</p>
      </section>

      <section class="kanban-detail-section">
        <h3>活动 <span>{{ detail.events.length }}</span></h3>
        <ol class="kanban-events"><li v-for="event in [...detail.events].reverse()" :key="event.id"><i /><div><strong>{{ eventDescription(event) }}</strong><time>{{ formatKanbanTime(event.created_at) }}</time></div></li></ol>
      </section>
    </template>
  </div>
</template>

<style scoped>
.kanban-task-drawer { height: 100%; min-height: 0; overflow-y: auto; background: var(--surface); }.kanban-task-drawer__state { display: grid; min-height: 260px; place-items: center; padding: 24px; color: var(--text-muted); font-size: 11px; }.kanban-task-drawer__state--error { color: var(--danger); }
.kanban-task-drawer > header { display: flex; min-height: 73px; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 15px 50px 13px 16px; border-bottom: 1px solid var(--line); }.kanban-task-drawer > header small { color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 8px; }.kanban-task-drawer > header h2 { margin: 4px 0 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }.kanban-status { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 5px 7px; border-radius: 7px; background: color-mix(in srgb, var(--status-tone) 11%, transparent); color: var(--status-tone); font-size: 8px; font-weight: 750; }.kanban-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.kanban-readonly-note { display: flex; align-items: center; gap: 6px; margin: 12px 14px 0; padding: 9px 10px; border-radius: 9px; background: var(--surface-soft); color: var(--text-secondary); font-size: 10px; line-height: 1.45; }.kanban-task-form { display: flex; flex-direction: column; gap: 11px; padding: 14px; border-bottom: 1px solid var(--line); }.kanban-task-form label { display: flex; flex-direction: column; gap: 5px; }.kanban-task-form label > span, .kanban-task-static > span { color: var(--text-muted); font-size: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }.kanban-task-form input, .kanban-task-form textarea, .kanban-task-form select, .kanban-comment-form textarea { width: 100%; min-height: 36px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--surface-raised); color: var(--text-primary); font: inherit; font-size: 11px; }.kanban-task-form textarea, .kanban-comment-form textarea { resize: vertical; line-height: 1.5; }.kanban-task-form input:focus, .kanban-task-form textarea:focus, .kanban-task-form select:focus, .kanban-comment-form textarea:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.kanban-task-form input:disabled, .kanban-task-form textarea:disabled, .kanban-task-form select:disabled { opacity: .8; }.kanban-task-form__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }.kanban-task-static { display: flex; min-width: 0; flex-direction: column; gap: 5px; }.kanban-task-static strong { min-height: 36px; padding: 9px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; color: var(--text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.kanban-task-form__actions { display: flex; justify-content: space-between; gap: 8px; }.kanban-task-form__actions button { display: flex; min-height: 34px; align-items: center; gap: 5px; padding: 0 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 10px; font-weight: 700; }.danger-button { border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); background: transparent; color: var(--danger); }.primary-button { margin-left: auto; border: 1px solid var(--accent); background: var(--accent); color: white; }.kanban-task-error { margin: 0; color: var(--danger); font-size: 10px; }
.kanban-detail-section { padding: 14px; border-bottom: 1px solid var(--line); }.kanban-detail-section > h3 { margin: 0 0 10px; color: var(--text-secondary); font-size: 9px; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }.kanban-detail-section > h3 span { margin-left: 4px; color: var(--text-muted); font-weight: 500; }.kanban-detail-section > p, .kanban-detail-section article p { margin: 0; color: var(--text-secondary); font-size: 10.5px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }.kanban-detail-section--warning { background: color-mix(in srgb, var(--warning) 5%, transparent); }.kanban-detail-section--warning article + article { margin-top: 9px; }.kanban-detail-section--warning article strong { color: var(--text-primary); font-size: 10px; }
.kanban-comments, .kanban-runs { display: flex; flex-direction: column; gap: 8px; }.kanban-comments article, .kanban-runs article { padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-raised); }.kanban-comments article header, .kanban-runs article header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }.kanban-comments article strong, .kanban-runs article strong { font-size: 9.5px; }.kanban-comments time, .kanban-runs time { color: var(--text-muted); font-size: 8px; }.kanban-comment-form { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }.kanban-comment-form button { min-height: 34px; align-self: flex-end; padding: 0 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 10px; font-weight: 700; }.kanban-runs article header span { color: var(--text-muted); font-size: 8px; }.kanban-runs pre { max-height: 120px; margin: 7px 0; padding: 7px; overflow: auto; border-radius: 7px; background: var(--surface-soft); color: var(--text-secondary); font-size: 8px; white-space: pre-wrap; }.kanban-runs .run-error { color: var(--danger); }.kanban-empty-copy { color: var(--text-muted) !important; }
.kanban-events { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }.kanban-events li { display: grid; grid-template-columns: 10px 1fr; gap: 7px; min-height: 34px; }.kanban-events li > i { width: 6px; height: 6px; margin-top: 4px; border: 1px solid var(--line-strong); border-radius: 50%; background: var(--surface); }.kanban-events li:not(:last-child) > i::after { display: block; width: 1px; height: 28px; margin: 6px 0 0 2px; background: var(--line); content: ''; }.kanban-events li div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }.kanban-events strong { color: var(--text-secondary); font-size: 9.5px; font-weight: 600; }.kanban-events time { color: var(--text-muted); font-size: 8px; }
@media (max-width: 600px) { .kanban-task-drawer > header { padding-left: 14px; }.kanban-task-form input, .kanban-task-form textarea, .kanban-task-form select, .kanban-comment-form textarea { min-height: 42px; font-size: 16px; }.kanban-task-form__grid { grid-template-columns: 1fr; }.kanban-task-form__actions button, .kanban-comment-form button { min-height: 42px; } }
</style>
