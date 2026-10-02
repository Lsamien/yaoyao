import { ref, computed, reactive } from 'vue'
import { apiRequest } from '@/api/client'
import { emptyUnread, type UnreadConversation, type UnreadSnapshot } from '@shared/unread'
const createUnreadStore=()=>{
 const snapshot=ref<UnreadSnapshot>(emptyUnread()),error=ref(''),scope=ref('')
 let epoch=0,revision=0,timer:ReturnType<typeof setInterval>|undefined,inflight:Promise<void>|undefined
 function reset(account='') { epoch++;revision++;scope.value=account;snapshot.value=emptyUnread();error.value='';inflight=undefined;clearInterval(timer);timer=undefined }
 function accept(value:UnreadSnapshot){
  snapshot.value=value;error.value=''
  void window.yaoyaoDesktop?.unreadState?.(scope.value).catch(()=>{})
 }
 async function refresh(){
  if(!scope.value)return
  if(inflight)return inflight
  const generation=epoch,request=revision
  const pending=apiRequest<UnreadSnapshot>('/api/app/unread').then(value=>{
   if(generation!==epoch||request!==revision)return
   accept(value)
  }).catch(e=>{if(generation===epoch&&request===revision)error.value=e instanceof Error?e.message:'未读同步失败'})
  inflight=pending;try{await pending}finally{if(inflight===pending)inflight=undefined}
 }
 function start(account:string){reset(account);void window.yaoyaoDesktop?.unreadState?.(account).catch(()=>{});void refresh();timer=setInterval(()=>void refresh(),3000)}
 async function read(items:UnreadConversation[]){
  const generation=epoch,account=scope.value,request=++revision;inflight=undefined
  const value=await apiRequest<UnreadSnapshot>('/api/app/unread/read',{method:'POST',body:JSON.parse(JSON.stringify({items:items.map(({mode,id,profile,messages})=>({mode,id,profile,messages}))}))})
  if(generation!==epoch||account!==scope.value)return
  if(request===revision){accept(value);return}
  // Concurrent reads can finish out of order; fetch the latest authority.
  revision++;inflight=undefined;await refresh()
 }
 async function visible(mode:'bot'|'chat',id:string,profile:string|undefined,ids:string[]){
  if(!ids.length||!scope.value)return
  const row=snapshot.value.conversations.find(c=>c.mode===mode&&c.id===id&&(mode==='bot'||c.profile===profile))
  if(!row)return
  const selected=new Set(ids),messages=row.messages.filter(m=>selected.has(m.id))
  if(messages.length)await read([{...row,messages}])
 }
 const total=computed(()=>snapshot.value.total)
 return reactive({snapshot,total,error,reset,start,refresh,read,visible})
}
let store:ReturnType<typeof createUnreadStore>|undefined
export const useUnreadStore=()=>store??=createUnreadStore()
