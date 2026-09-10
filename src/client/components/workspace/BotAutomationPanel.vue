<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceAgent } from '@shared/workspace'
import WorkspaceRoutinesPanel from './WorkspaceRoutinesPanel.vue'
const agents = ref<WorkspaceAgent[]>([]), selected = ref(''), error = ref(''), loading = ref(true)
const available = computed(() => agents.value.filter(a => !a.archived && !a.remoteAgentId && !a.temporaryGoalId))
onMounted(async () => { try { agents.value = (await apiRequest<{ agents: WorkspaceAgent[] }>('/api/app/agents')).agents; selected.value = available.value[0]?.id ?? '' } catch (e) { error.value = e instanceof Error ? e.message : '无法读取 Bot' } finally { loading.value = false } })
</script>
<template><section class="bot-automations" aria-label="Bot 自动化"><p>选择 Bot，管理自动执行的任务和运行记录。</p><p v-if="error" role="alert">{{ error }}</p><p v-if="loading" role="status">正在读取…</p><template v-else-if="available.length"><label>执行 Bot<select v-model="selected"><option v-for="agent in available" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label><WorkspaceRoutinesPanel v-if="selected" :key="selected" :agent-id="selected" /></template><p v-else>还没有可设置自动化的 Bot，请先创建机器人。</p></section></template>
<style scoped>.bot-automations{display:grid;gap:16px;color:var(--text-primary);font-size:13px}.bot-automations>p{color:var(--text-secondary);line-height:1.6;margin:0}.bot-automations>label{display:grid;gap:8px}.bot-automations select{padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:inherit;font:inherit}.bot-automations select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.bot-automations>[role=alert]{color:var(--danger)}</style>
