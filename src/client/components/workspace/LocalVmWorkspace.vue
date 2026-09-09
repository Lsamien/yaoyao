<script setup lang="ts">
import {ref,computed} from 'vue'
import type {WorkspaceAgent} from '@shared/workspace'
import ComputerPanel from './ComputerPanel.vue'
const props=defineProps<{agents:WorkspaceAgent[];primary:string}>(),emit=defineEmits<{close:[]}>()
const slots=ref([props.primary,props.agents.find(a=>a.id!==props.primary)?.id??''])
const panels:Array<InstanceType<typeof ComputerPanel>|null>=[]
const busy=ref(false),error=ref(''),controlled=ref<number>()
const choices=computed(()=>props.agents.filter(a=>!a.computerEnvironmentId))
async function release(){for(const panel of panels)if(panel?.hasControl())await panel.releaseControl();controlled.value=undefined}
async function take(index:number){
 if(busy.value)return;busy.value=true;error.value=''
 try{await release();await panels[index]?.take();if(panels[index]?.hasControl())controlled.value=index}catch(e){error.value=e instanceof Error?e.message:'切换控制失败'}finally{busy.value=false}
}
async function select(index:number,value:string){if(busy.value)return;busy.value=true;error.value='';try{await release();slots.value[index]=value}catch(e){error.value=String(e)}finally{busy.value=false}}
async function close(){if(busy.value)return false;busy.value=true;try{await release();emit('close');return true}catch(e){error.value=String(e);return false}finally{busy.value=false}}
defineExpose({close})
</script>
<template>
 <main class="local-vm-workspace" aria-label="双桌面工作区">
  <header><div><strong>本地虚拟机 · 双桌面</strong><p>同时查看两个 Agent 的桌面，每次只控制其中一台。</p></div><button :disabled="busy" @click="close">交还并关闭</button></header>
  <p v-if="error" role="alert">{{error}}</p>
  <div class="panes"><section v-for="(_,index) in slots" :key="index" class="pane" :class="{controlled:controlled===index}">
   <label>桌面 {{index+1}}<select :value="slots[index]" :disabled="busy" :aria-label="`选择桌面 ${index+1}`" @change="select(index,($event.target as HTMLSelectElement).value)"><option value="">选择 Agent</option><option v-for="agent in choices" :key="agent.id" :value="agent.id" :disabled="slots[1-index]===agent.id">{{agent.name}}</option></select></label>
   <ComputerPanel v-if="slots[index]&&choices.some(a=>a.id===slots[index])" :key="slots[index]" :ref="el=>panels[index]=el as InstanceType<typeof ComputerPanel>|null" embedded :agents="choices.filter(a=>a.id===slots[index])" @control-request="take(index)"/>
   <p v-else class="empty">选择另一位 Agent。打开工作区不会创建或启动虚拟机。</p>
  </section></div>
 </main>
</template>
<style scoped>
.local-vm-workspace{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;max-height:none;margin:0;padding:0;border:0;background:var(--surface);color:var(--text-primary)}.local-vm-workspace::backdrop{background:#0009}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}p{font-size:12px;color:var(--text-secondary);line-height:1.6;margin:6px 0 0}.panes{display:grid;grid-template-columns:1fr 1fr;flex:1;min-height:0;gap:12px;padding:12px;background:var(--surface-soft)}.pane{display:flex;min-width:0;min-height:0;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}.pane>label{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;font-size:13px;border-bottom:1px solid var(--line)}.controlled{outline:2px solid var(--accent);outline-offset:-2px}button,select{min-height:40px;padding:7px 12px;font:inherit;border:1px solid var(--line);border-radius:8px;color:inherit;background:var(--surface-raised)}button:disabled,select:disabled{opacity:.5}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.empty{padding:30px}.panes:has(+[role=alert]){height:auto}[role=alert]{color:var(--danger);padding:0 20px}@media(max-width:800px){.panes{grid-template-columns:1fr;height:auto}.local-vm-workspace{overflow:auto}.pane{min-height:70vh}}
</style>
