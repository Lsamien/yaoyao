<script setup lang="ts">
import {ref,watch} from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import LocalVmChatPanel from './LocalVmChatPanel.vue'
import WorkspaceInspectorPanel from './WorkspaceInspectorPanel.vue'
import WorkspaceRoutinesPanel from './WorkspaceRoutinesPanel.vue'
import type {WorkspaceAgent} from '@shared/workspace'
const props=defineProps<{agents:WorkspaceAgent[];conversationId:string;taskId?:string;group:boolean;isAdmin:boolean;active?:boolean;initialView?:'computer'|'routines'|'inspector'}>()
const emit=defineEmits<{close:[];changed:[];settings:[];desktop:[agent:WorkspaceAgent];workspace:[agent:WorkspaceAgent]}>()
const view=ref<'computer'|'routines'|'inspector'>('computer')
watch(()=>[props.conversationId,props.initialView],()=>{let saved;try{saved=localStorage.getItem('yaoyao-bot-panel:'+props.conversationId)}catch{}view.value=props.group?'inspector':props.initialView??(['computer','routines','inspector'].includes(saved??'')?saved as typeof view.value:'computer')},{immediate:true})
watch(view,value=>{try{localStorage.setItem('yaoyao-bot-panel:'+props.conversationId,value)}catch{}})
</script>
<template>
 <aside class="bot-panel" aria-label="机器人右侧栏">
  <header><div class="tabs" role="group" aria-label="机器人侧栏项目"><button v-if="!group" :aria-pressed="view==='computer'" @click="view='computer'"><AppIcon name="monitor" :size="15"/>电脑</button><button v-if="!group" :aria-pressed="view==='routines'" @click="view='routines'"><AppIcon name="calendar" :size="15"/>定时任务</button><button :aria-pressed="view==='inspector'" @click="view='inspector'"><AppIcon name="bug" :size="15"/>Inspector</button></div><button aria-label="关闭机器人侧栏" @click="emit('close')"><AppIcon name="close"/></button></header>
  <LocalVmChatPanel v-if="view==='computer'&&!group" embedded :agents="agents" :is-admin="isAdmin" :active="active" @changed="emit('changed')" @settings="emit('settings')" @desktop="emit('desktop',$event)" @workspace="emit('workspace',$event)"/>
  <WorkspaceRoutinesPanel v-else-if="view==='routines'&&agents[0]&&!group" :agent-id="agents[0].id"/>
  <WorkspaceInspectorPanel v-else :conversation-id="conversationId" :task-id="taskId"/>
 </aside>
</template>
<style scoped>
.bot-panel{width:420px;min-width:320px;max-width:46%;height:100%;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.tabs{display:flex;flex-wrap:wrap;gap:2px}.tabs button{font-size:12px;padding:8px}.tabs button[aria-pressed=true]{background:var(--surface-soft);color:var(--text-primary);font-weight:600}button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;color:var(--text-secondary);border-radius:8px;min-width:44px;min-height:44px;cursor:pointer}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:900px){.bot-panel{position:fixed;inset:0 0 0 auto;width:min(440px,100vw);max-width:100%;z-index:35;box-shadow:-20px 0 60px #0002}}:deep(.local-vm-chat-panel.embedded){width:100%;max-width:none;min-width:0;border:0;position:static;box-shadow:none;flex:1;min-height:0}:deep(.local-vm-chat-panel.embedded>header){display:none}
</style>
