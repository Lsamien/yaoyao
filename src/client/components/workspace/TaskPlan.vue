<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import type { AgentAssignment, AgentGoal } from '@shared/agentTasks'
import type { WorkspaceAgent } from '@shared/workspace'
import AppIcon from '@/components/common/AppIcon.vue'
const props = defineProps<{
  goal?: AgentGoal
  assignments: AgentAssignment[]
  agents: WorkspaceAgent[]
  saveCriteria?: (goalId: string, expectedRevision: number, acceptanceCriteria: string[]) => Promise<void>
}>()
defineEmits<{ stop: []; resume: [] }>()
const labels: Record<string, string> = { pending: '待执行', running: '进行中', review: '待复核', complete: '已完成', failed: '执行失败', blocked: '遇到阻碍', cancelling: '正在停止', cancelled: '已停止', waiting: '需要补充信息' }
const completed = computed(() => props.assignments.filter(a => a.status === 'complete').length)
const progress = computed(() => props.assignments.length ? Math.round(completed.value / props.assignments.length * 100) : props.goal?.status === 'complete' ? 100 : 0)
const editable = computed(() => !!props.saveCriteria && !!props.goal && ['running', 'review', 'waiting'].includes(props.goal.status))
const expanded = ref(false)
const contentId = useId()
const editing = ref(false), saving = ref(false), draft = ref(''), error = ref('')
const editor = ref<HTMLTextAreaElement>(), editButton = ref<HTMLButtonElement>()
let revision = 1
watch(() => props.goal?.id ?? props.assignments[0]?.goalId ?? '', () => {
  expanded.value = false
  editing.value = false
  error.value = ''
})
async function edit() {
  if (!props.goal) return
  draft.value = props.goal.acceptanceCriteria.join('\n')
  revision = props.goal.acceptanceRevision ?? 1
  error.value = ''
  editing.value = true
  await nextTick()
  editor.value?.focus()
}
async function closeEditor() {
  editing.value = false
  await nextTick()
  editButton.value?.focus()
}
async function save() {
  if (!props.goal || !props.saveCriteria || saving.value) return
  const criteria = draft.value.split('\n').map(line => line.trim()).filter(Boolean)
  if (!criteria.length || criteria.length > 12 || criteria.some(line => line.length > 1000)) {
    error.value = '请填写 1 至 12 条验收要求，每条不超过 1000 字。'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await props.saveCriteria(props.goal.id, revision, criteria)
    await closeEditor()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { saving.value = false }
}
</script>
<template>
  <section v-if="goal || assignments.length" class="task-plan" :class="{ 'task-plan--expanded': expanded }" aria-label="目标进度">
    <header class="task-plan__header">
      <button class="task-plan__disclosure" type="button" :aria-expanded="expanded" :aria-controls="contentId" @click="expanded = !expanded">
        <span class="task-plan__icon"><AppIcon name="files" :size="17" /></span>
        <span class="task-plan__heading">
          <strong>交付进展</strong>
          <span v-if="goal" class="task-plan__status"><i />{{ labels[goal.status] }}</span>
        </span>
        <strong v-if="assignments.length" class="task-plan__count">{{ completed }}/{{ assignments.length }} <small>项完成</small></strong>
        <AppIcon class="task-plan__header-chevron" name="chevron-down" :size="15" />
      </button>
      <div class="task-plan__actions">
        <button v-if="goal && ['running','review','waiting'].includes(goal.status)" type="button" @click="$emit('stop')">停止任务</button>
        <button v-if="goal && ['blocked','waiting','cancelled'].includes(goal.status)" type="button" @click="$emit('resume')">继续任务</button>
      </div>
    </header>

    <div v-if="expanded" :id="contentId" class="task-plan__content">
      <div v-if="assignments.length" class="task-plan__progress" role="progressbar" aria-label="交付完成进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="progress">
        <span v-for="item in assignments" :key="item.id" :class="{ complete: item.status === 'complete', active: ['running','review'].includes(item.status), failed: ['failed','blocked'].includes(item.status) }" />
      </div>
      <div v-if="assignments.length" class="task-plan__steps" aria-label="任务步骤">
        <div v-for="(item, index) in assignments" :key="item.id" :class="{ complete: item.status === 'complete', active: ['running','review'].includes(item.status), failed: ['failed','blocked'].includes(item.status) }">
          <span><AppIcon v-if="item.status === 'complete'" name="check" :size="11" /><template v-else>{{ index + 1 }}</template></span>
          <strong>{{ item.title }}</strong>
        </div>
      </div>

      <div v-if="goal?.result" class="task-plan__result">
        <small>最新结果</small>
        <p class="result">{{ goal.result }}</p>
      </div>
      <details>
        <summary><AppIcon name="file" :size="15" /><span>任务与验收详情</span><AppIcon class="task-plan__chevron" name="chevron-down" :size="14" /></summary>
        <div class="plan-details">
          <p v-if="goal" class="objective">{{ goal.objective }}</p>
          <ol v-if="assignments.length">
            <li v-for="item in assignments" :key="item.id">
              <div><strong>{{ item.title }}</strong><span>{{ labels[item.status] }}</span></div>
              <small>{{ agents.find(a => a.id === item.agentId)?.name || '成员不可用' }}<template v-if="agents.find(a => a.id === item.agentId)?.temporaryGoalId"> · 临时助手{{ agents.find(a => a.id === item.agentId)?.archived ? (agents.find(a => a.id === item.agentId)?.cleanupState === 'pending' ? '（已退役，等待清理）' : '（已退役）') : '' }}</template></small>
              <p v-if="item.review">{{ item.review }}</p>
            </li>
          </ol>
          <form v-if="editing" @submit.prevent="save">
            <label>验收要求<textarea ref="editor" v-model="draft" :disabled="saving" rows="4" aria-describedby="criteria-help" /></label>
            <small id="criteria-help">每行一条，描述你需要的交付结果。</small>
            <p v-if="error" class="criteria-error" role="alert">{{ error }}</p>
            <div class="criteria-actions"><button type="submit" :disabled="saving || !editable">{{ saving ? '保存中…' : '保存验收要求' }}</button><button type="button" :disabled="saving" @click="closeEditor">取消</button></div>
          </form>
          <template v-else>
            <ul v-if="goal?.acceptanceCriteria.length" class="criteria">
              <li v-for="(criterion, index) in goal.acceptanceCriteria" :key="index">
                <span>{{ goal.checks?.some(check => check.criterion === index && check.passed) ? '已验收' : '待验收' }}</span> {{ criterion }}
              </li>
            </ul>
            <button v-if="editable" ref="editButton" type="button" @click="edit">调整验收要求</button>
          </template>
        </div>
      </details>
    </div>
  </section>
</template>
<style scoped>
.task-plan {
  width: 100%;
  max-width: 760px;
  margin: 0 auto 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--surface-raised);
  box-shadow: 0 6px 22px color-mix(in srgb, var(--text-primary) 5%, transparent);
  box-sizing: border-box;
  font-size: 13px;
}
.task-plan__header { display: flex; min-height: 58px; align-items: center; gap: 6px; padding: 6px 8px; }
.task-plan__disclosure { display: flex; min-width: 0; min-height: 46px; flex: 1; align-items: center; gap: 11px; padding: 4px 6px; border: 0; border-radius: 10px; background: transparent; text-align: left; touch-action: manipulation; }
.task-plan__disclosure:hover { background: var(--surface-hover); }
.task-plan__icon { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 10px; background: var(--surface-soft); color: var(--text-secondary); }
.task-plan__heading { display: flex; min-width: 0; align-items: center; gap: 8px; }
.task-plan__heading > strong { color: var(--text-primary); font-size: 14px; font-weight: 650; white-space: nowrap; }
.task-plan__status { display: inline-flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.task-plan__status i { width: 6px; height: 6px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent); }
.task-plan__count { margin-left: auto; color: var(--text-primary); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-plan__count small { margin-left: 2px; color: var(--text-muted); font-size: 11px; font-weight: 450; }
.task-plan__header-chevron { flex: 0 0 auto; color: var(--text-muted); transition: transform 160ms ease; }
.task-plan--expanded .task-plan__header-chevron { transform: rotate(180deg); }
.task-plan__actions { display: flex; gap: 6px; }
.task-plan__actions:empty { display: none; }
.task-plan__actions button { min-height: 40px; padding-inline: 10px; border-color: transparent; color: var(--text-secondary); }
.task-plan__progress { display: grid; gap: 5px; grid-template-columns: repeat(auto-fit, minmax(28px, 1fr)); padding: 0 14px; }
.task-plan__progress span { height: 3px; border-radius: 999px; background: var(--line-strong); }
.task-plan__progress span.complete { background: var(--workflow-accent); }
.task-plan__progress span.active { background: color-mix(in srgb, var(--workflow-accent) 52%, var(--line)); }
.task-plan__progress span.failed { background: var(--danger); }
.task-plan__steps { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); padding: 10px 14px 13px; }
.task-plan__steps > div { display: flex; min-width: 0; align-items: center; gap: 7px; color: var(--text-muted); }
.task-plan__steps > div > span { display: grid; width: 20px; height: 20px; flex: 0 0 20px; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; background: var(--surface); color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.task-plan__steps > div.complete > span { border-color: var(--workflow-accent); background: var(--workflow-accent); color: var(--workflow-on-accent); }
.task-plan__steps > div.active > span { border-color: var(--workflow-accent); color: var(--workflow-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--workflow-accent) 14%, transparent); }
.task-plan__steps > div.failed > span { border-color: var(--danger); color: var(--danger); }
.task-plan__steps strong { min-width: 0; overflow: hidden; font-size: 11px; font-weight: 520; text-overflow: ellipsis; white-space: nowrap; }
.task-plan__steps .complete strong,
.task-plan__steps .active strong { color: var(--text-secondary); }
.task-plan__result { margin: 0 14px 12px; padding: 11px 12px; border-radius: 10px; background: var(--surface-soft); }
.task-plan__result > small { display: block; margin-bottom: 3px; color: var(--text-muted); font-size: 10px; font-weight: 620; }
.result { max-height: 12vh; margin: 0; overflow: auto; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
details { border-top: 1px solid var(--line); }
summary { display: flex; min-height: 46px; align-items: center; gap: 8px; padding: 0 14px; color: var(--text-secondary); cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary > span { flex: 1; font-size: 12px; font-weight: 520; }
.task-plan__chevron { transition: transform 160ms ease; }
details[open] .task-plan__chevron { transform: rotate(180deg); }
.plan-details { max-height: 34vh; overflow: auto; padding: 2px 14px 14px; }
.objective { color: var(--text-secondary); }
ol,.criteria { padding-left: 20px; margin-top: 0; }
li { padding: 7px 0; }
li div { display: flex; gap: 12px; justify-content: space-between; }
li div span { color: var(--text-secondary); white-space: nowrap; }
p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.criteria span { color: var(--text-secondary); font-size: 12px; }
button { min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--text-primary); cursor: pointer; font: inherit; }
button:hover:not(:disabled) { background: var(--surface-hover); }
button:disabled { cursor: default; opacity: .55; }
label { display: grid; gap: 8px; }
textarea { width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface); box-sizing: border-box; color: var(--text-primary); font: inherit; line-height: 1.5; resize: vertical; }
textarea:focus { border-color: var(--workflow-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--workflow-accent) 14%, transparent); }
.criteria-actions { display: flex; gap: 8px; margin-top: 10px; }
.criteria-error { color: var(--danger); }
summary:focus-visible,button:focus-visible { outline: 2px solid var(--workflow-accent); outline-offset: 2px; }

@media (max-width: 600px) {
  .task-plan { border-radius: 14px; }
  .task-plan__header { min-height: 56px; padding-inline: 6px; }
  .task-plan__disclosure { gap: 8px; padding-inline: 6px; }
  .task-plan__icon { display: none; }
  .task-plan__heading { align-items: flex-start; flex-direction: column; gap: 1px; }
  .task-plan__actions button { min-width: 44px; padding-inline: 8px; font-size: 12px; }
  .task-plan__progress { padding-inline: 12px; }
  .task-plan__steps { grid-auto-columns: minmax(78px, 1fr); grid-auto-flow: column; grid-template-columns: none; gap: 8px; padding-inline: 12px; overflow-x: auto; scrollbar-width: none; }
  .task-plan__steps::-webkit-scrollbar { display: none; }
  .task-plan__result { margin-inline: 12px; }
  summary { padding-inline: 12px; }
  .plan-details { padding-inline: 12px; }
}

@media (prefers-reduced-motion: reduce) { .task-plan__chevron,.task-plan__header-chevron { transition: none; } }
</style>
