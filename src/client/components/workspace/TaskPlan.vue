<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { AgentAssignment, AgentGoal } from '@shared/agentTasks'
import type { WorkspaceAgent } from '@shared/workspace'
const props = defineProps<{
  goal?: AgentGoal
  assignments: AgentAssignment[]
  agents: WorkspaceAgent[]
  saveCriteria?: (goalId: string, expectedRevision: number, acceptanceCriteria: string[]) => Promise<void>
}>()
defineEmits<{ stop: []; resume: [] }>()
const labels: Record<string, string> = { pending: '待执行', running: '进行中', review: '待复核', complete: '已完成', failed: '执行失败', blocked: '遇到阻碍', cancelling: '正在停止', cancelled: '已停止', waiting: '需要补充信息' }
const completed = computed(() => props.assignments.filter(a => a.status === 'complete').length)
const editable = computed(() => !!props.saveCriteria && !!props.goal && ['running', 'review', 'waiting'].includes(props.goal.status))
const editing = ref(false), saving = ref(false), draft = ref(''), error = ref('')
const editor = ref<HTMLTextAreaElement>(), editButton = ref<HTMLButtonElement>()
let revision = 1
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
  <section v-if="goal || assignments.length" class="task-plan" aria-label="目标进度">
    <header>
      <strong>交付进展</strong>
      <span v-if="goal">{{ labels[goal.status] }}</span>
      <small v-if="assignments.length">{{ completed }}/{{ assignments.length }} 项完成</small>
      <button v-if="goal && ['running','review','waiting'].includes(goal.status)" type="button" @click="$emit('stop')">停止任务</button>
      <button v-if="goal && ['blocked','waiting','cancelled'].includes(goal.status)" type="button" @click="$emit('resume')">继续任务</button>
    </header>
    <p v-if="goal?.result" class="result">{{ goal.result }}</p>
    <details>
      <summary>任务与验收详情</summary>
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
  </section>
</template>
<style scoped>
.task-plan{width:100%;max-width:760px;margin:0 auto 8px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font-size:13px;box-sizing:border-box}
header{display:flex;align-items:center;gap:10px;min-height:44px;flex-wrap:wrap}header>span{color:var(--text-secondary)}header>small{margin-right:auto}header>button{margin-left:auto}
summary{min-height:44px;align-content:center;cursor:pointer;color:var(--text-secondary)}small{font-size:12px;color:var(--text-secondary)}
button{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}button:hover:not(:disabled){background:var(--surface-hover)}button:disabled{opacity:.55;cursor:default}
.plan-details{max-height:32vh;overflow:auto;padding-bottom:12px}.result{max-height:12vh;overflow:auto;margin:0;padding:8px 0}.objective{color:var(--text-secondary)}
ol,.criteria{padding-left:18px;margin-top:0}li{padding:7px 0}li div{display:flex;gap:12px;justify-content:space-between}li div span{white-space:nowrap;color:var(--text-secondary)}p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.criteria span{font-size:12px;color:var(--text-secondary)}
label{display:grid;gap:8px}textarea{width:100%;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;line-height:1.5}.criteria-actions{display:flex;gap:8px;margin-top:10px}.criteria-error{color:var(--danger)}
summary:focus-visible,button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
