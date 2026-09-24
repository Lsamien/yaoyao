<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { DesktopHostSummary } from '@shared/desktopHost'

const emit = defineEmits<{ 'dirty-change': [value: boolean] }>()
const approvalPolicy = ref<'ask'|'allow'|'deny'>('ask')
const scriptMachine = ref(true)
const serverComputer = ref(true)
const vm = ref(true)
const cloud = ref(true)
const managedBrowser = ref(false)
const fileTransferMaxMiB = ref<number | string>(25)
const transferError = computed(() => Number.isInteger(fileTransferMaxMiB.value) && Number(fileTransferMaxMiB.value) >= 1 && Number(fileTransferMaxMiB.value) <= 100 ? '' : '请输入 1–100 之间的整数。')
const loading = ref(false), saving = ref(false), error = ref(''), saved = ref(false)
type ComputerRow = { id: string; label: string; name: string; online?: boolean; createdAt?: number }
const hosts = ref<ComputerRow[]>([])
const drafts = ref<Record<string, string>>({})
const nameError = ref(''), nameStatus = ref(''), namesLoading = ref(false), nameBusy = ref('')
const pendingRemoval = ref('')
const namesDisabled = computed(() => namesLoading.value || !!nameBusy.value)
const hasSameNames = computed(() => {
  const labels = hosts.value.filter(host => host.id !== 'local').map(host => host.label)
  return new Set(labels).size !== labels.length
})
function pairedAt(value: number) {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
async function loadNames() {
  if (namesLoading.value) return
  namesLoading.value = true
  nameError.value = ''
  try {
    const value = await apiRequest<{localName?: string; hosts: DesktopHostSummary[]}>('/api/app/admin/desktop-hosts')
    const rows: ComputerRow[] = [{ id: 'local', label: '服务器 · 夭夭所在的电脑', name: value.localName || '' }]
    for (const host of value.hosts) {
      if (!host.enabled) continue
      rows.push({ id: host.id, label: host.hostName || host.name, name: host.displayName || '', online: host.online, createdAt: host.createdAt })
    }
    const edited = new Set(hosts.value.filter(host => drafts.value[host.id] !== host.name).map(host => host.id))
    drafts.value = Object.fromEntries(rows.map(row => [row.id, edited.has(row.id) ? drafts.value[row.id] : row.name]))
    hosts.value = rows
  } catch (cause) { nameError.value = cause instanceof Error ? cause.message : '无法读取电脑名单' }
  finally { namesLoading.value = false }
}
async function saveName(id: string) {
  if (namesDisabled.value) return
  nameBusy.value = id; nameError.value = ''; nameStatus.value = ''
  const name = drafts.value[id] || ''
  try {
    await apiRequest(`/api/app/admin/desktop-hosts/${encodeURIComponent(id)}/name`, { method: 'PUT', body: { name } })
    const host = hosts.value.find(row => row.id === id)
    if (host) host.name = name
    nameStatus.value = '名字已保存'
    await loadNames()
  } catch (cause) { nameError.value = cause instanceof Error ? cause.message : '改名失败' }
  finally { nameBusy.value = '' }
}
async function removeHost(id: string) {
  if (namesDisabled.value || id === 'local' || pendingRemoval.value !== id) return
  nameBusy.value = id; nameError.value = ''; nameStatus.value = ''
  try {
    await apiRequest(`/api/app/admin/desktop-hosts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    hosts.value = hosts.value.filter(host => host.id !== id)
    delete drafts.value[id]
    pendingRemoval.value = ''
    nameStatus.value = '这条配对记录已停用'
  } catch (cause) { nameError.value = cause instanceof Error ? cause.message : '停用失败，请重试' }
  finally { nameBusy.value = '' }
}

type Settings = { approvalPolicy?: 'ask'|'allow'|'deny'; scriptMachine: boolean; serverComputer: boolean; vm: boolean; cloud: boolean; managedBrowser?: boolean; fileTransferMaxMiB?: number }
function apply(value: Settings) {
  approvalPolicy.value = value.approvalPolicy ?? 'ask'
  scriptMachine.value = value.scriptMachine
  serverComputer.value = value.serverComputer
  vm.value = value.vm
  cloud.value = value.cloud
  managedBrowser.value = value.managedBrowser === true
  fileTransferMaxMiB.value = value.fileTransferMaxMiB ?? 25
}
function payload(): Settings {
  return { approvalPolicy: approvalPolicy.value, scriptMachine: scriptMachine.value, serverComputer: serverComputer.value, vm: vm.value, cloud: cloud.value, managedBrowser: managedBrowser.value, fileTransferMaxMiB: Number(fileTransferMaxMiB.value) }
}
async function load() {
  loading.value = true; error.value = ''
  try {
    apply(await apiRequest<Settings>('/api/app/settings/host-tools'))
    emit('dirty-change', false)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取电脑设置' }
  finally { loading.value = false }
}
function changed() { saved.value = false; emit('dirty-change', true) }
async function save() {
  if (transferError.value) return
  saving.value = true; error.value = ''; saved.value = false
  try {
    apply(await apiRequest<Settings>('/api/app/settings/host-tools', { method: 'PUT', body: payload() }))
    saved.value = true; emit('dirty-change', false)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { saving.value = false }
}
onMounted(() => { void load(); void loadNames() })
</script>

<template>
  <section class="host-tools" aria-label="电脑与服务端工具">
    <p>这些开关对所有机器人生效，不再按单个机器人勾选。所有 Bot 共用电脑权限和审批策略。设备是否在线、是否获得系统授权会单独显示。</p>
    <form @submit.prevent="save" @change="changed">
      <label class="toggle"><input v-model="scriptMachine" type="checkbox" :disabled="loading || saving" /><span><strong>电脑</strong><small>连接服务器的 Mac 或 Windows 电脑。机器人按名称点名：文件走文件工具，命令走 shell，只有看窗口或点按时才截图。</small></span></label>
      <label class="toggle"><input v-model="serverComputer" type="checkbox" :disabled="loading || saving" /><span><strong>服务器</strong><small>夭夭正在运行的这台电脑。文件走文件工具，命令走 shell；只有看窗口或点按时才截图操作。</small></span></label>
      <label class="toggle"><input v-model="vm" type="checkbox" :disabled="loading || saving" /><span><strong>虚拟环境</strong><small>服务端上的隔离桌面。聊天留在夭夭，操作派到虚拟机里。</small></span></label>
      <label class="toggle"><input v-model="cloud" type="checkbox" :disabled="loading || saving" /><span><strong>云虚拟机</strong><small>共享的 Grok Bot 电脑。先看真实桌面，再点击、输入、按键或滚动。</small></span></label>
      <label class="toggle"><input v-model="managedBrowser" type="checkbox" :disabled="loading || saving" /><span><strong>托管浏览器</strong><small>通过已启用浏览器能力的执行节点处理网页，无需启动虚拟机。默认关闭，打开后可在电脑面板查看和接管。</small></span></label>
      <label>所有 Bot 的审批策略<select v-model="approvalPolicy" :disabled="loading || saving"><option value="ask">询问我</option><option value="allow">自动允许</option><option value="deny">自动拒绝</option></select><small>统一用于新的工具审批请求；已等待的请求仍由你答复。Hermes 原生终端和文件始终操作服务器。</small></label>
      <label for="file-transfer-limit">单文件传输上限（MiB）<input id="file-transfer-limit" v-model.number="fileTransferMaxMiB" type="number" min="1" max="100" step="1" :disabled="loading || saving" :aria-invalid="!!transferError" aria-describedby="file-transfer-help file-transfer-error" @input="changed" /><small id="file-transfer-help">1–100 MiB，默认 25 MiB。电脑、服务器和当前 Bot 虚拟机之间的复制共用此上限，从下一次传输生效。</small><small v-if="transferError" id="file-transfer-error" class="error" role="alert">{{ transferError }}</small></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">已保存。所有 Bot 的新操作将使用统一设置。</p>
      <div class="actions"><button type="button" :disabled="loading || saving" @click="load">重新读取</button><button type="submit" class="save" :disabled="loading || saving || !!transferError">{{ saving ? '保存中…' : loading ? '读取中…' : '保存设置' }}</button></div>
    </form>
    <div class="names">
      <div class="names-heading"><strong>电脑名称与配对记录</strong><button type="button" :disabled="namesDisabled" @click="loadNames">{{ namesLoading ? '刷新中…' : '刷新电脑列表' }}</button></div>
      <p>每台电脑可以改名，和机器人点名用的是同一套名字。服务器留空时显示「服务器」，电脑留空时用配对时的主机名。「本机」跟用户当前发消息所在的电脑走，不是固定某一台。</p>
      <p v-if="hasSameNames" class="same-names">有同名的配对记录。请结合连接状态、编号和配对时间区分，确认不再使用后可停用旧记录。</p>
      <p v-if="nameError" class="error" role="alert">{{ nameError }}</p>
      <p v-if="nameStatus" role="status">{{ nameStatus }}</p>
      <div v-for="host in hosts" :key="host.id" class="computer" :data-host-id="host.id">
        <div class="computer-heading"><label :for="`computer-name-${host.id}`">{{ host.label }}</label><span class="connection">{{ host.id === 'local' ? '当前服务器' : host.online ? '已连接' : '未连接' }}</span></div>
        <div v-if="host.id !== 'local'" class="computer-details">
          <small :title="host.id">编号 {{ host.id.slice(0, 8) }}</small>
          <small v-if="host.createdAt">配对于 {{ pairedAt(host.createdAt) }}</small>
        </div>
        <div class="name-editor"><input :id="`computer-name-${host.id}`" v-model="drafts[host.id]" :disabled="namesDisabled" maxlength="64" :placeholder="host.id === 'local' ? '服务器' : host.label" :aria-label="`名字 ${host.label}${host.id === 'local' ? '' : `，编号 ${host.id.slice(0, 8)}`}`" /><button type="button" :disabled="namesDisabled" @click="saveName(host.id)">保存名字</button><button v-if="host.id !== 'local'" type="button" class="remove-host" :disabled="namesDisabled" @click="pendingRemoval = host.id">停用</button></div>
        <div v-if="pendingRemoval === host.id" class="remove-confirmation" role="group" :aria-label="`停用编号 ${host.id.slice(0, 8)} 的配对记录`">
          <p>停用后，机器人将无法连接这条配对记录。需要在这台电脑重新登录或配对才能恢复。</p>
          <div class="actions"><button type="button" :disabled="namesDisabled" @click="pendingRemoval = ''">取消</button><button type="button" class="remove-host" :disabled="namesDisabled" @click="removeHost(host.id)">{{ nameBusy === host.id ? '停用中…' : '确认停用' }}</button></div>
        </div>
      </div>
      <p v-if="!hosts.length && !nameError && !namesLoading">还没有可改名的电脑。</p>
    </div>
  </section>
</template>

<style scoped>
input[type=number]{display:block;box-sizing:border-box;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:inherit;font:inherit}
.host-tools{display:grid;gap:18px;max-width:680px;color:var(--text-primary);font-size:13px;line-height:1.7}.host-tools p{margin:0}.host-tools small{display:block;color:var(--text-secondary);font-size:12px}.host-tools form{display:grid;gap:14px}.toggle{display:flex;gap:12px;align-items:flex-start;cursor:pointer}.toggle input{width:20px;height:20px;margin-top:2px;accent-color:var(--accent)}.actions{display:flex;gap:10px;justify-content:flex-end}.actions button{min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}.actions .save{background:var(--accent);color:var(--text-on-solid)}button:disabled{opacity:.55;cursor:default}.names{display:grid;gap:10px}.names input{min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit}.names button{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}.error{color:var(--danger)}select:focus-visible,input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
select{display:block;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:inherit;font:inherit}
.names-heading,.computer-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.names .computer-heading label{min-width:0;overflow-wrap:anywhere;font-weight:600}.connection{flex-shrink:0;font-size:12px;color:var(--text-secondary)}.computer{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:10px}.computer-details{display:flex;flex-wrap:wrap;gap:4px 16px}.name-editor{display:flex;flex-wrap:wrap;gap:8px}.name-editor input{min-width:0;flex:1 1 150px}.same-names,.remove-confirmation{padding:10px 12px;border-radius:8px;background:var(--surface-soft)}.remove-confirmation{display:grid;gap:8px}.names .remove-host{color:var(--danger)}.names button:hover:not(:disabled){background:var(--surface-soft)}.names button:active:not(:disabled){background:var(--settings-selected)}
</style>
