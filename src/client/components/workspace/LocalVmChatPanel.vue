<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {apiRequest} from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import type {WorkspaceAgent} from '@shared/workspace'
import type {ComputerFrame} from '@shared/computerControl'
import type {LocalVmInstance,LocalVmAction} from '@shared/localVm'
const props=defineProps<{agents:WorkspaceAgent[];isAdmin:boolean;active?:boolean}>()
const emit=defineEmits<{close:[];changed:[];settings:[];desktop:[agent:WorkspaceAgent];workspace:[agent:WorkspaceAgent]}>()
const selected=ref(''),state=ref<LocalVmInstance&{enabled:boolean;controlMode?:string}>(),frame=ref<ComputerFrame>(),error=ref(''),busy=ref(false),loading=ref(true)
const agent=computed(()=>props.agents.find(a=>a.id===selected.value))
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,revision=0
const base=()=>`/api/app/agents/${encodeURIComponent(selected.value)}/local-vm`
async function refresh(){
 if(closed||props.active===false||!selected.value||document.hidden||busy.value)return
 const version=revision
 try{
  const result=await apiRequest<typeof state.value>(base());if(version!==revision||closed)return;state.value=result
  if(result?.container==='running'&&result.ready){const image=await apiRequest<ComputerFrame>(`/api/app/agents/${selected.value}/computer/frame`);if(version===revision&&!closed)frame.value=image}
  else frame.value=undefined
 }catch(e){if(version===revision)error.value=e instanceof Error?e.message:'无法读取电脑画面'}finally{if(version===revision)loading.value=false}
}
async function run(work:()=>Promise<unknown>){if(busy.value)return;busy.value=true;error.value='';try{await work();emit('changed')}catch(e){error.value=e instanceof Error?e.message:'电脑操作未完成'}finally{busy.value=false;await refresh()}}
function choose(value:string){void run(()=>apiRequest(base(),{method:'PUT',body:{enabled:value==='vm'}}))}
function action(value:LocalVmAction){
 if(value==='recreate'&&!confirm('重建这台虚拟机？当前桌面程序将关闭，工作文件和浏览器资料会保留。'))return
 void run(()=>apiRequest(base()+'/'+value,{method:'POST',body:{}}))
}
async function cycle(){await refresh();if(!closed)timer=setTimeout(cycle,3000)}
watch(()=>props.agents.map(a=>a.id).join(','),()=>{if(!props.agents.some(a=>a.id===selected.value))selected.value=props.agents[0]?.id??''},{immediate:true})
watch(selected,()=>{revision++;state.value=undefined;frame.value=undefined;error.value='';loading.value=true;clearTimeout(timer);void cycle()},{immediate:true})
watch(()=>props.active,value=>{if(value)void refresh()})
onBeforeUnmount(()=>{closed=true;revision++;clearTimeout(timer)})
</script>
<template>
 <aside class="local-vm-chat-panel" aria-label="Agent 电脑面板">
  <header><strong>电脑</strong><button aria-label="关闭电脑面板" @click="emit('close')"><AppIcon name="close"/></button></header>
  <div class="panel-body">
   <label v-if="agents.length>1" class="agent-select">Agent<select v-model="selected" :disabled="busy"><option v-for="item in agents" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
   <p v-if="!agent">当前聊天没有可用的 Agent。</p>
   <template v-else>
    <div class="screen-caption"><span>{{agent.name}}的电脑</span><small v-if="state?.enabled">本地虚拟机</small></div>
    <button class="preview" :disabled="!frame||busy" :aria-label="`打开${agent.name}的桌面`" @click="emit('desktop',agent)">
     <img v-if="frame" :src="`data:image/png;base64,${frame.data}`" :alt="`${agent.name}的电脑画面`">
     <span v-else class="empty"><AppIcon name="monitor" :size="26"/><span>{{loading?'正在检查电脑…':!state?.enabled?'未使用电脑':!state.image?'本地虚拟机尚未准备':state.container==='missing'?'尚未创建虚拟机':state.container==='stopped'?'虚拟机已停止':'正在连接桌面…'}}</span></span>
     <span v-if="frame" class="open-badge"><AppIcon name="external" :size="12"/>打开桌面</span>
    </button>
    <p v-if="error||state?.problem" class="problem" role="alert">{{error||state?.problem}}</p>
    <label class="computer-select">此 Agent 使用的电脑<select aria-label="此 Agent 使用的电脑" :value="state?.enabled?'vm':'off'" :disabled="busy||state?.inUse||!!agent.remoteAgentId||!!agent.temporaryGoalId" @change="choose(($event.target as HTMLSelectElement).value)"><option value="off">不使用电脑</option><option value="vm">本地虚拟机</option></select></label>
    <template v-if="state?.enabled">
     <p>{{agent.temporaryGoalId?'临时助手的电脑由当前任务管理':state.mode==='shared'?'共享虚拟机 · 与其他成员共用桌面和工作文件':'此 Agent 的独立虚拟机'}}</p>
     <button v-if="!state.image" class="primary" :disabled="!isAdmin" @click="emit('settings')">设置本地虚拟机</button>
     <button v-else-if="state.container==='missing'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('create')">创建 {{agent.name}} 的虚拟机</button>
     <button v-else-if="state.container==='stopped'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('start')">启动虚拟机</button>
     <template v-else-if="state.container==='running'">
      <button class="primary" :disabled="!state.ready||busy" @click="emit('desktop',agent)">打开桌面</button>
      <button v-if="state.mode==='per-bot'" :disabled="busy" @click="emit('workspace',agent)"><AppIcon name="panel"/>打开双桌面</button>
      <p class="control-state">{{state.controlMode==='human'?'你或其他操作者正在控制电脑':state.inUse?'Agent 正在操作':'仅查看 · 虚拟机空闲'}}</p>
     </template>
     <div v-if="state.container!=='missing'&&!agent.temporaryGoalId" class="vm-actions"><button :disabled="busy||state.inUse" @click="action('stop')">停止虚拟机</button><button :disabled="busy||state.inUse" @click="action('recreate')">重建虚拟机</button></div>
     <p class="hint">重建会保留工作目录和浏览器资料。虚拟机空闲 5 分钟后自动停止。</p>
     <button v-if="isAdmin" class="settings-link" @click="emit('settings')"><AppIcon name="settings" :size="14"/>本地虚拟机设置</button>
    </template>
   </template>
  </div>
 </aside>
</template>
<style scoped>
.local-vm-chat-panel{width:400px;min-width:320px;max-width:46%;height:100%;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}header button{border:0;min-height:32px;padding:5px}.panel-body{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px 20px}.screen-caption{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)}.preview{flex:none;position:relative;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;border:0;border-radius:12px;overflow:hidden;padding:0;background:#14181e;color:#dce1e7;width:100%}.preview:disabled{opacity:1;cursor:default}.preview img{width:100%;height:100%;object-fit:contain}.empty{display:grid;justify-items:center;gap:12px;font-size:13px}.open-badge{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:4px;padding:5px 7px;background:#000b;color:white;border-radius:6px;font-size:11px}p{margin:0;font-size:13px;line-height:1.65;color:var(--text-secondary)}label{display:grid;gap:7px;font-size:13px}button,select{font:inherit;background:var(--surface-raised);color:inherit;border:1px solid var(--line);border-radius:8px;min-height:40px;padding:8px 12px}button{cursor:pointer;display:inline-flex;gap:7px;align-items:center;justify-content:center}button:disabled,select:disabled{opacity:.45;cursor:default}.primary{background:var(--accent);color:var(--text-on-solid)}.vm-actions{display:flex;gap:8px}.vm-actions button{flex:1;font-size:12px}.hint{font-size:12px;color:var(--text-muted)}.problem{color:var(--danger)}.settings-link{border:0;background:transparent;align-self:flex-start;padding-left:0;font-size:12px}.control-state{padding:10px;border-radius:8px;background:var(--surface-soft)}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:900px){.local-vm-chat-panel{position:fixed;inset:0 0 0 auto;width:min(400px,100vw);max-width:100%;z-index:35;box-shadow:-20px 0 60px #0002}}
</style>
