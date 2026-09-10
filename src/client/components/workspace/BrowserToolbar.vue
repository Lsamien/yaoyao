<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {BotBrowserState} from '@shared/desktopEnvironment'
const props=defineProps<{state?:BotBrowserState;enabled:boolean}>(),emit=defineEmits<{action:[action:Record<string,string>]}>()
const address=ref(''),editing=ref(false),active=computed(()=>props.state?.tabs.find(t=>t.active))
watch(()=>active.value?.url,url=>{if(!editing.value)address.value=url==='about:blank'?'':url??''},{immediate:true})
function navigate(){let url=address.value.trim();if(!url)return;if(!/^https?:\/\//i.test(url))url='https://'+url;editing.value=false;emit('action',{kind:'navigate',url})}
</script>
<template>
 <div class="browser-toolbar" aria-label="机器人浏览器">
  <div class="browser-tabs" role="tablist" aria-label="浏览器标签页">
   <div v-for="tab in state?.tabs" :key="tab.id" class="tab" :class="{active:tab.active}">
    <button role="tab" :aria-selected="tab.active" :title="tab.title" :disabled="!enabled" @click="emit('action',{kind:'select-tab',tabId:tab.id})">{{tab.title}}</button>
    <button class="close-tab" :aria-label="`关闭标签页 ${tab.title}`" :disabled="!enabled" @click="emit('action',{kind:'close-tab',tabId:tab.id})">×</button>
   </div>
   <button class="new-tab" aria-label="新建标签页" :disabled="!enabled" @click="emit('action',{kind:'new-tab',url:'https://www.google.com/'})">＋</button>
  </div>
  <form class="navigation" @submit.prevent="navigate">
   <button type="button" aria-label="后退" :disabled="!enabled" @click="emit('action',{kind:'back'})">←</button>
   <button type="button" aria-label="前进" :disabled="!enabled" @click="emit('action',{kind:'forward'})">→</button>
   <button type="button" aria-label="重新加载页面" :disabled="!enabled" @click="emit('action',{kind:'reload'})">↻</button>
   <input v-model="address" type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="浏览器地址" placeholder="输入网址" :disabled="!enabled" @focus="editing=true" @blur="editing=false">
   <button type="submit" :disabled="!enabled||!address.trim()">前往</button>
  </form>
 </div>
</template>
<style scoped>
.browser-toolbar{min-width:0;background:var(--surface-soft);border-bottom:1px solid var(--line)}.browser-tabs{display:flex;overflow-x:auto;gap:4px;padding:7px 10px 0}.tab{display:flex;align-items:center;min-width:90px;max-width:210px;border:1px solid transparent;border-radius:8px 8px 0 0}.tab.active{background:var(--surface);border-color:var(--line);border-bottom-color:var(--surface)}.tab button:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}.browser-toolbar button{font:inherit;font-size:12px;min-width:36px;min-height:40px;background:transparent;border:0;color:var(--text-primary);cursor:pointer}.tab .close-tab{min-width:32px}.browser-toolbar button:disabled{opacity:.45;cursor:default}.navigation{display:flex;align-items:center;gap:3px;padding:5px 10px}.navigation input{flex:1;min-width:0;min-height:40px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--surface);color:var(--text-primary);font:inherit;font-size:13px}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@media(max-width:600px){.navigation{padding:4px}.browser-toolbar button{min-width:40px;min-height:44px}.tab button:first-child{max-width:130px}}
</style>
