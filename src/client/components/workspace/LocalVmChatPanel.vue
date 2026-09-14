<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {apiRequest} from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import type {DesktopEnvironmentState,BotBrowserState} from '@shared/desktopEnvironment'
import GrokAuthPanel from './GrokAuthPanel.vue'
import {supportsHostEnvironment,type WorkspaceAgent} from '@shared/workspace'
import type {ComputerFrame} from '@shared/computerControl'
import {vmIdleStopLabel,type LocalVmInstance,type LocalVmAction} from '@shared/localVm'
const props=defineProps<{agents:WorkspaceAgent[];isAdmin:boolean;active?:boolean;embedded?:boolean}>()
const emit=defineEmits<{close:[];changed:[];settings:[];desktop:[agent:WorkspaceAgent];workspace:[agent:WorkspaceAgent]}>()
const selected=ref(''),state=ref<LocalVmInstance&{enabled:boolean;controlMode?:string}>(),frame=ref<ComputerFrame>(),error=ref(''),busy=ref(false),loading=ref(true)
const agent=computed(()=>props.agents.find(a=>a.id===selected.value))
const native=ref<DesktopEnvironmentState>()
const nativeSelected=computed(()=>native.value?.selected)
const computerTabs=ref<HTMLElement>(),cloud=ref<{configured:boolean;running:boolean;connected:boolean;mode?:string}>(),connectionSettings=ref(false)
const cloudSelected=computed(()=>agent.value?.computer==='cloud'||(agent.value?.computer==='auto'&&!nativeSelected.value&&agent.value.execution!=='computer'&&cloud.value?.configured))
const computerChoice=computed(()=>state.value?.fixedCapacity&&agent.value?.execution==='computer'?(state.value.desktopId??'off'):agent.value?.computer??(state.value?.enabled?'vm':'off'))
const canAllowHost=computed(()=>!!agent.value&&supportsHostEnvironment(agent.value))
const localVmSelected=computed(()=>canAllowHost.value&&!cloudSelected.value)
const computerChoices=computed(()=>[
 {value:'auto',label:'自动',description:'按可用环境自动选择',icon:'bolt' as const,disabled:false},
 {value:'cloud',label:'云端 · Grok Bot',description:'共享云端电脑，持续保存工作',icon:'globe' as const,disabled:false},
 ...(state.value?.fixedCapacity?(state.value.desktops??[]).map(desktop=>({value:desktop.id,label:desktop.name,description:(desktop.imageKey==='cursor'?'Cursor Universal · ':'标准桌面 · ')+(desktop.ready?'已就绪':'尚未就绪'),icon:'monitor' as const,disabled:desktop.available===false})):[{value:'vm',label:'本地虚拟机',description:'在隔离的本地桌面中工作',icon:'monitor' as const,disabled:false}]),
 {value:'local',label:'本机',description:native.value?.host?.name??'请在电脑上打开夭夭桌面端',icon:'monitor' as const,disabled:!native.value?.local.supported},
 {value:'browser',label:'仅浏览器',description:native.value?.browser.available?'独立浏览器，保存登录资料':'请在电脑上打开夭夭桌面端',icon:'globe' as const,disabled:!native.value?.browser.available},
 {value:'off',label:'不使用电脑',description:'使用基础机器人的其他工具',icon:'stop' as const,disabled:false},
])
const computerChoiceDisabled=computed(()=>loading.value||!state.value||busy.value||state.value.inUse||!!agent.value?.remoteAgentId||!!agent.value?.temporaryGoalId)
function selectComputer(value:string){
 if(computerChoiceDisabled.value||value===computerChoice.value||!computerChoices.value.some(option=>option.value===value&&!option.disabled))return
 choose(value)
}
function moveComputerTab(event:KeyboardEvent){
 const tabs=[...(computerTabs.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')??[])]
 const index=tabs.indexOf(event.target as HTMLButtonElement)
 if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
 event.preventDefault()
 const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length
 tabs[next]?.focus()
}
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,revision=0
const base=()=>`/api/app/agents/${encodeURIComponent(selected.value)}/local-vm`
async function refresh(){
 if(closed||props.active===false||!selected.value||document.hidden||busy.value)return
 const version=revision
 try{
  native.value=await apiRequest<DesktopEnvironmentState>(`/api/app/agents/${selected.value}/desktop-environment`);if(version!==revision||closed)return
  if(nativeSelected.value){
   const n=native.value;let ready=n.local.ready
   if(nativeSelected.value==='browser'){const b=await apiRequest<BotBrowserState>(`/api/app/agents/${selected.value}/browser`);ready=b.open}
   state.value={enabled:true,container:ready?'running':'stopped',ready,image:true,mode:'shared',maxInstances:1,inUse:false}
   if(ready){const f=await apiRequest<ComputerFrame>(`/api/app/agents/${selected.value}/computer/frame`);if(version===revision&&!closed)frame.value=f}else frame.value=undefined
   error.value='';return
  }
  const cloudState=await apiRequest<typeof cloud.value>(`/api/app/agents/${selected.value}/cloud-computer`);if(version!==revision||closed)return;cloud.value=cloudState
  if(cloudSelected.value){
   state.value={enabled:true,container:cloudState?.running?'running':'stopped',ready:!!cloudState?.connected&&!!cloudState?.running,image:!!cloudState?.configured,mode:'shared',maxInstances:1,inUse:cloudState?.mode==='agent'||cloudState?.mode==='human',controlMode:cloudState?.mode}
   if(state.value.ready){const image=await apiRequest<ComputerFrame>(`/api/app/agents/${selected.value}/computer/frame`);if(version===revision&&!closed)frame.value=image}else frame.value=undefined
   error.value='';return
  }
  const result=await apiRequest<typeof state.value>(base());if(version!==revision||closed)return;state.value=result
  if(result?.container==='running'&&result.ready){const image=await apiRequest<ComputerFrame>(`/api/app/agents/${selected.value}/computer/frame`);if(version===revision&&!closed)frame.value=image}
  else frame.value=undefined
  error.value=''
 }catch(e){if(version===revision)error.value=e instanceof Error?e.message:'无法读取电脑画面'}finally{if(version===revision)loading.value=false}
}
async function run(work:()=>Promise<unknown>){if(busy.value)return;busy.value=true;error.value='';try{await work();emit('changed')}catch(e){error.value=e instanceof Error?e.message:'电脑操作未完成'}finally{busy.value=false;await refresh()}}
function choose(value:string){
 if(state.value?.fixedCapacity&&!['off','auto','cloud','local','browser','vm'].includes(value)){
   void run(()=>apiRequest(base(),{method:'PUT',body:{enabled:true,desktopId:value}}));return
 }
 void run(()=>apiRequest(`/api/app/agents/${selected.value}/computer-selection`,{method:'PUT',body:{computer:value}}))
}
function allowHostEnvironment(enabled:boolean){
 if(!canAllowHost.value||computerChoiceDisabled.value)return
 const computer=agent.value?.computer==='cloud'?'cloud':'vm'
 void run(()=>apiRequest(`/api/app/agents/${selected.value}/computer-selection`,{method:'PUT',body:{computer,allowHostEnvironment:enabled}}))
}
function chooseVmExecution(value:string){
 if(computerChoiceDisabled.value||!localVmSelected.value)return
 void run(()=>apiRequest(`/api/app/agents/${selected.value}/computer-selection`,{method:'PUT',body:{computer:'vm',vmExecution:value,allowHostEnvironment:value==='profile'}}))
}
async function openDesktop(){if(!agent.value)return;if(cloudSelected.value){await run(()=>apiRequest(`/api/app/agents/${selected.value}/cloud-computer/open`,{method:'POST',body:{}}));if(error.value)return}emit('desktop',agent.value)}
function action(value:LocalVmAction){
 if(value==='recreate'&&!confirm('重建这台虚拟机？当前桌面程序将关闭，工作文件和浏览器资料会保留。'))return
 if(value==='remove'&&!confirm('移除这台虚拟机实例以切换镜像？工作文件和浏览器资料会保留。'))return
 void run(()=>apiRequest(base()+'/'+value,{method:'POST',body:{}}))
}
async function cycle(){const version=revision;await refresh();if(!closed&&version===revision)timer=setTimeout(cycle,3000)}
watch(()=>props.agents.map(a=>a.id).join(','),()=>{if(!props.agents.some(a=>a.id===selected.value))selected.value=props.agents[0]?.id??''},{immediate:true})
watch(selected,()=>{revision++;state.value=undefined;native.value=undefined;cloud.value=undefined;frame.value=undefined;error.value='';loading.value=true;clearTimeout(timer);void cycle()},{immediate:true})
watch(()=>props.active,value=>{if(value)void refresh()})
onBeforeUnmount(()=>{closed=true;revision++;clearTimeout(timer)})
</script>
<template>
 <aside class="local-vm-chat-panel" :class="{embedded}" aria-label="机器人电脑面板">
  <header><strong>电脑</strong><button aria-label="关闭电脑面板" @click="emit('close')"><AppIcon name="close"/></button></header>
  <div class="panel-body">
   <label v-if="agents.length>1" class="agent-select">机器人<select v-model="selected" :disabled="busy"><option v-for="item in agents" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
   <p v-if="!agent">当前聊天没有可用的机器人。</p>
   <template v-else>
    <div class="screen-caption"><span>{{agent.name}}的电脑</span><small v-if="state?.enabled">{{nativeSelected?(native?.host?.name??'桌面端离线'):cloudSelected?'Grok Bot 云端':'本地虚拟机'}}</small></div>
    <button class="preview" :disabled="!frame||busy" :aria-label="`打开${agent.name}的桌面`" @click="openDesktop">
     <img v-if="frame" :src="`data:image/png;base64,${frame.data}`" :alt="`${agent.name}的电脑画面`">
     <span v-else class="empty"><AppIcon name="monitor" :size="26"/><span>{{loading?'正在检查电脑…':nativeSelected?(nativeSelected==='browser'?'点击打开机器人的独立浏览器':native?.local.ready?'正在读取本机画面…':'请完成本机控制授权'):!state?.enabled?(computerChoice==='auto'?'暂无可用电脑':'未使用电脑'):!state.image?(cloudSelected?'尚未连接 Grok Bot 账号':'本地虚拟机尚未准备'):state.container==='missing'?'尚未创建虚拟机':state.container==='stopped'?'虚拟机已停止':cloudSelected?'打开云端电脑后可查看桌面':'正在连接桌面…'}}</span></span>
     <span v-if="frame" class="open-badge"><AppIcon name="external" :size="12"/>打开桌面</span>
    </button>
    <p v-if="error||state?.problem" class="problem" role="alert">{{error||state?.problem}}</p>
    <div class="computer-select">
     <span>此机器人使用的电脑</span>
     <div ref="computerTabs" class="computer-tabs" role="tablist" aria-label="此机器人使用的电脑" @keydown="moveComputerTab">
      <button v-for="option in computerChoices" :id="`computer-tab-${selected}-${option.value}`" :key="option.value" type="button" role="tab" :aria-selected="computerChoice===option.value" :aria-controls="`computer-options-${selected}`" :tabindex="computerChoice===option.value?0:-1" :aria-label="option.label" :title="option.description" :disabled="computerChoiceDisabled||option.disabled" @click="selectComputer(option.value)"><span><AppIcon :name="computerChoice===option.value?'check':option.icon" :size="15"/>{{option.label}}</span><small>{{option.description}}</small></button>
     </div>
    </div>
    <div :id="`computer-options-${selected}`" class="computer-options" role="tabpanel" :aria-labelledby="`computer-tab-${selected}-${computerChoice}`">
    <p v-if="computerChoice==='auto'" class="hint">按已有可用环境自动选择。查看此面板不会创建或唤醒云端电脑。</p>
    <label v-if="localVmSelected" class="vm-execution-option">执行方式
     <select aria-label="本地虚拟机执行方式" :value="agent.vmExecution??'worker'" :disabled="computerChoiceDisabled" @change="chooseVmExecution(($event.target as HTMLSelectElement).value)">
      <option value="worker">虚拟机模式</option><option value="profile">本机协作模式</option>
     </select>
     <span class="hint">{{agent.vmExecution==='profile'?'使用基础机器人的完整本机环境，同时操作这台虚拟机。文件和程序仍属于各自的电脑。':'使用独立的虚拟机执行环境，可按需允许本机文件和命令。'}}</span>
    </label>
    <label v-if="canAllowHost&&(!localVmSelected||agent.vmExecution!=='profile')" class="host-environment-option"><input type="checkbox" :checked="agent.allowHostEnvironment===true" :disabled="computerChoiceDisabled" @change="allowHostEnvironment(($event.target as HTMLInputElement).checked)"> 允许本机环境</label>
    <template v-if="canAllowHost&&agent.allowHostEnvironment">
     <p class="hint">允许 Bot 同时使用 Hermes 所在电脑的文件和命令。{{cloudSelected?'云端虚拟机仍使用独立的云端工具和文件。':'虚拟机工具仍在隔离 Linux 桌面内执行。'}}上方显示虚拟机画面。</p>
     <p v-if="native?.local.ready" class="hint">已连接 {{native.host?.name}}，Bot 也可操作本机桌面。</p>
     <button v-else-if="native?.local.supported" :disabled="busy||!isAdmin" @click="run(()=>apiRequest(`/api/app/agents/${selected}/desktop-environment/authorize`,{method:'POST',body:{},timeoutMs:125000}))">授权本机桌面操作</button>
    </template>
    <template v-if="nativeSelected">
     <p>{{nativeSelected==='local'?'机器人将查看并操作已连接电脑的真实桌面。':'浏览器在已连接的桌面端运行，机器人和你使用同一组标签页。'}}连接电脑：{{native?.host?.name??'未连接'}}。</p>
     <template v-if="nativeSelected==='local'">
      <div class="permission-list"><span>{{native?.local.authorized?'✓':'○'}} 本机控制授权</span><span>{{native?.local.screen?'✓':'○'}} 屏幕录制</span><span>{{native?.local.accessibility?'✓':'○'}} 辅助功能</span></div>
      <button v-if="!native?.local.ready" class="primary" :disabled="busy||!native?.online||!isAdmin" @click="run(()=>apiRequest(`/api/app/agents/${selected}/desktop-environment/authorize`,{method:'POST',body:{},timeoutMs:125000}))">在桌面端授权</button>
      <p v-if="!native?.local.ready" class="hint">在连接的 Mac 上确认授权，并按系统提示开启权限；系统可能要求重新打开 App。</p>
     </template>
     <label v-else>浏览器资料<select :value="native?.browser.profile" :disabled="busy" @change="run(()=>apiRequest(`/api/app/agents/${selected}/browser-profile`,{method:'PUT',body:{profile:($event.target as HTMLSelectElement).value}}))"><option value="persistent">此机器人的浏览器 · 保存登录</option><option value="temporary">临时浏览器 · 退出桌面端后清除</option></select></label>
     <button class="primary" :disabled="busy||!native?.online||(nativeSelected==='local'&&!native?.local.ready)" @click="openDesktop">{{nativeSelected==='browser'?'打开浏览器':'接管本机'}}</button>
    </template>
    <template v-else-if="cloudSelected">
     <p>多个机器人共用同一台 Grok Bot 云端虚拟机、工作文件和浏览器登录。基础机器人和聊天记录保持独立。</p>
     <button v-if="cloud?.configured" class="primary" :disabled="busy" @click="openDesktop">{{state?.controlMode==='human'?'打开控制中的桌面':'接管云端电脑'}}</button>
     <button @click="connectionSettings=!connectionSettings">{{cloud?.configured?'云端连接设置':'连接 Grok Bot'}}</button>
     <p v-if="!isAdmin&&!cloud?.configured" class="hint">请由管理员为当前账号配置 Grok Bot 连接。</p>
    </template>
    <template v-else-if="state?.enabled">
     <p>{{agent.temporaryGoalId?'临时助手的电脑由当前任务管理':state.mode==='shared'?'共享虚拟机 · 与其他成员共用桌面和工作文件':'此机器人的独立虚拟机'}}</p>
     <template v-if="!state.fixedCapacity&&state.images?.length&&!agent.temporaryGoalId">
      <label>虚拟机镜像<select :value="state.imageKey??''" :disabled="busy||state.inUse||state.container!=='missing'" @change="run(()=>apiRequest(base()+'/image',{method:'PUT',body:{imageKey:($event.target as HTMLSelectElement).value}}))"><option v-if="!state.imageKey" value="" disabled>{{state.image?'当前保留的镜像':'请选择已准备的镜像'}}</option><option v-for="image in state.images" :key="image.key" :value="image.key" :disabled="!image.ready">{{image.name}}{{image.ready?'':' · 未准备'}}</option></select></label>
      <p class="hint">{{state.mode==='shared'?'同一共享桌面只能使用一个镜像，选择会对所有共享成员生效。':'此桌面的镜像、文件和浏览器资料与其他独立桌面分开。'}}{{state.container!=='missing'?'切换镜像前请先移除实例。':''}}</p>
     </template>
     <button v-if="!state.image" class="primary" :disabled="!isAdmin" @click="emit('settings')">设置本地虚拟机</button>
     <button v-else-if="!state.fixedCapacity&&state.container==='missing'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('create')">创建 {{agent.name}} 的虚拟机</button>
     <button v-else-if="!state.fixedCapacity&&state.container==='stopped'&&!agent.temporaryGoalId" class="primary" :disabled="busy" @click="action('start')">启动虚拟机</button>
     <template v-else-if="state.container==='running'">
      <button class="primary" :disabled="!state.ready||busy" @click="openDesktop">打开桌面</button>
      <button v-if="state.mode==='per-bot'" :disabled="busy" @click="emit('workspace',agent)"><AppIcon name="panel"/>打开双桌面</button>
      <p class="control-state">{{state.controlMode==='human'?'你或其他操作者正在控制电脑':state.inUse?'机器人正在操作':'仅查看 · 虚拟机空闲'}}</p>
     </template>
     <div v-if="!state.fixedCapacity&&state.container!=='missing'&&!agent.temporaryGoalId" class="vm-actions"><button :disabled="busy||state.inUse" @click="action('stop')">停止虚拟机</button><button :disabled="busy||state.inUse" @click="action('recreate')">重建虚拟机</button><button :disabled="busy||state.inUse" @click="action('remove')">移除实例</button></div>
     <p class="hint">{{state.fixedCapacity?'桌面由 Compose 创建，数量固定。这里只连接已有共享桌面；工作目录为 /home/cua/workspace。':`重建会保留工作目录和浏览器资料。${vmIdleStopLabel(state.idleStopMinutes)}，可在设置中修改。`}}</p>
     <button v-if="isAdmin" class="settings-link" @click="emit('settings')"><AppIcon name="settings" :size="14"/>本地虚拟机设置</button>
    </template>
    </div>
    <button v-if="!cloudSelected" class="settings-link" @click="connectionSettings=!connectionSettings"><AppIcon name="globe" :size="14"/>Grok Bot 云端连接</button>
    <GrokAuthPanel v-if="connectionSettings" :is-admin="isAdmin" @changed="emit('changed');refresh()"/>
   </template>
  </div>
 </aside>
</template>
<style scoped>.host-environment-option{display:flex;align-items:center;gap:8px;min-height:44px;font-size:13px;cursor:pointer}.host-environment-option input{width:16px;height:16px;accent-color:var(--accent)}.vm-execution-option select{min-height:44px;min-width:0;width:100%}.vm-execution-option .hint{line-height:1.6}</style>
<style scoped>
.local-vm-chat-panel{width:400px;min-width:320px;max-width:46%;height:100%;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}header button{border:0;min-height:32px;padding:5px}.panel-body{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px 20px}.screen-caption{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)}.preview{flex:none;position:relative;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;border:0;border-radius:12px;overflow:hidden;padding:0;background:#14181e;color:#dce1e7;width:100%}.preview:disabled{opacity:1;cursor:default}.preview img{width:100%;height:100%;object-fit:contain}.empty{display:grid;justify-items:center;gap:12px;font-size:13px}.open-badge{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:4px;padding:5px 7px;background:#000b;color:white;border-radius:6px;font-size:11px}p{margin:0;font-size:13px;line-height:1.65;color:var(--text-secondary)}label{display:grid;gap:7px;font-size:13px}button,select{font:inherit;background:var(--surface-raised);color:inherit;border:1px solid var(--line);border-radius:8px;min-height:40px;padding:8px 12px}button{cursor:pointer;display:inline-flex;gap:7px;align-items:center;justify-content:center}button:disabled,select:disabled{opacity:.45;cursor:default}.primary{background:var(--accent);color:var(--text-on-solid)}.vm-actions{display:flex;gap:8px}.vm-actions button{flex:1;font-size:12px}.hint{font-size:12px;color:var(--text-muted)}.problem{color:var(--danger)}.settings-link{border:0;background:transparent;align-self:flex-start;padding-left:0;font-size:12px}.control-state{padding:10px;border-radius:8px;background:var(--surface-soft)}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:900px){.local-vm-chat-panel{position:fixed;inset:0 0 0 auto;width:min(400px,100vw);max-width:100%;z-index:35;box-shadow:-20px 0 60px #0002}}
.computer-select{display:grid;gap:7px;font-size:13px;min-width:0}
.computer-tabs{display:flex;gap:4px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft);overflow-x:auto}
.computer-tabs button{flex:1 0 auto;min-height:40px;padding:8px 12px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary);font-size:12px;white-space:nowrap}
.computer-tabs button[aria-selected="true"]{background:var(--surface);color:var(--text-primary);font-weight:600;box-shadow:0 1px 3px #00000014}
.computer-tabs button:hover:not(:disabled):not([aria-selected="true"]){background:var(--surface-hover)}
.computer-tabs button:focus-visible{outline-offset:-2px}
.computer-options{display:flex;flex-direction:column;gap:14px}
.computer-options:empty{display:none}
</style>

<style scoped>.cloud-settings{display:grid;gap:10px;padding:14px;border:1px solid var(--line);border-radius:10px}.cloud-settings input{min-height:44px;font:inherit;color:var(--text-primary);background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}.computer-tabs{display:grid;grid-template-columns:1fr 1fr;overflow:visible}.computer-tabs button{text-align:left;justify-content:flex-start;white-space:normal;min-height:48px}</style>

<style scoped>.computer-tabs{gap:8px;border:0;padding:0;background:transparent}.computer-tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:12px;border:1px solid var(--line);background:var(--surface-soft);min-height:82px}.computer-tabs button span{display:flex;align-items:center;gap:6px;font-weight:500}.computer-tabs button small{font-size:11px;line-height:1.5;color:var(--text-muted)}.computer-tabs button[aria-selected=true]{border-color:var(--accent);background:var(--surface-raised);box-shadow:none}.computer-tabs button:disabled{opacity:.55}</style>

<style scoped>.permission-list{display:grid;gap:8px;font-size:13px;color:var(--text-secondary)}</style>
