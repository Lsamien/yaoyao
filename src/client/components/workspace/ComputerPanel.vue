<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {apiRequest} from '@/api/client'
import BrowserToolbar from './BrowserToolbar.vue'
import type {BotBrowserState} from '@shared/desktopEnvironment'
import {createUuid} from '@/utils/id'
import type {WorkspaceAgent} from '@shared/workspace'
import type {ComputerControlStatus,ComputerFrame,ComputerInput} from '@shared/computerControl'
import type {JsonValue} from '@shared/types'
const props=defineProps<{agents:WorkspaceAgent[];embedded?:boolean;standalone?:boolean;autoTake?:boolean}>(),emit=defineEmits<{close:[];changed:[];controlRequest:[]}>()
const selected=ref(props.agents[0]?.id??''),dialog=ref<HTMLDialogElement>()
const state=ref<ComputerControlStatus>({mode:'off'}),frame=ref<ComputerFrame>(),ticket=ref<{controlId:string;token:string}>()
const controlsOpen=ref(false),actualSize=ref(false),browserState=ref<BotBrowserState>()
const selectedAgent=computed(()=>props.agents.find(agent=>agent.id===selected.value))
const error=ref(''),busy=ref(false),text=ref(''),notes=ref(''),connectionOK=ref(false)
let takeRequestId:string|undefined
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,polling=false,lastRenew=0,generation=0
const labels:Record<ComputerControlStatus['mode'],string>={off:'电脑未运行',idle:'电脑空闲 · 仅查看',agent:'机器人正在操作',pausing:'正在等待当前操作结束',human:'人工控制中',resuming:'正在交还机器人',error:'电脑需要检查'}
const mine=computed(()=>!!ticket.value&&ticket.value.controlId===state.value.controlId)
const canSend=computed(()=>connectionOK.value&&!!frame.value&&mine.value&&state.value.mode==='human'&&frame.value?.generation===state.value.generation)
const controllable=computed(()=>canSend.value&&!busy.value)
const endpoint=()=>`/api/app/agents/${encodeURIComponent(selected.value)}/computer`
async function post(path:string,body:unknown){return apiRequest<any>(endpoint()+path,{method:'POST',body:body as JsonValue})}
async function refresh(){
  if(polling||busy.value||closed||!selected.value||document.hidden)return
  polling=true;const current=++generation,base=endpoint()
  try{
    const status=await apiRequest<ComputerControlStatus>(base)
    if(current!==generation||closed)return
    state.value=status
    connectionOK.value=true
    if(ticket.value&&status.controlId!==ticket.value.controlId&&status.mode!=='pausing')ticket.value=undefined
    if(mine.value&&Date.now()-lastRenew>8000){await post('/renew',ticket.value);lastRenew=Date.now()}
    if(status.backend==='browser'){browserState.value=await apiRequest<BotBrowserState>(`/api/app/agents/${encodeURIComponent(selected.value)}/browser`)}else browserState.value=undefined
    if(status.mode!=='off'&&(status.backend!=='browser'||browserState.value?.open)){
      const image=await apiRequest<ComputerFrame>(base+'/frame')
      if(current===generation&&!closed)frame.value=image
    }else frame.value=undefined
    error.value=''
  }catch(cause){if(current===generation&&!closed){connectionOK.value=false;frame.value=undefined;inputs.length=0;error.value=cause instanceof Error?cause.message:'无法读取电脑状态';if([401,403,410].includes(Number((cause as {status?:number}).status))){ticket.value=undefined;frame.value=undefined;state.value={mode:'off'}}}}
  finally{polling=false}
}
async function run(action:()=>Promise<void>){
  if(busy.value)return;generation++;busy.value=true;error.value=''
  try{await action()}catch(cause){error.value=cause instanceof Error?cause.message:'电脑操作失败'}finally{busy.value=false;await refresh();void flushInputs()}
}
function take(){return run(async()=>{takeRequestId??=createUuid();const value=await post('/take',{requestId:takeRequestId});ticket.value={controlId:value.controlId,token:value.token};state.value=value;lastRenew=0})}
const inputs:ComputerInput[]=[];let flushing=false,pendingClick:ComputerInput|undefined,clickTimer:ReturnType<typeof setTimeout>|undefined
function send(action:ComputerInput){
  if(!canSend.value||closed)return
  if(pendingClick){inputs.push(pendingClick);pendingClick=undefined;clearTimeout(clickTimer)}
  const last=inputs.at(-1)
  if(action.kind==='text'&&last?.kind==='text'&&last.text.length+action.text.length<=16000)last.text+=action.text
  else if(inputs.length<64)inputs.push(action)
  else {error.value='输入过快，请稍后再试';return}
  void flushInputs()
}
async function flushInputs(){
  if(flushing||busy.value||!inputs.length||closed)return
  if(!canSend.value||!frame.value||!ticket.value){inputs.length=0;return}
  flushing=true
  const action=inputs.shift()!,image=frame.value,credentials=ticket.value
  try{await run(async()=>{await post('/input',{...credentials,requestId:createUuid(),generation:image.generation,frameId:image.id,action})});if(error.value)inputs.length=0}
  finally{flushing=false;if(inputs.length)setTimeout(()=>void flushInputs(),0)}
}
function browserAction(action:Record<string,string>){if(!canSend.value||!frame.value||!ticket.value)return;const f=frame.value;void run(async()=>{await post('/browser',{...ticket.value,requestId:createUuid(),generation:f.generation,frameId:f.id,action})})}
function point(event:MouseEvent|PointerEvent){
  const r=(event.currentTarget as HTMLImageElement).getBoundingClientRect(),f=frame.value!
  const scale=Math.min(r.width/f.width,r.height/f.height),left=r.left+(r.width-f.width*scale)/2,top=r.top+(r.height-f.height*scale)/2
  const x=Math.floor((event.clientX-left)/scale),y=Math.floor((event.clientY-top)/scale)
  if(x<0||y<0||x>=f.width||y>=f.height)return
  return {x,y}
}
let dragStart:{x:number;y:number;clientX:number;clientY:number}|undefined,dragged=false
function down(event:PointerEvent){if(!canSend.value||event.button!==0)return;(event.currentTarget as HTMLElement).focus({preventScroll:true});const p=point(event);if(!p)return;dragStart={...p,clientX:event.clientX,clientY:event.clientY};(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)}
function up(event:PointerEvent){if(!dragStart)return;const start=dragStart;dragStart=undefined;if(!canSend.value)return;if(Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY)>5){const end=point(event);if(!end)return;dragged=true;send({kind:'drag',fromX:start.x,fromY:start.y,toX:end.x,toY:end.y})}}
function wheel(event:WheelEvent){if(!canSend.value)return;event.preventDefault();send({kind:'scroll',direction:Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX>0?'right':'left':event.deltaY>0?'down':'up',amount:Math.min(20,Math.max(1,Math.ceil(Math.abs(event.deltaY||event.deltaX)/80)))})}
function keydown(event:KeyboardEvent){if(!canSend.value)return;event.preventDefault();event.stopPropagation();if(event.key==='Escape'){(event.currentTarget as HTMLElement).blur();return}const modifiers=[event.ctrlKey?'ctrl':'',event.altKey?'alt':'',event.shiftKey?'shift':'',event.metaKey?'super':''].filter(Boolean);if(event.key.length===1&&!event.ctrlKey&&!event.altKey&&!event.metaKey)send({kind:'text',text:event.key});else if(!['Control','Alt','Shift','Meta'].includes(event.key))send({kind:'key',key:({Enter:'Return',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Backspace:'BackSpace'} as Record<string,string>)[event.key]??event.key,modifiers})}
function click(event:MouseEvent){
  if(dragged){dragged=false;return}
  if(!canSend.value||!frame.value)return
  const p=point(event);if(!p)return
  const action:ComputerInput={kind:'click',...p,button:event.button===2?'right':'left',count:event.detail>1?2:1}
  if(event.button===2||event.detail>1){clearTimeout(clickTimer);pendingClick=undefined;send(action)}
  else {if(pendingClick){const old=pendingClick;pendingClick=undefined;clearTimeout(clickTimer);send(old)}pendingClick=action;clickTimer=setTimeout(()=>{const next=pendingClick;pendingClick=undefined;if(next)send(next)},180)}
}
async function giveBack(){if(ticket.value){await post('/giveback',{...ticket.value,notes:notes.value});ticket.value=undefined;takeRequestId=undefined;notes.value=''}}
async function close(){if(busy.value)return;await run(giveBack);if(!ticket.value){closed=true;if(!props.embedded&&!props.standalone)dialog.value?.close();emit('close')}}
async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await dialog.value?.requestFullscreen()}catch{error.value='无法进入全屏，请使用窗口最大化'}}
async function cycle(){await refresh();if(!closed)timer=setTimeout(()=>void cycle(),1200)}
watch(selected,()=>{inputs.length=0;connectionOK.value=false;generation++;takeRequestId=undefined;frame.value=undefined;ticket.value=undefined;state.value={mode:'off'};error.value='';void refresh()})
onMounted(()=>{if(!props.embedded&&!props.standalone)dialog.value?.showModal();void cycle();if(props.autoTake)void take()})
onBeforeUnmount(()=>{inputs.length=0;pendingClick=undefined;clearTimeout(clickTimer);closed=true;generation++;clearTimeout(timer)})
defineExpose({take,close,releaseControl:async()=>{await run(giveBack);if(ticket.value)throw new Error(error.value||'请先交还控制权')},hasControl:()=>!!ticket.value})
</script>
<template>
  <Teleport to="body" :disabled="embedded||standalone">
    <component :is="embedded||standalone?'section':'dialog'" ref="dialog" class="computer-panel" :class="{embedded,standalone}" :aria-label="state.backend==='local'?'本机':state.backend==='browser'?'浏览器':'隔离电脑'" @cancel.prevent="close">
      <header>
        <div><strong>{{state.backend==='grok'?'Grok Bot 云端电脑':state.backend==='local'?'本机 · '+state.hostName:state.backend==='browser'?'浏览器 · '+state.hostName:'隔离电脑'}}</strong><small>{{ labels[state.mode] }}</small></div>
        <select v-if="agents.length>1" v-model="selected" aria-label="选择电脑" :disabled="!!ticket"><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select>
        <span v-else-if="!embedded">{{ agents[0]?.name }}</span>
        <button v-if="embedded&&!ticket" :disabled="busy||state.mode==='human'" @click="emit('controlRequest')">接管电脑</button>
        <button v-if="embedded&&mine" @click="controlsOpen=!controlsOpen">键盘与操作</button>
        <button v-if="embedded&&mine" :disabled="busy||state.mode!=='human'" @click="run(giveBack)">交还</button>
        <template v-if="!embedded">
          <button v-if="mine" type="button" :aria-expanded="controlsOpen" @click="controlsOpen=!controlsOpen">键盘与操作</button>
          <button type="button" :aria-pressed="actualSize" @click="actualSize=!actualSize">{{actualSize?'适应窗口':'原始大小'}}</button>
          <button type="button" @click="fullscreen">全屏</button>
        </template>
        <button v-if="!embedded" class="return-control" type="button" :disabled="busy" @click="close">{{ ticket ? '交还并关闭' : '关闭' }}</button>
      </header>
      <BrowserToolbar v-if="state.backend==='browser'" :state="browserState" :enabled="controllable" @action="browserAction"/>
      <div class="computer-screen" :class="{controlling:canSend,'actual-size':actualSize}">
        <img v-if="frame" :src="`data:image/png;base64,${frame.data}`" :alt="state.backend==='local'?'本机当前画面':state.backend==='browser'?'浏览器当前画面':'隔离电脑当前画面'" draggable="false" tabindex="0" title="点按后可使用键盘、滚轮和拖动；按 Esc 退出键盘控制" @pointerdown="down" @pointerup="up" @pointercancel="dragStart=undefined" @wheel="wheel" @keydown="keydown" @click="click" @contextmenu.prevent="click">
        <p v-else>{{ state.mode==='off' ? '打开电脑后可查看桌面。' : '正在读取电脑画面…' }}</p>
        <span v-if="frame&&(!mine||frame.generation!==state.generation)" class="view-label">{{mine?'正在同步画面':state.mode==='off'?'上次画面':'仅查看'}}</span>
      </div>
      <p v-if="error||state.error" class="computer-error" role="alert">{{ error||state.error }}</p>
      <footer v-if="controlsOpen||(!embedded&&!ticket)">
        <p v-if="state.backend==='grok'">多个机器人共享同一台 Grok Bot 云端电脑、工作文件与浏览器资料。</p>
        <p v-if="selectedAgent?.computerEnvironmentId">共享电脑：{{ selectedAgent.computerEnvironmentName }}。成员共用工作文件和浏览器资料，同一时间只有一名操作者。</p>
        <p v-if="!ticket">查看不会输入任何内容。接管后机器人会暂停，已有操作结束后才允许人工操作。</p>
        <button v-if="!ticket&&state.mode!=='human'" type="button" :disabled="busy" @click="embedded?emit('controlRequest'):take()">{{ state.mode==='off'?'打开并控制':'接管电脑' }}</button>
        <template v-if="mine">

          <section v-if="controlsOpen" class="manual-input">
          <div class="key-row"><button v-for="key in ['Return','Tab','Escape','BackSpace','Up','Down','Left','Right']" :key="key" type="button" :disabled="!controllable" @click="send({kind:'key',key})">{{ ({Return:'回车',Escape:'Esc',BackSpace:'退格',Up:'↑',Down:'↓',Left:'←',Right:'→'} as Record<string,string>)[key]||key }}</button></div>
          <div class="key-row"><button :disabled="!controllable" @click="send({kind:'key',key:'a',modifiers:[state.backend==='local'||state.backend==='browser'?'super':'ctrl']})">全选</button><button :disabled="!controllable" @click="send({kind:'key',key:'c',modifiers:[state.backend==='local'||state.backend==='browser'?'super':'ctrl']})">复制</button><button :disabled="!controllable" @click="send({kind:'key',key:'v',modifiers:[state.backend==='local'||state.backend==='browser'?'super':'ctrl']})">粘贴</button></div>
          <label>输入到电脑<textarea v-model="text" rows="2" maxlength="16000" placeholder="输入文字后点击发送" :disabled="!controllable" /></label>
          <button type="button" :disabled="!controllable||!text" @click="send({kind:'text',text});text=''">输入文字</button>
          </section>
          <label>交还说明<textarea v-model="notes" rows="2" maxlength="4000" placeholder="告诉机器人你完成了什么，以及接下来需要做什么" /></label>
          <button type="button" :disabled="busy||state.mode!=='human'" @click="run(giveBack)">{{ state.canResume ? '交还机器人并继续' : '结束控制' }}</button>
          <small>控制只属于当前页面。页面断开后控制权会到期，任务不会自行恢复。</small>
        </template>
      </footer>
    </component>
  </Teleport>
</template>
<style scoped>
.computer-panel.embedded{position:static;width:100%;max-height:none;height:100%;margin:0;border:0;border-radius:0;overflow:auto}.computer-panel.embedded{display:flex;flex-direction:column}.embedded .computer-screen{flex:1;min-height:150px}.embedded .computer-screen img{max-height:calc(100dvh - 250px);object-fit:contain}.embedded footer{max-height:45vh;overflow:auto}.manual-input{display:grid;gap:10px}
.computer-panel{width:min(1120px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--text-primary);overflow:auto}
.computer-panel.standalone{display:flex;flex-direction:column;width:100vw;height:100dvh;max-height:none;margin:0;border:0;border-radius:0;overflow:hidden}
.standalone .computer-screen{flex:1;min-height:0;overflow:hidden}.standalone .computer-screen img{height:100%;width:100%;max-height:100%;max-width:100%;object-fit:contain}.standalone header{flex-shrink:0;background:#1c1f23;color:#f4f4f5}.standalone header small{color:#bec4cc}.standalone header button,.standalone header select{background:#2b2f34;color:#f4f4f5;border-color:#474c54}.standalone header .return-control{background:#f4f4f5;color:#202327;border-color:#f4f4f5}.standalone footer{position:absolute;right:16px;top:78px;width:min(360px,calc(100vw - 64px));max-height:calc(100dvh - 130px);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 50px #0006;z-index:2}
.computer-panel:fullscreen{display:flex;flex-direction:column;width:100vw;height:100dvh;max-height:none;border:0;border-radius:0}.computer-panel:fullscreen .computer-screen{flex:1;min-height:0}.computer-panel:fullscreen .computer-screen img{max-height:100%}
.computer-screen.actual-size{overflow:auto;align-items:flex-start;justify-content:flex-start}.computer-screen.actual-size img{width:auto;height:auto;max-width:none;max-height:none;flex:none}.return-control{font-weight:600}.standalone .computer-error{flex:none;margin:0;padding:10px 18px}
.computer-panel::backdrop{background:rgba(0,0,0,.45)}header{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line)}header div{display:grid;gap:4px;margin-right:auto}small{font-size:12px;color:var(--text-muted);line-height:1.5}
button,select,textarea,input{font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--surface-raised);color:var(--text-primary)}button,select{min-height:44px;padding:8px 12px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.computer-screen{position:relative;display:flex;align-items:center;justify-content:center;min-height:220px;background:#14181e}.computer-screen img{max-width:100%;max-height:58vh;width:auto;height:auto;user-select:none}.controlling img{cursor:crosshair}.computer-screen img:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.computer-screen p{color:#d8dee7}.view-label{position:absolute;top:10px;left:12px;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.65);color:white;font-size:12px;pointer-events:none}
footer{padding:16px 18px;display:grid;gap:12px}footer p{margin:0;font-size:13px;color:var(--text-secondary);line-height:1.6}label{display:grid;gap:6px;font-size:13px}textarea{padding:10px;min-width:0;resize:vertical}.key-row{display:flex;gap:6px;flex-wrap:wrap}.computer-error{color:var(--danger);padding:0 18px;font-size:13px}
.sharing-settings{display:grid;gap:12px;padding:12px;border:1px solid var(--line);border-radius:10px}.sharing-settings input:not([type=checkbox]){min-height:44px;padding:8px 10px}.share-option{display:flex;align-items:center;gap:8px;min-height:44px}.share-option input{width:18px;height:18px;flex:none}fieldset{border:1px solid var(--line);border-radius:8px}
@media(max-width:600px){.computer-panel{width:100vw;max-height:100dvh;border-radius:0}header{flex-wrap:wrap;padding:12px}footer{padding:12px}.computer-screen img{max-height:48vh}}
</style>
