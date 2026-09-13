<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount,nextTick} from 'vue'
import {apiRequest} from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import type {WorkspaceInspectorEntry} from '@shared/workspacePanels'
const props=defineProps<{conversationId:string;taskId?:string;showClose?:boolean}>()
const emit=defineEmits<{close:[]}>()
const entries=ref<WorkspaceInspectorEntry[]>([]),error=ref(''),loading=ref(false),lens=ref<'events'|'raw'>('events'),list=ref<HTMLElement>()
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,generation=0
const follow=ref(true)
const visible=computed(()=>entries.value.filter(e=>lens.value==='events'?e.direction==='event':e.direction!=='event'))
const rows=computed(()=>{
 const result:Array<{id:string;at:number;tag:string;summary:string;tone:string;count:number;data:WorkspaceInspectorEntry[];duration?:number}>=[]
 for(const entry of [...visible.value].sort((a,b)=>a.at-b.at)){
  const data=entry.data as Record<string,unknown>|null,text=String(data?.text??data?.delta??data?.content??data?.error??data?.message??'').replace(/\s+/g,' ').slice(0,120)
  const tag=lens.value==='raw'?(entry.direction==='request'?'→ out':entry.direction==='error'?'! error':'← in'):entry.method
  const tone=entry.direction==='error'||/error|failed/.test(entry.method)?'error':/start|complete|finish/.test(entry.method)?'boundary':'plain'
  const last=result.at(-1)
  if(lens.value==='events'&&/delta$/.test(entry.method)&&last?.tag===tag&&last.data[0]?.runId===entry.runId&&last.data[0]?.agentId===entry.agentId){last.count++;last.at=entry.at;last.data.push(entry);last.summary=(last.summary+text).slice(0,120);continue}
  result.push({id:entry.id,at:entry.at,tag,summary:lens.value==='raw'?entry.method+(entry.requestId?' #'+entry.requestId.slice(0,8):''):(text||entry.method),tone,count:1,data:[entry],duration:entry.durationMs})
 }
 return result.reverse()
})
const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN',{hour12:false})+'.'+String(at%1000).padStart(3,'0')
async function load(){const current=generation;loading.value=true
 try{const value=await apiRequest<{entries:WorkspaceInspectorEntry[]}>(`/api/app/conversations/${props.conversationId}/inspector${props.taskId?'?taskId='+encodeURIComponent(props.taskId):''}`);if(current===generation&&!closed){entries.value=value.entries;error.value=''}}catch(e){if(current===generation&&!closed)error.value=e instanceof Error?e.message:'无法读取请求记录'}finally{if(current===generation)loading.value=false}}
async function cycle(){const version=generation;if(!document.hidden)await load();if(!closed&&version===generation)timer=setTimeout(cycle,3000)}
watch(()=>[props.conversationId,props.taskId],()=>{generation++;entries.value=[];follow.value=true;clearTimeout(timer);void cycle()},{immediate:true})
watch(lens,async()=>{follow.value=true;await nextTick();if(list.value)list.value.scrollTop=0})
watch(rows,async()=>{const following=follow.value;await nextTick();if(following&&list.value)list.value.scrollTop=0})
onBeforeUnmount(()=>{closed=true;generation++;clearTimeout(timer)})
</script>
<template>
 <section class="inspector" aria-label="Inspector 请求查看器">
  <header><AppIcon name="bug" :size="16"/><strong>Inspector</strong><button v-if="showClose" class="close" aria-label="关闭 Inspector" title="关闭 Inspector" @click="emit('close')"><AppIcon name="close" :size="16"/></button></header>
  <div class="inspector-toolbar"><div class="lenses" role="group" aria-label="Inspector 视图"><button :aria-pressed="lens==='events'" @click="lens='events'">Events</button><button :aria-pressed="lens==='raw'" @click="lens='raw'">Raw</button></div><span>{{loading&&!entries.length?'读取中…':visible.length+' 条记录'}}</span><button class="reload" aria-label="刷新请求记录" title="重新读取记录" :disabled="loading" @click="load"><AppIcon name="refresh" :size="14"/></button></div>
  <div ref="list" class="inspector-list" @scroll="follow=!!list&&list.scrollTop<40">
   <p v-if="error" role="alert" class="error">{{error}}</p>
   <p v-else-if="!rows.length&&!loading" class="empty">{{lens==='raw'?'此聊天尚未记录网关请求与响应。':'此聊天尚未产生运行事件。'}}</p>
   <details v-for="row in rows" :key="row.id" :class="['inspector-row',row.tone]">
    <summary><AppIcon class="chevron" name="chevron-left" :size="12"/><time>{{time(row.at)}}</time><span :class="['tag',{native:lens==='raw'}]">{{row.tag}}<template v-if="row.count>1"> ×{{row.count}}</template></span><span class="summary">{{row.summary}}</span><small v-if="row.duration!==undefined">{{row.duration}}ms</small></summary>
    <pre>{{JSON.stringify(row.count===1?row.data[0]:row.data,null,2)}}</pre>
   </details>
  </div>
 </section>
</template>
<style scoped>
.inspector{min-height:0;display:flex;flex:1;flex-direction:column;color:var(--text-primary);background:var(--surface)}header{display:flex;min-height:64px;align-items:center;gap:8px;padding:10px 12px 10px 16px;box-sizing:border-box;border-bottom:1px solid var(--line);font-size:15px}header>strong{flex:1}header .app-icon{color:var(--text-muted)}.inspector-toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px 12px 16px;border-bottom:1px solid var(--line)}.lenses{display:flex;padding:3px;border-radius:8px;background:var(--surface-soft)}button{font:inherit;border:0;border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;min-height:32px;padding:5px 10px;font-size:12px}.close{display:grid;min-width:44px;min-height:44px;place-items:center;padding:0;border-radius:8px}.close:hover{background:var(--surface-hover);color:var(--text-primary)}.lenses button[aria-pressed=true]{background:var(--surface-raised);color:var(--text-primary);box-shadow:0 1px 2px #0000000c;font-weight:600}.inspector-toolbar>span{font-size:11px;color:var(--text-muted);margin-left:auto}.reload{display:grid;place-items:center;min-width:32px;padding:6px}.inspector-list{min-height:0;overflow:auto;flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}.empty,.error{padding:10px 16px;line-height:1.7;color:var(--text-muted)}.inspector-row{border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}.inspector-row.boundary{background:var(--surface-soft)}.inspector-row.error{padding:0;background:color-mix(in srgb,var(--danger) 8%,transparent)}summary{display:flex;align-items:center;gap:7px;padding:6px 12px;min-height:32px;box-sizing:border-box;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary:hover{background:var(--surface-hover)}.chevron{flex:none;transform:rotate(180deg);color:var(--text-muted)}details[open] .chevron{transform:rotate(-90deg)}time{flex:none;font-variant-numeric:tabular-nums;color:var(--text-muted);font-size:10.5px}.tag{flex:none;max-width:128px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;padding:2px 4px;font-size:10px;color:var(--text-secondary);background:var(--surface-soft)}.native{color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}.summary{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.error .tag,.error .summary{color:var(--danger)}small{font-size:10px;color:var(--text-muted)}pre{margin:0;max-height:50vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-raised);border-top:1px solid var(--line);padding:10px 12px;font-size:11px;line-height:1.6}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@media(max-width:600px){button,summary{min-height:44px}.reload{min-width:44px}summary{gap:5px;padding-left:8px;padding-right:8px}time{font-size:9.5px}.tag{max-width:108px}}
</style>
