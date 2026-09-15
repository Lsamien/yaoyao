<script setup lang="ts">
import {computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {apiRequest} from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'
import WorkspaceKnowledgePanel from './WorkspaceKnowledgePanel.vue'
import type {WorkspaceAgent, WorkspaceConversation} from '@shared/workspace'

const LocalVmSettingsPanel = defineAsyncComponent(() => import('@/components/app/LocalVmSettingsPanel.vue'))
type Page = 'projects' | 'user' | 'vm'
const props = defineProps<{isAdmin?: boolean; initialPage?: Page}>()
const emit = defineEmits<{close: []; changed: []}>()
const page = ref<Page>(props.initialPage === 'vm' && !props.isAdmin ? 'projects' : props.initialPage ?? 'projects')
const agents = ref<WorkspaceAgent[]>([]), conversations = ref<WorkspaceConversation[]>([])
const loading = ref(true), error = ref(''), knowledgeEnabled = ref(false)
let closed = false
const pages = computed(() => [
  {id:'projects' as const, label:'项目', icon:'files' as const},
  {id:'user' as const, label:'用户记忆', icon:'users' as const},
  ...(props.isAdmin ? [{id:'vm' as const, label:'本地虚拟机', icon:'monitor' as const}] : []),
])
async function load() {
  loading.value = true; error.value = ''
  try {
    const [capabilities, a, c] = await Promise.all([
      apiRequest<{features:string[]}>('/api/app/capabilities'),
      apiRequest<{agents:WorkspaceAgent[]}>('/api/app/agents'),
      apiRequest<{conversations:WorkspaceConversation[]}>('/api/app/conversations'),
    ])
    if (closed) return
    knowledgeEnabled.value = capabilities.features.includes('bot-file-memory-v1')
    agents.value = a.agents; conversations.value = c.conversations
  } catch (cause) { if (!closed) error.value = cause instanceof Error ? cause.message : '无法加载 Bot 设置' }
  finally { if (!closed) loading.value = false }
}
function changed() { emit('changed'); void load() }
watch(() => props.isAdmin, allowed => { if (!allowed && page.value === 'vm') page.value = 'projects' })
onMounted(load)
onBeforeUnmount(() => { closed = true })
</script>

<template>
  <StandaloneDialog title="Bot 设置" settings @close="emit('close')">
    <div class="bot-settings">
      <nav aria-label="Bot 设置分类">
        <button v-for="item in pages" :key="item.id" type="button" :aria-pressed="page === item.id" @click="page = item.id"><AppIcon :name="item.icon" :size="18" /><span>{{item.label}}</span></button>
      </nav>
      <section v-if="page === 'vm' && isAdmin" class="bot-settings__content bot-settings__vm"><header><h3>本地虚拟机</h3><p>为 Bot 配置隔离的工作环境。</p></header><LocalVmSettingsPanel /></section>
      <section v-else class="bot-settings__content bot-settings__knowledge" :aria-label="page === 'projects' ? '项目设置' : '用户记忆设置'" :aria-busy="loading">
        <header v-if="page === 'user'"><h3>用户记忆</h3><p>管理同一账号的 Bot 共享的长期事实。</p></header>
        <p v-if="error" role="alert">{{error}} <button type="button" @click="load">重试</button></p>
        <p v-else-if="loading && !knowledgeEnabled" role="status">正在加载…</p>
        <WorkspaceKnowledgePanel v-else-if="knowledgeEnabled" embedded :initial-tab="page === 'user' ? 'user' : 'projects'" :agents="agents" :conversations="conversations" @changed="changed" />
        <p v-else class="bot-settings__empty">当前服务尚不支持项目和用户记忆，请更新服务后重试。</p>
      </section>
    </div>
  </StandaloneDialog>
</template>

<style scoped>
.bot-settings{display:grid;grid-template-columns:208px minmax(0,1fr);height:100%;min-height:0;min-width:0}.bot-settings nav{display:flex;flex-direction:column;gap:4px;padding:16px 12px;border-right:1px solid var(--line);background:var(--settings-sidebar)}.bot-settings nav button{display:flex;align-items:center;gap:12px;min-height:48px;padding:10px 14px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);font:500 14px var(--font-ui);cursor:pointer;text-align:left}.bot-settings nav button:hover{background:var(--surface-hover)}.bot-settings nav button[aria-pressed=true]{background:var(--settings-selected);font-weight:600}.bot-settings button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.bot-settings__content{min-width:0;min-height:0;padding:24px;overflow:auto;overscroll-behavior:contain}.bot-settings__content>header{margin-bottom:24px}.bot-settings__content h3{margin:0;font-size:18px;font-weight:650}.bot-settings__content header p{margin:6px 0 0;color:var(--text-secondary);font-size:13px;line-height:1.6}.bot-settings__knowledge>p{margin:0;font-size:14px;line-height:1.7;color:var(--text-secondary)}.bot-settings__knowledge>[role=alert]{color:var(--danger)}.bot-settings__knowledge>p button{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}.bot-settings__empty{padding:24px 0;text-align:center}.bot-settings__vm :deep(article){padding:20px;border:0;border-radius:12px;background:var(--settings-panel)}.bot-settings__vm :deep(article:first-child h3){display:none}.bot-settings__vm :deep(.segmented button[aria-pressed=true]){background:var(--surface)}@media(max-width:600px){.bot-settings{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.bot-settings nav{flex-direction:row;padding:10px 12px;gap:4px;border-right:0;border-bottom:1px solid var(--line)}.bot-settings nav button{flex:1;justify-content:center;padding:8px;gap:6px;white-space:nowrap;min-height:44px;font-size:13px}.bot-settings__content{padding:20px}}
</style>
