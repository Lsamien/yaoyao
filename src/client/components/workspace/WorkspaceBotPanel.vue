<script setup lang="ts">
import type { ComputerBackend } from '@shared/managedBrowser'
import {ref,watch} from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import LocalVmChatPanel from './LocalVmChatPanel.vue'
import WorkspaceInspectorPanel from './WorkspaceInspectorPanel.vue'
import WorkspaceRoutinesPanel from './WorkspaceRoutinesPanel.vue'
import type {WorkspaceAgent} from '@shared/workspace'
const props=defineProps<{agents:WorkspaceAgent[];conversationId:string;taskId?:string;mode:'computer'|'inspector';isAdmin:boolean;active?:boolean}>()
const emit=defineEmits<{close:[];changed:[];settings:[];desktop:[agent:WorkspaceAgent,backend?:ComputerBackend,host?:string];workspace:[agent:WorkspaceAgent]}>()
const view=ref<'computer'|'routines'>('computer')
watch(()=>props.conversationId,()=>{let saved;try{saved=localStorage.getItem('yaoyao-bot-panel:'+props.conversationId)}catch{}view.value=saved==='routines'?'routines':'computer'},{immediate:true})
watch(view,value=>{try{localStorage.setItem('yaoyao-bot-panel:'+props.conversationId,value)}catch{}})
</script>
<template>
 <aside class="bot-panel" aria-label="机器人右侧栏">
  <header v-if="mode==='computer'"><div class="tabs" role="group" aria-label="电脑与定时任务"><button :aria-pressed="view==='computer'" @click="view='computer'"><AppIcon name="monitor" :size="15"/>电脑</button><button :aria-pressed="view==='routines'" @click="view='routines'"><AppIcon name="calendar" :size="15"/>定时任务</button></div><button class="close" aria-label="关闭机器人侧栏" @click="emit('close')"><AppIcon name="close"/></button></header>
  <WorkspaceInspectorPanel v-if="mode==='inspector'" show-close :conversation-id="conversationId" :task-id="taskId" @close="emit('close')"/>
  <LocalVmChatPanel v-else-if="view==='computer'" embedded :agents="agents" :is-admin="isAdmin" :active="active" @changed="emit('changed')" @settings="emit('settings')" @desktop="(agent,backend,host)=>emit('desktop',agent,backend,host)" @workspace="emit('workspace',$event)"/>
  <WorkspaceRoutinesPanel v-else-if="agents[0]" :agent-id="agents[0].id"/>
 </aside>
</template>
<style scoped>
.bot-panel{width:420px;min-width:320px;max-width:46%;height:100%;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;color:var(--text-primary)}header{position:relative;display:flex;align-items:center;justify-content:center;min-height:64px;padding:10px 58px;border-bottom:1px solid var(--line);box-sizing:border-box}.tabs{display:flex;flex-wrap:wrap;justify-content:center;gap:2px}.tabs button{font-size:12px;padding:8px}.tabs button[aria-pressed=true]{background:var(--surface-soft);color:var(--text-primary);font-weight:600}.close{position:absolute;right:12px}button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;color:var(--text-secondary);border-radius:8px;min-width:44px;min-height:44px;cursor:pointer}button:hover{background:var(--surface-hover);color:var(--text-primary)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:900px){.bot-panel{position:fixed;inset:0 0 0 auto;width:min(440px,100vw);max-width:100%;z-index:35;box-shadow:-20px 0 60px #0002}}:deep(.local-vm-chat-panel.embedded){width:100%;max-width:none;min-width:0;border:0;position:static;box-shadow:none;flex:1;min-height:0}:deep(.local-vm-chat-panel.embedded>header){display:none}
</style>
