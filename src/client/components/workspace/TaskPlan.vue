<script setup lang="ts">
import type { AgentAssignment, AgentGoal } from '@shared/agentTasks'
import type { WorkspaceAgent } from '@shared/workspace'
defineProps<{ goal?: AgentGoal; assignments: AgentAssignment[]; agents: WorkspaceAgent[] }>()
defineEmits<{stop:[];resume:[]}>()
const labels: Record<string,string> = {pending:'待执行',running:'进行中',review:'待复核',complete:'已完成',failed:'执行失败',blocked:'遇到阻碍',cancelling:'正在停止',cancelled:'已停止',waiting:'需要补充信息'}
</script>
<template>
  <details v-if="goal || assignments.length" class="task-plan">
    <summary>任务进度 <span v-if="goal">{{ labels[goal.status] }}</span></summary>
    <ol v-if="assignments.length">
      <li v-for="item in assignments" :key="item.id">
        <div><strong>{{ item.title }}</strong><span>{{ labels[item.status] }}</span></div>
        <small>{{ agents.find(a => a.id === item.agentId)?.name || '成员不可用' }}<template v-if="agents.find(a => a.id === item.agentId)?.temporaryGoalId"> · 临时助手{{ agents.find(a => a.id === item.agentId)?.archived ? (agents.find(a => a.id === item.agentId)?.cleanupState === 'pending' ? '（已退役，等待清理）' : '（已退役）') : '' }}</template></small>
        <p v-if="item.review">{{ item.review }}</p>
      </li>
    </ol>
    <p v-if="goal?.result" class="result">{{ goal.result }}</p>
    <ul v-if="goal?.acceptanceCriteria.length" class="criteria">
      <li v-for="(criterion,index) in goal.acceptanceCriteria" :key="index">
        <span>{{ goal.checks?.some(check => check.criterion === index && check.passed) ? '已验收' : '待验收' }}</span> {{ criterion }}
      </li>
    </ul>
    <button v-if="goal && ['running','review','waiting'].includes(goal.status)" type="button" @click="$emit('stop')">停止任务</button>
    <button v-if="goal && ['blocked','waiting','cancelled'].includes(goal.status)" type="button" @click="$emit('resume')">继续任务</button>
  </details>
</template>
<style scoped>
.task-plan{margin:0 18px 10px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font-size:13px;max-height:34vh;overflow:auto}
summary{min-height:44px;display:flex;align-items:center;gap:12px;cursor:pointer;list-style:revert}summary span,small{color:var(--text-muted)}
button{min-height:44px;padding:8px 12px;margin-bottom:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);cursor:pointer}
ol{padding-left:18px;margin-top:0}li{padding:7px 0}li div{display:flex;gap:12px;justify-content:space-between}li div span{white-space:nowrap;color:var(--text-muted)}p{white-space:pre-wrap;line-height:1.6}.criteria{padding-left:18px}.criteria span{font-size:12px;color:var(--text-muted)}summary:focus-visible{outline:2px solid var(--text-primary);outline-offset:3px}
</style>
