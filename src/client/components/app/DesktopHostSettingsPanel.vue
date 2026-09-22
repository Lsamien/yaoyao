<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { DesktopHostConfiguration, DesktopHostSummary } from '@shared/desktopHost'

const hosts = ref<DesktopHostSummary[]>([])
const busy = ref(false), error = ref(''), notice = ref('')
const name = ref('')
const serverURL = ref(window.location.origin)
const insecure = ref(false)
const configuration = ref<DesktopHostConfiguration>()

async function refresh() {
  const data = await apiRequest<{hosts:DesktopHostSummary[]}>('/api/app/admin/desktop-hosts')
  hosts.value = data.hosts
}
async function action(work:()=>Promise<void>) {
  if(busy.value) return
  error.value = ''; notice.value = ''; busy.value = true
  try { await work() } catch(cause) { error.value = cause instanceof Error ? cause.message : '电脑操作失败' }
  finally { busy.value = false }
}
async function register() {
  await action(async()=>{
    const web = new URL(serverURL.value)
    if(!['http:','https:'].includes(web.protocol)||web.username||web.password||web.search||web.hash||web.pathname!=='/')throw new Error('请填写不带路径的夭夭服务地址')
    if(web.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(web.hostname)&&!insecure.value)throw new Error('远程电脑请使用 HTTPS，或勾选可信局域网 HTTP')
    const result = await apiRequest<{host:DesktopHostSummary;token:string}>('/api/app/admin/desktop-hosts', {method:'POST',body:{name:name.value.trim()}})
    configuration.value = {protocol:1,serverURL:web.origin,hostId:result.host.id,token:result.token,...(insecure.value?{allowInsecureLan:true}:{})}
    notice.value = '电脑已注册，请下载配置并在那台电脑 的夭夭 App 中导入。'
    await refresh()
  })
}
function download() {
  if(!configuration.value) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(configuration.value,null,2)+'\n'],{type:'application/json'}))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'desktop-host.json'; anchor.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function disable(host:DesktopHostSummary) {
  void action(async()=>{
    await apiRequest(`/api/app/admin/desktop-hosts/${host.id}`,{method:'DELETE',body:{}})
    if(configuration.value?.hostId===host.id)configuration.value=undefined
    await refresh(); notice.value = `已停用 ${host.name}`
  })
}
onMounted(()=>{void action(refresh)})
</script>

<template>
  <section class="desktop-host-panel" aria-label="电脑设置">
    <p>在其他电脑 上安装夭夭 App 并导入电脑配置后，那台电脑会主动连接服务器，机器人即可操作它的真实桌面。每台电脑单独授权，配置凭据仅注册时下发一次。</p>
    <div class="host-toolbar"><strong>已注册电脑</strong><button type="button" :disabled="busy" @click="action(refresh)">刷新状态</button></div>
    <ul v-if="hosts.length" class="host-list">
      <li v-for="host in hosts" :key="host.id">
        <div><strong>{{ host.name }}</strong><span>{{ !host.enabled ? '已停用' : host.online ? `已连接 · ${host.hostName || host.platform || '电脑'}` : '待连接' }}</span></div>
        <button v-if="host.enabled" type="button" :disabled="busy" :aria-label="`停用 ${host.name}`" @click="disable(host)">停用</button>
      </li>
    </ul>
    <p v-else>尚未注册电脑。</p>
    <form v-if="!configuration" @submit.prevent="register">
      <label>电脑名称<input v-model="name" required maxlength="100" autocomplete="off" placeholder="书房 iMac" :disabled="busy"></label>
      <small>用于在电脑面板中区分各台机器。</small>
      <label>夭夭服务地址<input v-model="serverURL" type="url" required :disabled="busy"></label>
      <small>必须能从那台电脑 访问。</small>
      <label class="host-check"><input v-model="insecure" type="checkbox" :disabled="busy">使用可信局域网 HTTP</label>
      <button class="solid-button" :disabled="busy || !name.trim()">注册电脑</button>
    </form>
    <div v-else class="host-setup">
      <button class="solid-button" type="button" @click="download">下载电脑配置</button>
      <p>配置包含这台电脑的连接凭据，仅本次可下载。在那台电脑 上打开夭夭 App，通过菜单「电脑 → 导入电脑配置…」选择下载的 desktop-host.json。</p>
      <small>配置丢失后可停用电脑并重新注册；停用立即断开那台电脑。</small>
    </div>
    <p v-if="error" class="host-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="host-notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.desktop-host-panel { display: grid; gap: 14px; min-width: 0; font-size: 13px; }
.desktop-host-panel p { margin: 0; line-height: 1.6; color: var(--text-secondary); }
.host-toolbar,.host-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.desktop-host-panel button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-primary); cursor: pointer; }
.desktop-host-panel button:disabled { opacity: .5; cursor: default; }
.host-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.host-list li { padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
.host-list li div { display: grid; gap: 5px; overflow-wrap: anywhere; }
.host-list span,.desktop-host-panel small { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.desktop-host-panel form,.desktop-host-panel label,.host-setup { display: grid; gap: 8px; min-width: 0; }
.desktop-host-panel form { gap: 14px; }
.desktop-host-panel input:not([type=checkbox]) { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-primary); font: inherit; }
.desktop-host-panel .host-check { display: flex; align-items: center; }
.desktop-host-panel .host-error { color: var(--danger); }
.desktop-host-panel :is(input,select,button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
