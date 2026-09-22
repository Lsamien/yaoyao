<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {apiRequest} from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import type {DesktopEnvironmentState} from '@shared/desktopEnvironment'
import GrokAuthPanel from './GrokAuthPanel.vue'
import {type WorkspaceAgent} from '@shared/workspace'
import type {ComputerFrame} from '@shared/computerControl'
import {vmIdleStopLabel,type LocalVmInstance,type LocalVmAction} from '@shared/localVm'
const props=defineProps<{agents:WorkspaceAgent[];isAdmin:boolean;active?:boolean;embedded?:boolean}>()
const emit=defineEmits<{close:[];changed:[];settings:[];desktop:[agent:WorkspaceAgent,backend?:'desktop'|'cloud'|'vm',host?:string];workspace:[agent:WorkspaceAgent]}>()
const selected=ref(''),state=ref<LocalVmInstance&{enabled:boolean;controlMode?:string}>(),frame=ref<ComputerFrame>(),error=ref(''),busy=ref(false),loading=ref(true)
const agent=computed(()=>props.agents.find(a=>a.id===selected.value))
const native=ref<DesktopEnvironmentState>()
const computers=ref({scriptMachine:true,serverComputer:true,vm:true,cloud:true})
const showDesktop=computed(()=>computers.value.scriptMachine||computers.value.serverComputer)
const cloud=ref<{configured:boolean;running:boolean;connected:boolean;mode?:string}>(),connectionSettings=ref(false)
const showCloud=computed(()=>computers.value.cloud)
const showVm=computed(()=>computers.value.vm&&!!state.value)
const composeDesktopId=ref('')
const composeDesktop=computed(()=>state.value?.desktops?.find(d=>d.id===composeDesktopId.value))
const composeConnected=computed(()=>!!state.value?.enabled&&state.value.desktopId===composeDesktopId.value)
const canConnectCompose=computed(()=>state.value?.fixedCapacity&&!busy.value&&!state.value.inUse&&!agent.value?.temporaryGoalId&&!composeConnected.value&&composeDesktop.value?.online&&composeDesktop.value.ready&&composeDesktop.value.available!==false)
watch(()=>state.value,value=>{
 if(!value?.fixedCapacity){composeDesktopId.value='';return}
 if(value.desktops?.some(d=>d.id===composeDesktopId.value))return
 const available=value.desktops?.filter(d=>d.online&&d.ready&&d.available!==false)??[]
 composeDesktopId.value=value.desktopId??(available.length===1?available[0]!.id:'')
})
const desktopHosts=computed(()=>(native.value?.hosts??[]).filter(host=>host.id==='local'?computers.value.serverComputer:computers.value.scriptMachine))
const serverHost=computed(()=>desktopHosts.value.find(host=>host.id==='local'))
const activeEnvLine=computed(()=>[
 computers.value.serverComputer?'服务器':'',computers.value.scriptMachine?'电脑':'',
 computers.value.cloud?'云端':'',computers.value.vm?'虚拟机':'',
].filter(Boolean).join(' · '))
const previewTargets=computed(()=>{
 const list:{key:string;label:string;backend:'desktop'|'cloud'|'vm';host?:string}[]=[]
 if(computers.value.scriptMachine||computers.value.serverComputer)for(const h of desktopHosts.value){list.push({key:'desktop:'+h.id,label:(h.id==='local'?'服务器 · '+(h.name||'服务器'):'电脑 · '+(h.name||'未命名'))+(h.online?'':' · 离线'),backend:'desktop',host:h.id})}
 if(computers.value.cloud&&cloud.value?.configured)list.push({key:'cloud',label:'云端 · Grok Bot',backend:'cloud'})
 if(computers.value.vm)list.push({key:'vm',label:'虚拟环境',backend:'vm'})
 return list
})
const previewKey=ref('')
const automaticPreviewTarget=computed(()=>{
 const vm=previewTargets.value.find(target=>target.backend==='vm')
 if(vm&&state.value?.enabled&&state.value.container==='running'&&state.value.ready&&!state.value.problem)return vm
 return previewTargets.value.find(target=>target.backend!=='desktop'||desktopHosts.value.some(host=>host.id===target.host&&host.online))
})
const previewTarget=computed(()=>previewKey.value?previewTargets.value.find(t=>t.key===previewKey.value):automaticPreviewTarget.value)
const previewLoading=ref(false)
const previewEmptyText=computed(()=>{
 const target=previewTarget.value
 if(!target)return previewKey.value?'所选电脑已不可用，请重新选择':'暂无已开放的电脑'
 if(target.backend==='desktop'){const host=native.value?.hosts?.find(h=>h.id===target.host);return !host?.online?'这台电脑已离线':host.local.ready?'正在读取电脑画面…':'请完成这台电脑的屏幕控制授权'}
 if(target.backend==='cloud')return cloud.value?.configured?(cloud.value?.running?'正在连接桌面…':'打开云端电脑后可查看桌面'):'尚未连接 Grok Bot 账号'
 if(!state.value?.enabled)return state.value?.fixedCapacity?'请先连接下方的共享桌面':'未使用电脑'
 if(state.value.problem)return state.value.problem
 if(!state.value.image)return '本地虚拟机尚未准备'
 if(state.value.container==='missing')return '尚未创建虚拟机'
 if(state.value.container==='stopped')return '虚拟机已停止'
 return '正在连接桌面…'
})
function authorizeHost(hostId:string,scope?:'full'){
 const body:{hostId?:string;scope?:'full'}={}
 if(hostId)body.hostId=hostId
 if(scope)body.scope=scope
 void run(()=>apiRequest(`/api/app/agents/${selected.value}/desktop-environment/authorize`,{method:'POST',body,timeoutMs:125000}))
}
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,revision=0,previewRevision=0
const base=()=>`/api/app/agents/${encodeURIComponent(selected.value)}/local-vm`
async function refreshFrame(){
 if(closed||props.active===false||!selected.value||document.hidden||busy.value)return
 const version=++previewRevision,id=selected.value,target=previewTarget.value
 const usable=target?.backend==='vm'?state.value?.container==='running'&&state.value?.ready
  :target?.backend==='cloud'?!!cloud.value?.running&&!!cloud.value?.connected
  :target?.backend==='desktop'&&desktopHosts.value.some(h=>h.id===target.host&&h.online&&h.local.ready)
 if(!target||!usable){frame.value=undefined;previewLoading.value=false;return}
 previewLoading.value=true
 try{
  const query=new URLSearchParams({backend:target.backend});if(target.host)query.set('host',target.host)
  const image=await apiRequest<ComputerFrame>(`/api/app/agents/${encodeURIComponent(id)}/computer/frame?${query}`)
  if(version===previewRevision&&!closed&&id===selected.value)frame.value=image
 }catch{if(version===previewRevision&&!closed)frame.value=undefined}
 finally{if(version===previewRevision&&!closed)previewLoading.value=false}
}
watch(()=>previewTarget.value?.key,()=>{previewRevision++;frame.value=undefined;void refreshFrame()},{flush:'sync'})
async function refresh(){
 if(closed||props.active===false||!selected.value||document.hidden||busy.value)return
 const version=revision
 try{
  try{const tools=await apiRequest<{scriptMachine?:boolean;serverComputer?:boolean;vm?:boolean;cloud?:boolean}>('/api/app/settings/host-tools');if(version===revision&&!closed)computers.value={scriptMachine:tools.scriptMachine!==false,serverComputer:tools.serverComputer!==false,vm:tools.vm!==false,cloud:tools.cloud!==false}}catch{}
  const id=selected.value
  const [desktopResult,cloudResult,vmResult]=await Promise.all([
   apiRequest<DesktopEnvironmentState>(`/api/app/agents/${id}/desktop-environment`),
   apiRequest<typeof cloud.value>(`/api/app/agents/${id}/cloud-computer`),
   computers.value.vm?apiRequest<typeof state.value>(base()):Promise.resolve(undefined),
  ])
  if(version!==revision||closed)return
  native.value=desktopResult;cloud.value=cloudResult;state.value=vmResult
  await refreshFrame()
  if(version!==revision||closed)return
  error.value=''
 }catch(e){if(version===revision)error.value=e instanceof Error?e.message:'无法读取电脑画面'}finally{if(version===revision)loading.value=false}
}
async function run(work:()=>Promise<unknown>){let failure='';if(busy.value)return false;busy.value=true;error.value='';try{await work();emit('changed')}catch(e){failure=e instanceof Error&&e.message?e.message:'电脑操作未完成'}finally{busy.value=false;await refresh();if(failure)error.value=failure}return !failure}
async function connectCompose(){
 if(!canConnectCompose.value)return
 const id=selected.value,desktopId=composeDesktopId.value
 if(await run(()=>apiRequest(`/api/app/agents/${encodeURIComponent(id)}/local-vm`,{method:'PUT',body:{enabled:true,desktopId}}))&&selected.value===id)previewKey.value='vm'
}
async function openDesktop(backend:'desktop'|'cloud'|'vm',host?:string){
 const selectedAgent=agent.value
 if(!selectedAgent||busy.value)return
 if(backend==='cloud'&&!await run(()=>apiRequest(`/api/app/agents/${encodeURIComponent(selectedAgent.id)}/cloud-computer/open`,{method:'POST',body:{}})))return
 if(!closed&&agent.value?.id===selectedAgent.id)emit('desktop',selectedAgent,backend,host)
}
async function openPreview(){
 const target=previewTarget.value
 if(target&&frame.value)await openDesktop(target.backend,target.host)
}
function action(value:LocalVmAction){
 if(value==='recreate'&&!confirm('重建这台虚拟机？当前桌面程序将关闭，工作文件和浏览器资料会保留。'))return
 if(value==='remove'&&!confirm('移除这台虚拟机实例以切换镜像？工作文件和浏览器资料会保留。'))return
 void run(()=>apiRequest(base()+'/'+value,{method:'POST',body:{}}))
}
async function cycle(){const version=revision;await refresh();if(!closed&&version===revision)timer=setTimeout(cycle,3000)}
watch(()=>props.agents.map(a=>a.id).join(','),()=>{if(!props.agents.some(a=>a.id===selected.value))selected.value=props.agents[0]?.id??''},{immediate:true})
watch(selected,()=>{revision++;previewRevision++;state.value=undefined;composeDesktopId.value='';native.value=undefined;cloud.value=undefined;frame.value=undefined;error.value='';loading.value=true;previewKey.value='';clearTimeout(timer);void cycle()},{immediate:true})
watch(()=>props.active,value=>{if(value)void refresh()})
onBeforeUnmount(()=>{closed=true;revision++;previewRevision++;clearTimeout(timer)})
</script>
<template>
 <aside class="local-vm-chat-panel" :class="{embedded}" aria-label="机器人电脑面板">
  <header><strong>电脑</strong><button aria-label="关闭电脑面板" @click="emit('close')"><AppIcon name="close"/></button></header>
  <div class="panel-body">
   <label v-if="agents.length>1" class="agent-select">机器人<select v-model="selected" :disabled="busy"><option v-for="item in agents" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
   <p v-if="!agent">当前聊天没有可用的机器人。</p>
   <template v-else>
    <div class="screen-caption"><span>{{agent.name}}的电脑</span><select v-if="previewTargets.length>1||previewKey" v-model="previewKey" :disabled="busy" class="screen-select" aria-label="显示的桌面"><option value="">自动{{previewTarget&&!previewKey?' · '+previewTarget.label:''}}</option><option v-if="previewKey&&!previewTarget" :value="previewKey" disabled>所选电脑不可用</option><option v-for="target in previewTargets" :key="target.key" :value="target.key">{{target.label}}</option></select><small v-else-if="activeEnvLine">{{previewTarget?.label||activeEnvLine}}</small></div>
    <button class="preview" :disabled="!frame||busy" :aria-label="`打开${previewTarget?.label||agent.name}的桌面`" @click="openPreview()">
     <img v-if="frame" :src="`data:image/png;base64,${frame.data}`" :alt="`${previewTarget?.label||agent.name}的电脑画面`">
     <span v-else class="empty"><AppIcon name="monitor" :size="26"/><span>{{loading?'正在检查电脑…':previewLoading?'正在读取所选电脑画面…':previewEmptyText}}</span></span>
     <span v-if="frame" class="open-badge"><AppIcon name="external" :size="12"/>打开桌面</span>
    </button>
    <p v-if="error" class="problem" role="alert">{{error}}</p>
    <p class="hint">电脑开关在 Bot 设置里，对所有机器人一起生效。</p>
    <div class="computer-options">
    <template v-if="showDesktop">
      <p>服务器是运行夭夭服务的电脑；电脑是连接这台服务器的 Mac。两者都可改名。「本机」跟你当前发消息所在的电脑走。要文件用文件工具，要命令用 shell；只有需要看窗口或点按时才截图。</p>
      <div v-for="host in desktopHosts" :key="host.id" class="host-permission" :class="{offline:!host.online}">
       <div class="host-permission-head"><strong>{{host.id==='local'?('服务器 · '+(host.name||'服务器')):('电脑 · '+(host.name||'未命名'))}}</strong><small>{{host.online?'在线':'离线'}}</small></div>
       <div class="permission-list"><span>{{host.local.authorized?'✓':'○'}} 屏幕控制授权</span><span>{{host.local.screen?'✓':'○'}} 屏幕录制</span><span>{{host.local.accessibility?'✓':'○'}} 辅助功能</span><span>{{host.local.fullAuthorized?'✓':'○'}} 文件与命令</span></div>
       <button v-if="host.online&&!host.local.ready" class="primary" :disabled="busy||!isAdmin" @click="authorizeHost(host.id)">在桌面端授权</button>
       <p v-if="host.online&&!host.local.ready" class="hint">在 {{host.id==='local'?'这台':host.name}} Mac 上确认授权，并按系统提示开启权限；系统可能要求重新打开 App。</p>
       <button v-if="host.online&&!host.local.fullAuthorized" :disabled="busy||!isAdmin" @click="authorizeHost(host.id,'full')">授权文件与命令</button>
       <p v-if="host.online&&!host.local.fullAuthorized" class="hint">授权后，机器人可以在这台 Mac 的用户主目录内读写文件并执行命令；每台电脑单独授权，可随时撤销。</p>
      </div>
      <button v-if="serverHost" class="primary" :disabled="busy||!serverHost.online||!serverHost.local.ready" @click="openDesktop('desktop','local')">接管服务器</button>
    </template>
    <template v-if="showCloud">
     <p>多个机器人共用同一台 Grok Bot 云端虚拟机、工作文件和浏览器登录。基础机器人和聊天记录保持独立。</p>
     <button v-if="cloud?.configured" class="primary" :disabled="busy" @click="openDesktop('cloud')">{{cloud?.mode==='human'?'打开控制中的桌面':'接管云端电脑'}}</button>
     <button @click="connectionSettings=!connectionSettings">{{cloud?.configured?'云端连接设置':'连接 Grok Bot'}}</button>
     <p v-if="!isAdmin&&!cloud?.configured" class="hint">请由管理员为当前账号配置 Grok Bot 连接。</p>
    </template>
    <template v-if="showVm&&state">
     <p>{{agent.temporaryGoalId?'临时助手的电脑由当前任务管理':state.fixedCapacity||state.mode==='shared'?'共享虚拟机 · 与其他成员共用桌面和工作文件':'此机器人的独立虚拟机'}}</p>
     <p v-if="state.problem" class="problem" role="alert" aria-label="本地虚拟机状态">{{state.problem}}</p>
     <template v-if="state.fixedCapacity&&!agent.temporaryGoalId">
      <label>共享桌面<select v-model="composeDesktopId" aria-label="共享桌面" :disabled="busy||state.inUse"><option value="" disabled>请选择共享桌面</option><option v-for="desktop in state.desktops" :key="desktop.id" :value="desktop.id" :disabled="!desktop.online||!desktop.ready||desktop.available===false">{{desktop.name}}{{desktop.available===false?' · 不可用':!desktop.online?' · 离线':!desktop.ready?' · 正在启动':''}}</option></select></label>
      <button class="primary" data-testid="connect-compose-desktop" :disabled="!canConnectCompose" @click="connectCompose">{{composeConnected?'已连接':'连接所选桌面'}}</button>
      <p v-if="!state.desktops?.length" class="hint">暂无可连接的共享桌面，请检查本地虚拟机设置。</p>
     </template>
     <template v-if="!state.fixedCapacity&&state.images?.length&&!agent.temporaryGoalId">
      <label>虚拟机镜像<select :value="state.imageKey??''" :disabled="busy||state.inUse||state.container!=='missing'" @change="run(()=>apiRequest(base()+'/image',{method:'PUT',body:{imageKey:($event.target as HTMLSelectElement).value}}))"><option v-if="!state.imageKey" value="" disabled>{{state.image?'当前保留的镜像':'请选择已准备的镜像'}}</option><option v-for="image in state.images" :key="image.key" :value="image.key" :disabled="!image.ready">{{image.name}}{{image.ready?'':' · 未准备'}}</option></select></label>
      <p class="hint">{{state.mode==='shared'?'同一共享桌面只能使用一个镜像，选择会对所有共享成员生效。':'此桌面的镜像、文件和浏览器资料与其他独立桌面分开。'}}{{state.container!=='missing'?'切换镜像前请先移除实例。':''}}</p>
     </template>
     <button v-if="!state.fixedCapacity&&!state.image" class="primary" :disabled="!isAdmin" @click="emit('settings')">设置本地虚拟机</button>
     <button v-else-if="!state.fixedCapacity&&state.container==='missing'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('create')">创建 {{agent.name}} 的虚拟机</button>
     <button v-else-if="!state.fixedCapacity&&state.container==='stopped'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('start')">启动虚拟机</button>
     <template v-else-if="state.container==='running'">
      <button class="primary" :disabled="!state.ready||busy" @click="openDesktop('vm')">打开桌面</button>
      <button v-if="state.mode==='per-bot'" :disabled="busy" @click="emit('workspace',agent)"><AppIcon name="panel"/>打开双桌面</button>
      <p class="control-state">{{state.controlMode==='human'?'你或其他操作者正在控制电脑':state.inUse?'机器人正在操作':'仅查看 · 虚拟机空闲'}}</p>
     </template>
     <div v-if="!state.fixedCapacity&&state.container!=='missing'&&!agent.temporaryGoalId" class="vm-actions"><button :disabled="busy||state.inUse" @click="action('stop')">停止虚拟机</button><button :disabled="busy||state.inUse" @click="action('recreate')">重建虚拟机</button><button :disabled="busy||state.inUse" @click="action('remove')">移除实例</button></div>
     <p class="hint">{{state.fixedCapacity?'桌面由 Compose 创建，数量固定。这里只连接已有共享桌面；工作目录为 /home/cua/workspace。':`重建会保留工作目录和浏览器资料。${vmIdleStopLabel(state.idleStopMinutes)}，可在设置中修改。`}}</p>
     <button v-if="isAdmin" class="settings-link" @click="emit('settings')"><AppIcon name="settings" :size="14"/>本地虚拟机设置</button>
    </template>
    </div>
    <button v-if="!showCloud" class="settings-link" @click="connectionSettings=!connectionSettings"><AppIcon name="globe" :size="14"/>Grok Bot 云端连接</button>
    <GrokAuthPanel v-if="connectionSettings" :is-admin="isAdmin" @changed="emit('changed');refresh()"/>
   </template>
  </div>
 </aside>
</template>
<style scoped>.host-environment-option{display:flex;align-items:center;gap:8px;min-height:44px;font-size:13px;cursor:pointer}.host-environment-option input{width:16px;height:16px;accent-color:var(--accent)}.vm-execution-option select{min-height:44px;min-width:0;width:100%}.vm-execution-option .hint{line-height:1.6}</style>
<style scoped>
.local-vm-chat-panel{width:400px;min-width:320px;max-width:46%;height:100%;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}header button{border:0;min-height:32px;padding:5px}.panel-body{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px 20px}.screen-caption{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)}.screen-select{max-width:58%;min-height:30px;padding:4px 8px;font-size:12px;border-radius:7px}.preview{flex:none;position:relative;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;border:0;border-radius:12px;overflow:hidden;padding:0;background:#14181e;color:#dce1e7;width:100%}.preview:disabled{opacity:1;cursor:default}.preview img{width:100%;height:100%;object-fit:contain}.empty{display:grid;justify-items:center;gap:12px;font-size:13px}.open-badge{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:4px;padding:5px 7px;background:#000b;color:white;border-radius:6px;font-size:11px}p{margin:0;font-size:13px;line-height:1.65;color:var(--text-secondary)}label{display:grid;gap:7px;font-size:13px}button,select{font:inherit;background:var(--surface-raised);color:inherit;border:1px solid var(--line);border-radius:8px;min-height:40px;padding:8px 12px}button{cursor:pointer;display:inline-flex;gap:7px;align-items:center;justify-content:center}button:disabled,select:disabled{opacity:.45;cursor:default}.primary{background:var(--accent);color:var(--text-on-solid)}.vm-actions{display:flex;gap:8px}.vm-actions button{flex:1;font-size:12px}.hint{font-size:12px;color:var(--text-muted)}.problem{color:var(--danger)}.settings-link{border:0;background:transparent;align-self:flex-start;padding-left:0;font-size:12px}.control-state{padding:10px;border-radius:8px;background:var(--surface-soft)}.host-permission{display:grid;gap:7px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft)}.host-permission.offline{opacity:.6}.host-permission-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.host-permission-head strong{font-size:12.5px}.host-permission-head small{font-size:11px;color:var(--text-muted)}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:900px){.local-vm-chat-panel{position:fixed;inset:0 0 0 auto;width:min(400px,100vw);max-width:100%;z-index:35;box-shadow:-20px 0 60px #0002}}
.computer-select{display:grid;gap:7px;font-size:13px;min-width:0}
.env-checks{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft)}
.env-check{display:flex;align-items:flex-start;gap:9px;padding:11px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer;min-width:0}
.env-check:hover:not(:has(input:disabled)){background:var(--surface-hover)}
.env-check.selected{background:color-mix(in srgb,var(--success) 8%,transparent)}
.env-check input{flex:none;width:16px;height:16px;margin:1px 0 0;accent-color:var(--success)}
.env-check span{display:grid;gap:4px;min-width:0}
.env-check b{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;color:var(--text-primary)}
.env-check small,.env-checks .env-hint{font-size:11px;line-height:1.5;color:var(--text-muted)}
.env-hint{grid-column:1/-1;margin:0}
.computer-tabs{display:flex;gap:4px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft);overflow-x:auto}
.computer-tabs button{flex:1 0 auto;min-height:40px;padding:8px 12px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary);font-size:12px;white-space:nowrap}
.computer-tabs button[aria-selected="true"]{background:var(--surface);color:var(--text-primary);font-weight:600;box-shadow:0 1px 3px #00000014}
.computer-tabs button:hover:not(:disabled):not([aria-selected="true"]){background:var(--surface-hover)}
.computer-tabs button:focus-visible{outline-offset:-2px}
.computer-options{display:flex;flex-direction:column;gap:14px}
.computer-options:empty{display:none}
.screen-caption{gap:8px}.screen-select{min-height:44px;min-width:0}
</style>

<style scoped>.cloud-settings{display:grid;gap:10px;padding:14px;border:1px solid var(--line);border-radius:10px}.cloud-settings input{min-height:44px;font:inherit;color:var(--text-primary);background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}.computer-tabs{display:grid;grid-template-columns:1fr 1fr;overflow:visible}.computer-tabs button{text-align:left;justify-content:flex-start;white-space:normal;min-height:48px}</style>

<style scoped>.computer-tabs{gap:8px;border:0;padding:0;background:transparent}.computer-tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:12px;border:1px solid var(--line);background:var(--surface-soft);min-height:82px}.computer-tabs button span{display:flex;align-items:center;gap:6px;font-weight:500}.computer-tabs button small{font-size:11px;line-height:1.5;color:var(--text-muted)}.computer-tabs button[aria-selected=true]{border-color:var(--accent);background:var(--surface-raised);box-shadow:none}.computer-tabs button:disabled{opacity:.55}</style>

<style scoped>.permission-list{display:grid;gap:8px;font-size:13px;color:var(--text-secondary)}</style>
