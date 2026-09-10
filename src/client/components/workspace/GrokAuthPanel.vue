<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue'
import {apiRequest} from '@/api/client'
import {createUuid} from '@/utils/id'
import AppIcon from '@/components/common/AppIcon.vue'
import type {GrokAuthSnapshot} from '@shared/grokAuth'
const props=defineProps<{isAdmin:boolean}>(),emit=defineEmits<{changed:[]}>()
const state=ref<GrokAuthSnapshot>(),error=ref(''),loadError=ref(''),busy=ref(false),loading=ref(true),advanced=ref(false)
const pending=computed(()=>state.value?.attempt?.status==='pending')
const title=computed(()=>pending.value?'等待浏览器授权':state.value?.status==='reauthorization-required'?'需要重新授权':state.value?.status==='refreshing'?'正在续期':state.value?.status==='connected'?'已授权':'尚未登录')
const loginUrl=computed(()=>{
 try{const raw=state.value?.attempt?.loginUrl;if(!raw)return '';const url=new URL(raw);return url.protocol==='https:'&&url.hostname==='cursor.com'&&!url.port&&!url.username&&!url.password&&url.pathname==='/loginDeepControl'&&url.searchParams.get('redirectTarget')==='cli'?url.href:''}catch{return ''}
})
let closed=false,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined,startId:string|undefined,lastStatus=''
function apply(value:GrokAuthSnapshot){state.value=value;if(value.attempt?.status!=='pending')startId=undefined;const identity=JSON.stringify([value.status,value.account,value.attempt?.status]);if(lastStatus&&lastStatus!==identity)emit('changed');lastStatus=identity}
async function load(){
 if(closed||document.hidden||busy.value)return
 controller?.abort();const current=new AbortController();controller=current
 try{const next=await apiRequest<GrokAuthSnapshot>('/api/app/grok-cloud/auth',{signal:current.signal});if(!closed&&!current.signal.aborted){apply(next);loadError.value=''}}catch(e){if(!closed&&!current.signal.aborted)loadError.value=e instanceof Error?e.message:'无法读取 Grok Bot 授权状态'}finally{if(!closed)loading.value=false}
}
async function action(work:()=>Promise<GrokAuthSnapshot>){if(busy.value)return;controller?.abort();busy.value=true;error.value='';try{const next=await work();if(!closed)apply(next)}catch(e){if(!closed)error.value=e instanceof Error?e.message:'Grok Bot 授权操作未完成'}finally{busy.value=false;loading.value=false}}
async function begin(){
 startId??=createUuid()
 await action(()=>apiRequest('/api/app/grok-cloud/auth/start',{method:'POST',body:{requestId:startId!}}))
 if(pending.value&&loginUrl.value)window.open(loginUrl.value,'_blank','noopener,noreferrer')
 if(!pending.value)startId=undefined
 if(error.value)await load()
}
async function cancel(){const id=state.value?.attempt?.id;if(!id)return;await action(()=>apiRequest(`/api/app/grok-cloud/auth/${id}/cancel`,{method:'POST',body:{}}));startId=undefined}
async function check(){const id=state.value?.attempt?.id;if(id)await action(()=>apiRequest(`/api/app/grok-cloud/auth/${id}/poll`,{method:'POST',body:{}}))}
async function disconnect(){await action(()=>apiRequest('/api/app/grok-cloud/auth',{method:'DELETE'}));startId=undefined}
async function importLocal(){await action(()=>apiRequest('/api/app/grok-cloud/connect',{method:'POST',body:{importLocal:true,version:state.value?.version??'0.47.0'}}))}
async function cycle(){await load();if(!closed)timer=setTimeout(cycle,pending.value?2000:10000)}
const visibility=()=>{if(!document.hidden)void load()}
onMounted(()=>{document.addEventListener('visibilitychange',visibility);void cycle()})
onBeforeUnmount(()=>{closed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility)})
</script>
<template>
 <section class="grok-auth" aria-label="Grok Bot 登录授权">
  <header><span class="account-icon"><AppIcon name="globe" :size="20"/></span><div><strong>Grok Bot</strong><small aria-live="polite">{{loading?'正在检查授权…':title}}</small></div><span v-if="state?.status==='connected'&&!pending" class="connected"><AppIcon name="check" :size="14"/>已连接</span></header>
  <p v-if="state?.account?.email||state?.account?.name" class="account">{{state.account.name}}<span v-if="state.account.email">{{state.account.email}}</span></p>
  <p v-if="!state?.configured&&!pending" class="hint">使用 Grok Bot 所属的 Cursor 账号，在浏览器完成登录授权。</p>
  <div v-if="pending" class="pending" role="status"><span class="pulse"/><div><strong>请在浏览器中完成授权</strong><p>完成后返回夭夭，这里会自动更新。授权链接有效期约 10 分钟。</p></div></div>
  <p v-if="error||loadError||state?.attempt?.error||state?.error" class="error" role="alert">{{error||loadError||state?.attempt?.error||state?.error}}</p>
  <template v-if="pending">
   <a v-if="loginUrl" class="primary" :href="loginUrl" target="_blank" rel="noopener noreferrer"><AppIcon name="external" :size="14"/>在浏览器继续授权</a>
   <div class="actions"><button :disabled="busy" @click="check">我已完成授权</button><button :disabled="busy" @click="cancel">取消授权</button></div>
  </template>
  <template v-else>
   <button v-if="isAdmin" class="primary" :disabled="busy||loading" @click="begin"><AppIcon name="external" :size="15"/>{{state?.status==='connected'?'重新授权':'使用 Cursor 账号登录'}}</button>
   <p v-else-if="!state?.configured" class="hint">请由管理员为当前账号完成云端授权。</p>
   <p v-if="state?.configured" class="hint">{{state.automaticRefresh?'登录会自动续期，无需重复登录。':'此连接尚未取得自动续期授权，建议重新登录。'}}<span v-if="state.expiresAt&&state.status!=='reauthorization-required'">当前凭据有效期至 {{new Date(state.expiresAt).toLocaleString('zh-CN')}}。</span></p>
   <button v-if="state?.configured" class="disconnect" :disabled="busy" @click="disconnect">断开连接</button>
  </template>
  <p class="privacy">登录凭据加密保存在当前服务器，供当前账号的机器人使用。</p>
  <details v-if="isAdmin&&!pending" :open="advanced" @toggle="advanced=($event.target as HTMLDetailsElement).open"><summary>兼容旧连接</summary><p class="hint">仅用于迁移服务器上已有的 Grok Bot 登录；推荐使用上方浏览器授权。</p><button :disabled="busy" @click="importLocal">导入服务器上的已有登录</button></details>
 </section>
</template>
<style scoped>
.grok-auth{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface-raised);color:var(--text-primary)}header{display:flex;align-items:center;gap:10px}.account-icon{width:38px;height:38px;display:grid;place-items:center;background:var(--surface-soft);border-radius:10px}header>div{display:grid;gap:4px;flex:1}strong{font-size:13px}small{font-size:11.5px;color:var(--text-secondary)}.connected{font-size:10.5px;display:flex;align-items:center;gap:4px;color:var(--accent)}.account{display:grid;gap:4px;margin:0;font-size:13px;overflow-wrap:anywhere}.account span{font-size:12px;color:var(--text-secondary)}button,a.primary{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;color:var(--text-primary);background:var(--surface);cursor:pointer;text-decoration:none;box-sizing:border-box}.primary{background:var(--accent)!important;color:var(--text-on-solid)!important;border-color:var(--accent)!important;font-weight:500!important}.hint,.privacy{font-size:12px;line-height:1.7;color:var(--text-secondary);margin:0}.hint span{display:block;margin-top:4px}.privacy{font-size:11px;color:var(--text-muted);border-top:1px solid var(--line);padding-top:12px}.pending{display:flex;align-items:flex-start;gap:8px;padding:12px;border-radius:8px;background:var(--surface-soft)}.pending strong{font-size:12px}.pending p{font-size:11.5px;line-height:1.7;color:var(--text-secondary);margin:5px 0 0}.pulse{flex:none;width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--accent)}.error{color:var(--danger);font-size:12px;line-height:1.7;margin:0}.actions{display:flex;gap:8px}.actions button{flex:1}.disconnect{color:var(--text-secondary);background:transparent;border:0}button:disabled{opacity:.5;cursor:default}summary{cursor:pointer;font-size:11.5px;color:var(--text-muted);min-height:32px;align-content:center}details .hint{margin:5px 0 10px}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
