<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref} from 'vue'
import {getHermesBridgeStatus,installHermesBridge} from '@/api/hermesBridge'
import type {HermesBridgeProfileStatus,HermesBridgeState,HermesBridgeStatus} from '@shared/hermesBridge'
import type {Profile} from '@shared/types'

const props=withDefaults(defineProps<{profiles?:Profile[]}>(),{profiles:()=>[]})
const status=ref<HermesBridgeStatus>(),checking=ref(false),installing=ref(''),error=ref(''),notice=ref(''),backup=ref('')
const lastInstalled=ref('')
const labels:Record<HermesBridgeState,string>={ready:'已就绪',missing:'未安装',outdated:'需要更新','restart-required':'待重启',disabled:'未启用',unavailable:'无法确认'}
let generation=0,disposed=false,timer:ReturnType<typeof setTimeout>|undefined
function profileLabel(name:string){const profile=props.profiles.find(p=>p.name===name);return profile?.agentName||profile?.displayName||name}
function actionLabel(profile:HermesBridgeProfileStatus){return profile.state==='missing'||profile.state==='disabled'?'安装并启用':profile.state==='outdated'?'更新工具桥':'重新安装'}
async function load(){
  if(installing.value)return
  clearTimeout(timer)
  const current=++generation;checking.value=true;error.value=''
  try{
    const result=await getHermesBridgeStatus()
    if(disposed||current!==generation)return
    status.value=result
    if(lastInstalled.value&&result.profiles.find(p=>p.profile===lastInstalled.value)?.state==='ready')notice.value='检查完成，工具桥已就绪。'
    if(result.installing)timer=setTimeout(()=>void load(),1500)
  }catch(cause){if(!disposed&&current===generation)error.value=cause instanceof Error?cause.message:'无法检查工具桥状态'}
  finally{if(!disposed&&current===generation)checking.value=false}
}
async function install(profile:HermesBridgeProfileStatus){
  if(installing.value||checking.value||!profile.canInstall)return
  ++generation;installing.value=profile.profile;error.value='';notice.value='';backup.value=''
  try{
    const result=await installHermesBridge(profile.profile,profile.state==='disabled'||profile.state==='missing')
    if(disposed)return
    status.value=result.status;notice.value=result.message;backup.value=result.backup;lastInstalled.value=result.profile
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'工具桥安装失败'}
  finally{if(!disposed)installing.value=''}
}
onMounted(()=>void load())
onBeforeUnmount(()=>{disposed=true;++generation;clearTimeout(timer)})
</script>

<template>
  <section class="hermes-bridge" aria-label="工具桥插件" :aria-busy="checking || !!installing || !!status?.installing">
    <header>
      <div><h4>工具桥插件</h4><p>连接 Bot 的电脑、技能和应用工具。默认及其他 Profile 需分别安装。</p></div>
      <button type="button" :disabled="checking || !!installing" @click="load">{{ checking ? '检查中…' : '重新检查' }}</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!status && checking" class="loading" role="status">正在检查安装文件和 Hermes 加载状态…</p>
    <template v-if="status">
      <p v-if="status.message" class="hint">{{ status.message }}</p>
      <div class="profiles">
        <article v-for="profile in status.profiles" :key="profile.profile" class="profile">
          <div class="profile-detail">
            <div class="profile-heading"><strong>{{ profileLabel(profile.profile) }}</strong><span class="badge" :class="profile.state">{{ labels[profile.state] }}</span></div>
            <small v-if="profileLabel(profile.profile)!==profile.profile">{{ profile.profile }}</small>
            <p>{{ profile.message }}</p>
            <small>随附版本 {{ status.bundledVersion }}<template v-if="profile.installedVersion"> · 已安装 {{ profile.installedVersion }}</template><template v-if="profile.loadedVersion"> · 已加载 {{ profile.loadedVersion }}</template></small>
          </div>
          <button v-if="status.local" type="button" class="install" :disabled="checking || !!installing || !profile.canInstall" :aria-label="`${actionLabel(profile)}：${profileLabel(profile.profile)}`" @click="install(profile)">
            {{ installing===profile.profile || status.installing===profile.profile ? '安装中…' : actionLabel(profile) }}
          </button>
        </article>
      </div>
    </template>
    <div v-if="notice" class="result" role="status"><p>{{ notice }}</p><details v-if="backup"><summary>查看备份位置</summary><code>{{ backup }}</code></details></div>
    <p class="footnote">安装前会备份原插件与配置。安装完成后，请在空闲时重启 Hermes Dashboard 服务，再点击重新检查。</p>
  </section>
</template>

<style scoped>
.hermes-bridge{display:grid;gap:14px;margin-top:22px;padding-top:22px;border-top:1px solid var(--line);color:var(--text-primary);font-size:13px;line-height:1.65}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}h4{margin:0 0 5px;font-size:15px}p{margin:0;color:var(--text-secondary)}button{flex-shrink:0;min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}button:hover:not(:disabled){background:var(--surface-soft)}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.55;cursor:default}.profiles{display:grid;border:1px solid var(--line);border-radius:12px;overflow:hidden}.profile{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;background:var(--surface-soft)}.profile+.profile{border-top:1px solid var(--line)}.profile-detail{min-width:0;display:grid;gap:5px;overflow-wrap:anywhere}.profile-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.profile-heading strong{font-size:14px}.badge{border:1px solid var(--line);border-radius:6px;padding:1px 7px;font-size:12px;color:var(--text-secondary);background:var(--surface)}.badge.ready{color:var(--success,var(--accent))}.badge.outdated,.badge.restart-required{color:var(--accent)}small,.footnote{font-size:12px;color:var(--text-secondary)}.error{color:var(--danger)}.result{padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft)}.result details{margin-top:8px}.result summary{cursor:pointer}.result code{display:block;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.install{color:var(--accent)}
@media(max-width:600px){header{flex-wrap:wrap}.profile{align-items:stretch;flex-direction:column;gap:12px}.install{align-self:flex-start}header button{margin-left:auto}}
</style>
