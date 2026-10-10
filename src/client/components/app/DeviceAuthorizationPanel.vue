<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { DesktopHostStatus } from '@shared/desktopEnvironment'

const nativeAuthorization = !!window.yaoyaoDesktop?.authorizeCurrentDevice
const hosts = ref<DesktopHostStatus[]>([])
const currentHost = ref<string | null>(null)
const loading = ref(false), busy = ref(false), error = ref(''), readError = ref(''), notice = ref('')
let closed = false, timer: ReturnType<typeof setTimeout> | undefined
const canAuthorize = (host: DesktopHostStatus) => host.id === currentHost.value && host.online && !!window.yaoyaoDesktop?.authorizeCurrentDevice
async function refresh() {
  if (closed || loading.value) return
  loading.value = true
  try {
    const [state, current] = await Promise.all([
      apiRequest<{ hosts: DesktopHostStatus[] }>('/api/app/desktop-environment'),
      window.yaoyaoDesktop?.deviceHost?.(),
    ])
    if (closed) return
    currentHost.value = current?.deviceHost ?? null
    hosts.value = state.hosts.sort((a, b) => Number(b.id === currentHost.value) - Number(a.id === currentHost.value))
    readError.value = ''
  } catch (cause) { if (!closed) readError.value = cause instanceof Error ? cause.message : '无法读取设备状态' }
  finally { if (!closed) loading.value = false }
}
async function authorize(scope: 'screen' | 'full') {
  if (busy.value || !hosts.value.some(canAuthorize)) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await window.yaoyaoDesktop!.authorizeCurrentDevice!(scope)
    if (!closed) { notice.value = '本机授权已保存，设备状态将在连接同步后更新。'; await refresh() }
  } catch (cause) { if (!closed) error.value = cause instanceof Error ? cause.message : '本机授权未完成' }
  finally { if (!closed) busy.value = false }
}
async function cycle() {
  if (!busy.value && !document.hidden) await refresh()
  if (!closed) timer = setTimeout(cycle, 3000)
}
onMounted(() => { void cycle() })
onBeforeUnmount(() => { closed = true; clearTimeout(timer) })
</script>

<template>
  <section class="device-authorization" aria-label="设备授权">
    <header><h4>设备授权</h4><button type="button" :disabled="loading || busy" @click="refresh">{{ loading ? '刷新中…' : '刷新状态' }}</button></header>
    <p>只能授权当前客户端所在的设备。其他设备的连接和权限状态可在这里查看；如需授权，请在那台设备上打开 Bot 设置。</p>
    <p v-if="!currentHost" class="hint">请在电脑客户端中授权本机；浏览器和手机端仅可查看设备状态。</p>
    <p v-else-if="!nativeAuthorization" class="hint">请更新当前电脑客户端后授权本机。</p>
    <article v-for="host in hosts" :key="host.id" :data-host-id="host.id">
      <div class="device-heading"><strong>{{ host.name || '未命名电脑' }}<span v-if="host.id === currentHost"> · 当前设备</span></strong><span>{{ host.online ? '在线' : '离线' }}</span></div>
      <small>{{ host.id === 'local' ? '服务器' : `编号 ${host.id.slice(0, 8)}` }}</small>
      <dl v-if="host.online">
        <div><dt>屏幕控制</dt><dd>{{ host.local.authorized ? '已授权' : '未授权' }}</dd></div>
        <div><dt>{{ host.platform === 'win32' ? '屏幕可用' : '屏幕录制' }}</dt><dd>{{ host.local.screen ? '已开启' : '未开启' }}</dd></div>
        <div><dt>{{ host.platform === 'win32' ? '键鼠可用' : '辅助功能' }}</dt><dd>{{ host.local.accessibility ? '已开启' : '未开启' }}</dd></div>
        <div><dt>文件与命令</dt><dd>{{ host.local.fullAuthorized ? '已授权' : '未授权' }}</dd></div>
      </dl>
      <p v-else class="hint">设备离线，连接后更新授权状态。</p>
      <div v-if="canAuthorize(host)" class="actions">
        <button v-if="!host.local.ready" type="button" :disabled="busy" @click="authorize('screen')">{{ host.local.authorized ? '检查本机系统权限' : '授权本机屏幕控制' }}</button>
        <button v-if="!host.local.fullAuthorized" type="button" :disabled="busy" @click="authorize('full')">授权本机文件与命令</button>
      </div>
      <p v-else-if="host.id !== currentHost" class="hint">仅查看，请在该设备上授权。</p>
    </article>
    <p v-if="!hosts.length && !loading && !readError">尚无已连接或配对的设备。</p>
    <p v-if="error || readError" class="error" role="alert">{{ error || readError }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.device-authorization{display:grid;gap:14px;max-width:680px;margin-bottom:28px;font-size:13px;line-height:1.6;color:var(--text-primary)}header,.device-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}h4,p,dl,dd{margin:0}h4{font-size:16px}p,small,dt,.device-heading>span{color:var(--text-secondary)}article{display:grid;gap:10px;padding:16px;border:1px solid var(--line);border-radius:10px}.device-heading strong{min-width:0;overflow-wrap:anywhere}.device-heading>span{flex-shrink:0}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}dl>div{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between}.actions{display:flex;flex-wrap:wrap;gap:8px}button{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}button:hover:not(:disabled){background:var(--surface-hover)}button:active:not(:disabled){background:var(--settings-selected)}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.hint{font-size:12px}.error{color:var(--danger)}@media(max-width:480px){dl{grid-template-columns:1fr}.actions button{flex:1 1 100%}}
</style>
