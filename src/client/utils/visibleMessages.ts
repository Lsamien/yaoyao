import { onMounted,onBeforeUnmount,type Ref } from 'vue'
export function useVisibleMessages(root:Ref<HTMLElement|null>,emit:(ids:string[])=>void){
 let timer:ReturnType<typeof setInterval>|undefined,previous=new Set<string>()
 const scan=()=>{
  const el=root.value
  if(!el||document.hidden||!document.hasFocus()){previous.clear();return}
  const box=el.getBoundingClientRect(),current=new Set<string>()
  for(const row of el.querySelectorAll<HTMLElement>('[data-message-id]')){
   const r=row.getBoundingClientRect(),top=Math.max(r.top,box.top,0),bottom=Math.min(r.bottom,box.bottom,innerHeight),left=Math.max(r.left,box.left,0),right=Math.min(r.right,box.right,innerWidth)
   if(bottom-top<Math.min(24,r.height)||right<=left)continue
   const front=document.elementFromPoint((left+right)/2,(top+bottom)/2)
   if(front&&row.contains(front)&&row.dataset.messageId)current.add(row.dataset.messageId)
  }
  const settled=[...current].filter(id=>previous.has(id));previous=current
  if(settled.length)emit(settled)
 }
 onMounted(()=>{timer=setInterval(scan,350)})
 onBeforeUnmount(()=>{clearInterval(timer);previous.clear()})
}
