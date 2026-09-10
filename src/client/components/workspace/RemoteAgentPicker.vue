<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceAgent } from '@shared/workspace'
const emit=defineEmits<{close:[];added:[agent:WorkspaceAgent]}>()
const dialog=ref<HTMLDialogElement>(), nodes=ref<Array<{id:string;name:string}>>([]), nodeId=ref(''), agents=ref<WorkspaceAgent[]>([]), error=ref(''), busy=ref(false), adding=ref(false)
let generation=0
watch(nodeId,async id=>{
  const token=++generation;agents.value=[];if(!id)return;busy.value=true;error.value=''
  try {const value=await apiRequest<{agents:WorkspaceAgent[]}>(`/api/app/nodes/${id}/agents`);if(token===generation)agents.value=value.agents}
  catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'读取失败'}
  finally{if(token===generation)busy.value=false}
})
onMounted(async()=>{
  dialog.value?.showModal()
  try{nodes.value=(await apiRequest<{nodes:typeof nodes.value}>('/api/app/nodes')).nodes;nodeId.value=nodes.value[0]?.id??''}
  catch(cause){error.value=String(cause)}
})
async function add(agent:WorkspaceAgent){
  busy.value=true;adding.value=true;error.value=''
  try{const value=await apiRequest<{agent:WorkspaceAgent}>('/api/app/agents/remote',{method:'POST',body:{nodeId:nodeId.value,agentId:agent.id}});emit('added',value.agent)}
  catch(cause){error.value=cause instanceof Error?cause.message:'添加失败'}
  finally{busy.value=false;adding.value=false}
}
</script>
<template>
  <dialog ref="dialog" class="remote-agent-picker" @cancel.prevent="!adding && emit('close')">
    <header><h2>添加远程机器人</h2><button type="button" :disabled="adding" @click="emit('close')">关闭</button></header>
    <p>直接引用远端 Bot 模式的机器人，配置由远端管理，可用于聊天和群聊。</p>
    <label>远程子节点<select v-model="nodeId" :disabled="busy"><option v-for="node in nodes" :key="node.id" :value="node.id">{{node.name}}</option></select></label>
    <p v-if="error" role="alert">{{error}}</p>
    <p v-if="!nodes.length">请先在远程节点中扫码添加子节点。</p>
    <p v-else-if="!busy && !agents.length && !error">这个节点暂无可添加的机器人。</p>
    <button v-for="agent in agents" :key="agent.id" class="agent-option" :disabled="busy" @click="add(agent)">{{agent.name}}<span>添加</span></button>
    <p v-if="busy">加载中…</p>
  </dialog>
</template>
<style scoped>
.remote-agent-picker{width:min(480px,calc(100vw - 32px));border:1px solid var(--line);border-radius:16px;padding:24px;background:var(--surface);color:var(--text-primary)}
.remote-agent-picker::backdrop{background:#0005}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{font-size:18px}p{font-size:13px;color:var(--text-muted);line-height:1.7}label{display:grid;gap:8px}select,button{padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-soft);color:inherit}.agent-option{display:flex;justify-content:space-between;width:100%;margin-top:12px}[role=alert]{color:var(--danger)}
</style>
