<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {apiRequest} from '@/api/client'
import {createUuid} from '@/utils/id'
import AppIcon from '@/components/common/AppIcon.vue'
import RunnerSettingsPanel from './RunnerSettingsPanel.vue'
import type {LocalVmStatus} from '@shared/localVm'
import {LOCAL_VM_IMAGES,MAX_DESKTOPS_PER_COMPUTER,VM_IDLE_STOP_OPTIONS,vmIdleStopLabel,type LocalVmImageKey} from '@shared/localVm'
const state=ref<LocalVmStatus>(),error=ref(''),loading=ref(false),acting=ref(false)
const runnerSettingsOpen=ref(false)
const prepareImage=ref<LocalVmImageKey>('standard')
let closed=false,timer:ReturnType<typeof setTimeout>|undefined
async function refresh(){
 if(loading.value||acting.value||closed)return
 loading.value=true
 try{const next=await apiRequest<LocalVmStatus>('/api/app/admin/local-vm');if(!closed)state.value=next}
 catch(e){if(!closed)error.value=e instanceof Error?e.message:'无法读取本地虚拟机状态'}finally{loading.value=false}
}
async function action(work:()=>Promise<unknown>){acting.value=true;error.value='';try{await work()}catch(e){error.value=e instanceof Error?e.message:'操作未完成'}finally{acting.value=false;await refresh()}}
function prepare(){void action(()=>apiRequest('/api/app/admin/local-vm/prepare',{method:'POST',body:{requestId:createUuid(),imageKey:prepareImage.value}}))}
function policy(maxInstances=state.value?.maxInstances??2,maxDesktops=state.value?.maxDesktops??4){
 void action(()=>apiRequest('/api/app/admin/local-vm/policy',{method:'PUT',body:{requestId:createUuid(),maxInstances,maxDesktops}}))
}
function instance(id:string,operation:'stop'|'remove'){
 if(operation==='remove'&&!confirm('移除这台虚拟机实例？工作文件、浏览器资料和每个机器人的桌面资料都会保留。'))return
 void action(()=>apiRequest(`/api/app/admin/local-vm/instances/${id}/${operation}`,{method:'POST',body:{requestId:createUuid()}}))
}
async function cycle(){await refresh();if(!closed)timer=setTimeout(cycle,state.value?.busy?2000:10000)}
onMounted(cycle);onBeforeUnmount(()=>{closed=true;clearTimeout(timer)})
</script>
<template>
 <section class="local-vm-settings" aria-label="本地虚拟机设置">
  <article v-if="state?.supported===false"><h3>本地虚拟机</h3><p>{{state.problem}}</p></article>
  <template v-else>
  <article><h3>本地虚拟机</h3><p>每个开通了虚拟机的账号拥有一台独立的 Linux 虚拟机。账号下的机器人共用这台虚拟机的工作文件，每个机器人有自己的桌面和浏览器资料。管理员账号默认可用，子账号需在“用户与权限”中逐个开通。</p>
   <div class="row"><span class="status"><AppIcon :name="state?.image?'check':'monitor'"/>{{loading&&!state?'正在检查…':state?.image?'虚拟机环境已就绪':'尚未就绪'}}</span><button :disabled="loading||acting" @click="error='';refresh()"><AppIcon name="refresh"/>重新检查</button></div>
   <p v-if="state?.problem">{{state.problem}}</p><p v-if="error" role="alert">{{error}}</p>
   <p v-if="state?.job" role="status">{{state.job.message}}</p>
  </article>
  <article v-if="state?.executionHost==='runner'"><h3>执行节点</h3><p>虚拟机由外部执行节点提供。{{state.runnerName?`当前节点：${state.runnerName}。`:''}}</p><button :aria-expanded="runnerSettingsOpen" @click="runnerSettingsOpen=!runnerSettingsOpen">{{runnerSettingsOpen?'收起执行节点设置':'打开执行节点设置'}}</button><RunnerSettingsPanel v-if="runnerSettingsOpen" computer-setup /></article>
  <article v-if="state"><h3>容量</h3>
   <label class="row">同时运行的账号虚拟机<select aria-label="同时运行的账号虚拟机" :value="state.maxInstances??2" :disabled="!state.configured||!!state.setupRequired||acting||state.busy" @change="policy(Number(($event.target as HTMLSelectElement).value))"><option v-for="n in 8" :key="n" :value="n">{{n}}</option></select></label>
   <label class="row">每台虚拟机的机器人桌面<select aria-label="每台虚拟机的机器人桌面" :value="state.maxDesktops??4" :disabled="!state.configured||!!state.setupRequired||acting||state.busy" @change="policy(state!.maxInstances,Number(($event.target as HTMLSelectElement).value))"><option v-for="n in MAX_DESKTOPS_PER_COMPUTER" :key="n" :value="n">{{n}}</option></select></label>
   <p>每个机器人桌面约占用 200–400 MB 内存。上限只影响新启动的虚拟机和桌面。</p>
  </article>
  <article v-if="state"><h3>空闲自动停止</h3><p>从任务结束或交还控制权后开始计时，适用于所有账号的虚拟机。</p>
   <label class="row">停止时间<select aria-label="虚拟机空闲停止时间" :value="state.idleStopMinutes??5" :disabled="acting||!state.configured||state.idleStopMinutes===undefined" @change="action(()=>apiRequest('/api/app/admin/local-vm/idle-policy',{method:'PUT',body:{requestId:createUuid(),idleStopMinutes:Number(($event.target as HTMLSelectElement).value)}}))"><option v-for="minutes in VM_IDLE_STOP_OPTIONS" :key="minutes" :value="minutes">{{vmIdleStopLabel(minutes)}}</option><option v-if="state.idleStopMinutes!==undefined&&!VM_IDLE_STOP_OPTIONS.some(n=>n===state!.idleStopMinutes)" :value="state.idleStopMinutes">{{vmIdleStopLabel(state.idleStopMinutes)}}</option></select></label>
   <p v-if="state.idleStopMinutes===undefined">连接并更新执行节点后可修改。</p><p v-else-if="state.idleStopMinutes===0">空闲时保持运行；仍可手动停止，执行节点关闭时也会停止。</p>
  </article>
  <article v-if="state&&!state.setupRequired"><h3>准备运行环境</h3><p v-if="state?.executionHost==='runner'">以下检查和镜像准备均在执行节点所在电脑完成。</p><ol>
   <li><span class="step">{{state?.runtime?'✓':'1'}}</span><div><strong>安装 Docker 或 Podman</strong><p>{{state?.runtime?`已检测到 ${state.runtime}`:'请先安装 Docker Desktop 或 Podman。'}}</p></div></li>
   <li><span class="step">{{state?.daemonUp?'✓':'2'}}</span><div><strong>启动容器运行环境</strong><p>{{state?.daemonUp?'运行环境已启动':'打开 Docker / Podman，等待它完成启动后重新检查。'}}</p></div></li>
   <li><span class="step">{{state?.image?'✓':'3'}}</span><div class="image-preparation"><strong>准备虚拟机镜像</strong><p>两个镜像可分别准备；每个账号的虚拟机使用其中一个。旧版本准备的镜像需要重新准备，已有虚拟机会在下次启动桌面时自动换用新镜像，数据保留。</p><label>镜像<select v-model="prepareImage" :disabled="acting||state.busy"><option v-for="image in LOCAL_VM_IMAGES" :key="image.key" :value="image.key">{{image.name}} · {{state.images?.find(i=>i.key===image.key)?.ready?'已就绪':'未准备'}}</option></select></label><p>{{LOCAL_VM_IMAGES.find(i=>i.key===prepareImage)?.description}}{{prepareImage==='cursor'?'；Apple 芯片电脑需要运行环境支持 amd64 模拟。':''}}</p><button class="primary" :disabled="acting||state?.busy||!state?.daemonUp" @click="prepare">{{state?.busy?'正在准备…':state.images?.find(i=>i.key===prepareImage)?.ready?'重新检查所选镜像':'准备所选镜像'}}</button></div></li>
   <li><span class="step">4</span><div><strong>开通账号并启动桌面</strong><p>在“用户与权限”中为子账号开通虚拟机；然后在机器人聊天右上角的“电脑”中启动该机器人的桌面。</p></div></li>
  </ol></article>
  <article v-if="state"><h3>本账号的虚拟机</h3><p v-if="!state.instances?.length">还没有创建虚拟机。</p>
   <div v-for="item in state.instances" :key="item.id" class="instance"><div><strong>{{item.name}}</strong><p>{{item.status==='free'?'已停止':item.status==='idle'?'运行中 · 空闲':item.status==='active'?'正在使用':'待核对'}}{{item.desktops!==undefined?` · ${item.desktops} 个机器人桌面`:''}}</p></div><div class="row"><button :disabled="acting||item.status==='free'||item.status==='active'" @click="instance(item.id,'stop')">停止</button><button :disabled="acting||item.status==='active'" @click="instance(item.id,'remove')">移除实例</button></div></div>
  </article>
  </template>
 </section>
</template>
<style scoped>
.local-vm-settings{display:grid;gap:16px;max-width:820px}article{padding:20px;border:1px solid var(--line);border-radius:14px;display:grid;gap:12px;background:var(--surface)}h3,p{margin:0}h3{font-size:15px}p{font-size:13px;line-height:1.7;color:var(--text-secondary)}.row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.status{display:inline-flex;align-items:center;gap:7px;font-size:13px}.segmented{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}.segmented button{flex:1;border:0;border-radius:0}.segmented button[aria-pressed=true]{background:var(--surface-soft);font-weight:600}.instance{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--line)}button,select{font:inherit;color:var(--text-primary);background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;min-height:40px;padding:7px 12px}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:var(--accent);color:var(--text-on-solid);margin-top:8px}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}ol{list-style:none;margin:0;padding:0;display:grid;gap:20px}li{display:flex;gap:12px}.step{display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;height:26px;width:26px;flex:none;font-size:12px}li strong{font-size:13px}[role=alert]{color:var(--danger)}
</style>
<style scoped>.image-preparation{display:grid;gap:10px;min-width:0}.image-preparation label{display:grid;gap:6px}.image-preparation select{width:100%;min-height:44px}.image-preparation button{justify-self:start}</style>
