<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {apiRequest} from '@/api/client'
import {createUuid} from '@/utils/id'
import AppIcon from '@/components/common/AppIcon.vue'
import RunnerSettingsPanel from './RunnerSettingsPanel.vue'
import type {LocalVmStatus,LocalVmMode,LocalVmAction,LocalVmInstance} from '@shared/localVm'
import type {WorkspaceAgent} from '@shared/workspace'
const state=ref<LocalVmStatus>(),error=ref(''),loading=ref(false),acting=ref(false)
const runnerSettingsOpen=ref(false)
const instances=ref<Array<{agent:WorkspaceAgent;vm:LocalVmInstance}>>([])
let closed=false,timer:ReturnType<typeof setTimeout>|undefined
async function refresh(){
 if(loading.value||acting.value||closed)return
 loading.value=true
 try{
  const next=await apiRequest<LocalVmStatus>('/api/app/admin/local-vm');if(closed)return;state.value=next
  const list=await apiRequest<{computers:Array<{agent:WorkspaceAgent}>}>('/api/app/computers')
  const seen=new Set<string>()
  const agents=list.computers.map(x=>x.agent).filter(a=>a.execution==='computer'&&!a.remoteAgentId&&a.nodeId==='local'&&!seen.has(a.computerEnvironmentId??a.id)&&!!seen.add(a.computerEnvironmentId??a.id))
  const rows=await Promise.all(agents.map(async agent=>({agent,vm:await apiRequest<LocalVmInstance>(`/api/app/agents/${agent.id}/local-vm`)})))
  if(!closed)instances.value=rows
 }catch(e){if(!closed)error.value=e instanceof Error?e.message:'无法读取本地虚拟机状态'}finally{loading.value=false}
}
async function action(work:()=>Promise<unknown>){acting.value=true;error.value='';try{await work()}catch(e){error.value=e instanceof Error?e.message:'操作未完成'}finally{acting.value=false;await refresh()}}
function prepare(){void action(()=>apiRequest('/api/app/admin/local-vm/prepare',{method:'POST',body:{requestId:createUuid()}}))}
function policy(mode:LocalVmMode,maxInstances=state.value?.maxInstances??2){
 if(mode==='shared'&&state.value?.mode!=='shared'&&!confirm('同一账号、同一基础 Agent 的机器人将共用桌面、工作文件和浏览器登录。确认使用共享虚拟机？'))return
 void action(()=>apiRequest('/api/app/admin/local-vm/policy',{method:'PUT',body:{requestId:createUuid(),mode,maxInstances}}))
}
function manage(agent:WorkspaceAgent,operation:LocalVmAction){
 if(operation==='remove'&&!confirm(`移除“${agent.name}”的虚拟机实例？工作文件和浏览器资料将保留。`))return
 void action(()=>apiRequest(`/api/app/agents/${agent.id}/local-vm/${operation}`,{method:'POST',body:{}}))
}
async function cycle(){await refresh();if(!closed)timer=setTimeout(cycle,state.value?.busy?2000:10000)}
onMounted(cycle);onBeforeUnmount(()=>{closed=true;clearTimeout(timer)})
</script>
<template>
 <section class="local-vm-settings" aria-label="本地虚拟机设置">
  <article><h3>{{state?.fixedCapacity?'Compose 共享桌面':'本地虚拟机'}}</h3><p>{{state?.fixedCapacity?'桌面容器随 Web 的 Compose 文件部署，工作文件与浏览器资料保存在各桌面的数据卷中。':'在 Hermes 所在电脑的隔离 Linux 桌面中运行 Agent，工作文件与浏览器资料持续保存。'}}</p>
   <div class="row"><span class="status"><AppIcon :name="state?.image?'check':'monitor'"/>{{loading&&!state?'正在检查…':state?.image?'虚拟机环境已就绪':'尚未就绪'}}</span><button :disabled="loading||acting" @click="error='';refresh()"><AppIcon name="refresh"/>重新检查</button></div>
   <p v-if="state?.problem">{{state.problem}}</p><p v-if="error" role="alert">{{error}}</p>
   <p v-if="state?.job" role="status">{{state.job.message}}</p>
  </article>
  <article v-if="state?.executionHost==='runner'"><h3>Hermes 执行连接</h3><p>{{state.fixedCapacity?'执行连接负责 Hermes 模型与工具调用，桌面容器完全由这套 Compose 管理。':'虚拟桌面由运行 Hermes 的执行节点提供，Docker 版 Web 通过这条连接使用桌面。'}}{{state.runnerName?`当前节点：${state.runnerName}。`:''}}</p><button :aria-expanded="runnerSettingsOpen" @click="runnerSettingsOpen=!runnerSettingsOpen">{{runnerSettingsOpen?'收起执行节点设置':'打开执行节点设置'}}</button><RunnerSettingsPanel v-if="runnerSettingsOpen" computer-setup /></article>
  <article v-if="state?.fixedCapacity"><h3>Compose 共享桌面</h3><p>已配置 {{state.maxInstances}} 台桌面，数量由 Compose 固定。请在 Agent 聊天的电脑面板选择已有桌面。</p><div v-for="desktop in state.desktops" :key="desktop.id" class="instance"><strong>{{desktop.name}}</strong><span>{{desktop.ready?'已就绪':desktop.online?'正在启动':'未连接'}}</span></div></article>
  <article v-else-if="state"><h3>隔离方式</h3><p>按 Agent 创建独立桌面，或让可信的 Agent 共用一个桌面。</p>
   <div class="segmented" role="group" aria-label="虚拟机隔离方式"><button :aria-pressed="state?.mode==='shared'" :disabled="!state?.configured||!!state?.setupRequired||acting||state.busy" @click="policy('shared')">共享虚拟机</button><button :aria-pressed="state?.mode==='per-bot'" :disabled="!state?.configured||!!state?.setupRequired||acting||state.busy" @click="policy('per-bot')">每个 Agent 独立</button></div>
   <label class="row">最多同时运行的虚拟机<select aria-label="虚拟机数量上限" :value="state?.maxInstances??2" :disabled="!state?.configured||!!state?.setupRequired||acting||state.busy" @change="policy(state!.mode,Number(($event.target as HTMLSelectElement).value))"><option v-for="n in [1,2,3,4]" :key="n" :value="n">{{n}}</option></select></label>
  </article>
  <article v-if="state&&!state.fixedCapacity&&!state.setupRequired"><h3>准备运行环境</h3><p v-if="state?.executionHost==='runner'">以下检查和镜像准备均在执行节点所在电脑完成。</p><ol>
   <li><span class="step">{{state?.runtime?'✓':'1'}}</span><div><strong>安装 Docker 或 Podman</strong><p>{{state?.runtime?`已检测到 ${state.runtime}`:'请先安装 Docker Desktop 或 Podman。'}}</p></div></li>
   <li><span class="step">{{state?.daemonUp?'✓':'2'}}</span><div><strong>启动容器运行环境</strong><p>{{state?.daemonUp?'运行环境已启动':'打开 Docker / Podman，等待它完成启动后重新检查。'}}</p></div></li>
   <li><span class="step">{{state?.image?'✓':'3'}}</span><div><strong>准备本地虚拟机</strong><p>下载并检查托管桌面环境。后续创建虚拟机时会自动使用。</p><button class="primary" :disabled="acting||state?.busy||!state?.daemonUp" @click="prepare">{{state?.busy?'正在准备…':state?.image?'重新检查虚拟机镜像':'准备本地虚拟机'}}</button></div></li>
   <li><span class="step">4</span><div><strong>从 Agent 聊天中创建桌面</strong><p>打开聊天右上角的“电脑”，选择“本地虚拟机”，然后创建该 Agent 的虚拟机。</p></div></li>
  </ol></article>
  <article v-if="state&&!state.fixedCapacity"><h3>{{state?.mode==='shared'?'共享虚拟机':'Agent 虚拟机'}}</h3><p v-if="!instances.length">还没有 Agent 使用本地虚拟机。</p>
   <div v-for="row in instances" :key="row.agent.id" class="instance"><div><strong>{{row.agent.computerEnvironmentName??row.agent.name}}</strong><p>{{row.vm.inUse?'正在使用':({running:'运行中',stopped:'已停止',missing:'尚未创建'})[row.vm.container]}}</p></div><div class="row">
    <button v-if="row.vm.container==='running'" :disabled="acting||row.vm.inUse" @click="manage(row.agent,'stop')">停止</button>
    <button v-else :disabled="acting||!state?.image" @click="manage(row.agent,row.vm.container==='missing'?'create':'start')">{{row.vm.container==='missing'?'创建':'启动'}}</button>
    <button v-if="row.vm.container!=='missing'" :disabled="acting||row.vm.inUse" @click="manage(row.agent,'remove')">移除实例</button>
   </div></div>
   <div v-for="item in state?.instances?.filter(i=>i.orphaned)" :key="item.id" class="instance"><div><strong>{{item.name}}</strong><p>暂无 Agent 使用 · {{item.status==='free'?'已停止':'运行中或待核对'}}</p></div><div class="row"><button :disabled="acting" @click="action(()=>apiRequest(`/api/app/admin/local-vm/instances/${item.id}/stop`,{method:'POST',body:{requestId:createUuid()}}))">停止</button><button :disabled="acting" @click="action(()=>apiRequest(`/api/app/admin/local-vm/instances/${item.id}/remove`,{method:'POST',body:{requestId:createUuid()}}))">移除实例</button></div></div>
  </article>
 </section>
</template>
<style scoped>
.local-vm-settings{display:grid;gap:16px;max-width:820px}article{padding:20px;border:1px solid var(--line);border-radius:14px;display:grid;gap:12px;background:var(--surface)}h3,p{margin:0}h3{font-size:15px}p{font-size:13px;line-height:1.7;color:var(--text-secondary)}.row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.status{display:inline-flex;align-items:center;gap:7px;font-size:13px}.segmented{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}.segmented button{flex:1;border:0;border-radius:0}.segmented button[aria-pressed=true]{background:var(--surface-soft);font-weight:600}.instance{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--line)}button,select{font:inherit;color:var(--text-primary);background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;min-height:40px;padding:7px 12px}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:var(--accent);color:var(--text-on-solid);margin-top:8px}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}ol{list-style:none;margin:0;padding:0;display:grid;gap:20px}li{display:flex;gap:12px}.step{display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;height:26px;width:26px;flex:none;font-size:12px}li strong{font-size:13px}[role=alert]{color:var(--danger)}
</style>
