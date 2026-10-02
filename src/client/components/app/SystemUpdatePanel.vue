<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  applySystemUpdate,
  activateSystemUpdate,
  checkSystemUpdate,
  rollbackSystemUpdate,
  systemUpdateJob,
  systemUpdateStatus,
  type SystemUpdateStatus,
  type UpdateJob,
} from '@/api/systemUpdate'

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const emit = defineEmits<{ 'lock-change': [locked: boolean] }>()

const status = ref<SystemUpdateStatus>()
const job = ref<UpdateJob>()
const busy = ref(false)
const checking = ref(false)
const remoteChecked = ref(false)
const error = ref('')
const trackingTimedOut = ref(false)
const operationStarting = ref(false)
let pollToken = 0
let lifecycleToken = 0

const terminalStates = ['prepared', 'succeeded', 'failed', 'rolled_back']
const terminal = computed(() => job.value && terminalStates.includes(job.value.state))
const prepared = computed(() => job.value?.state === 'prepared')
const npmUpdate = computed(() => status.value?.updateMethod === 'npm')
const jobRunning = computed(() => Boolean(job.value && !terminal.value))
const locked = computed(() => operationStarting.value || (jobRunning.value && !trackingTimedOut.value))
const canApply = computed(() => Boolean(status.value?.supported && status.value.updateAvailable && status.value.latest && !prepared.value && !jobRunning.value && !busy.value))
const progress = computed(() => job.value?.state === 'downloading' && (job.value.total ?? 0) > 0
  ? Math.max(0, Math.min(100, Math.floor((job.value.received ?? 0) / job.value.total! * 100))) : undefined)
const displayedJob = computed(() => {
  const current = status.value?.current, value = job.value
  if (value?.state === 'succeeded' && value.target && current && (value.target.webVersion !== current.webVersion || value.target.releaseVersion !== current.releaseVersion)) return undefined
  return value
})

function stopPolling() { pollToken += 1 }
function reloadPage() { window.location.reload() }

async function refresh(checkRemote = false): Promise<SystemUpdateStatus | undefined> {
  error.value = ''
  checking.value = checkRemote
  try {
    status.value = checkRemote ? await checkSystemUpdate() : await systemUpdateStatus()
    if (checkRemote) remoteChecked.value = true
    job.value = status.value.job
    return status.value
  } catch (cause) {
    if (checkRemote) remoteChecked.value = false
    error.value = cause instanceof Error ? cause.message : '无法读取系统版本'
  } finally {
    checking.value = false
  }
  return undefined
}

async function poll(next: UpdateJob) {
  job.value = next
  trackingTimedOut.value = false
  const token = ++pollToken
  for (let attempt = 0; attempt < 300 && token === pollToken; attempt += 1) {
    if (terminalStates.includes(job.value.state)) break
    await new Promise(resolvePromise => window.setTimeout(resolvePromise, 1_000))
    try {
      job.value = await systemUpdateJob(next.id)
    } catch {
      // 15300 会在原子切换期间短暂不可用；继续等待新服务读取同一任务文件。
    }
  }
  if (token === pollToken && job.value && !terminalStates.includes(job.value.state)) {
    error.value = '升级仍在后台执行，请稍后重新打开此页面查看'
    trackingTimedOut.value = true
  }
  if (token === pollToken && !trackingTimedOut.value) await refresh(false)
}

async function loadAndResume(token: number) {
  await refresh(false)
  if (token !== lifecycleToken || !props.active) return
  if (job.value && !terminalStates.includes(job.value.state)) {
    await poll(job.value)
    return
  }
  await refresh(true)
  if (token !== lifecycleToken || !props.active) return
  if (job.value && !terminalStates.includes(job.value.state)) await poll(job.value)
}

async function applyUpdate() {
  const target = status.value?.latest
  if (!target || (!npmUpdate.value && !window.confirm(`将 Web 升级到 ${target.webVersion}？`))) return
  const token = lifecycleToken
  operationStarting.value = true
  busy.value = true
  error.value = ''
  try {
    const next = await applySystemUpdate(target.releaseVersion)
    if (token !== lifecycleToken || !props.active) return
    operationStarting.value = false
    await poll(next)
  } catch (cause) {
    if (token === lifecycleToken) error.value = cause instanceof Error ? cause.message : '无法启动系统升级'
  } finally {
    if (token === lifecycleToken) {
      operationStarting.value = false
      busy.value = false
    }
  }
}

async function activateUpdate() {
  if (!prepared.value || !job.value || busy.value) return
  const token = lifecycleToken
  operationStarting.value = true; busy.value = true; error.value = ''
  try {
    const next = await activateSystemUpdate(job.value.id)
    if (token !== lifecycleToken || !props.active) return
    operationStarting.value = false
    await poll(next)
    if (token === lifecycleToken && job.value?.state === 'succeeded') reloadPage()
  } catch (cause) {
    if (token === lifecycleToken) {
      const message = cause instanceof Error ? cause.message : '无法启动服务器更新'
      await refresh(false)
      error.value = message
    }
  } finally {
    if (token === lifecycleToken) { operationStarting.value = false; busy.value = false }
  }
}

async function rollback() {
  if (!window.confirm('回滚到上一个 Web 版本？')) return
  const token = lifecycleToken
  operationStarting.value = true
  busy.value = true
  error.value = ''
  try {
    const next = await rollbackSystemUpdate()
    if (token !== lifecycleToken || !props.active) return
    operationStarting.value = false
    await poll(next)
  } catch (cause) {
    if (token === lifecycleToken) error.value = cause instanceof Error ? cause.message : '无法启动系统回滚'
  } finally {
    if (token === lifecycleToken) {
      operationStarting.value = false
      busy.value = false
    }
  }
}

watch(locked, value => emit('lock-change', value), { immediate: true })
watch(() => props.active, active => {
  const token = ++lifecycleToken
  stopPolling()
  error.value = ''
  trackingTimedOut.value = false
  operationStarting.value = false
  if (!active) {
    emit('lock-change', false)
    return
  }
  job.value = undefined
  remoteChecked.value = false
  busy.value = true
  void loadAndResume(token)
    .finally(() => { if (token === lifecycleToken) busy.value = false })
}, { immediate: true })

onBeforeUnmount(() => { lifecycleToken += 1; operationStarting.value = false; stopPolling(); emit('lock-change', false) })
</script>

<template>
  <section class="system-update-panel" aria-label="更新与回滚">
    <p class="system-update-intro">{{ npmUpdate ? '检查并下载服务器新版本，点击重启服务器后覆盖当前安装。' : '查看 Web 版本、检查更新或回滚到上一个版本。更新完成后刷新页面即可使用新版本。' }}</p>
    <p v-if="error" class="system-update-error" role="alert"><AppIcon name="alert" :size="16" />{{ error }}</p>

    <section v-if="status" class="version-grid" aria-label="版本信息">
      <article><small>当前 Web</small><strong>{{ status.current.webVersion }}</strong></article>
      <article><small>最新 Web</small><strong>{{ error ? '检查失败' : !remoteChecked ? '待检查' : status.latest?.webVersion || (prepared ? job?.target?.webVersion : undefined) || status.current.webVersion }}</strong></article>
    </section>

    <p v-if="status?.releaseSource" class="mode-note">发布源：{{ status.releaseSource }} <a v-if="status.releasePageUrl" :href="status.releasePageUrl" target="_blank" rel="noopener noreferrer">查看发布说明</a></p>
    <p v-if="status?.installationMode === 'source'" class="mode-note">首次升级会把运行服务迁移到可回滚的版本目录；Git 工作区不会被覆盖。</p>
    <p v-if="npmUpdate" class="mode-note">下载完成后仍使用当前版本，点击“重启服务器”后直接覆盖，不保留旧版本。重启期间连接会短暂断开，完成后页面自动刷新。</p>
    <p v-if="status && !status.supported" class="mode-note">{{ status.unsupportedReason }}</p>

    <section v-if="displayedJob" class="update-progress" :class="`update-progress--${displayedJob.state}`" aria-live="polite">
      <span v-if="npmUpdate && jobRunning" class="progress-icon npm-progress" :class="{ 'npm-progress--spinning': progress === undefined }" role="progressbar" aria-label="服务器更新进度" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="progress"><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="npm-progress__track" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" pathLength="100" :stroke-dasharray="`${progress ?? 25} 100`" /></svg></span>
      <span v-else class="progress-icon"><AppIcon :name="displayedJob.state === 'prepared' || displayedJob.state === 'succeeded' || displayedJob.state === 'rolled_back' ? 'check' : displayedJob.state === 'failed' ? 'alert' : 'refresh'" :size="18" /></span>
      <span><strong>{{ displayedJob.message }}</strong><small v-if="displayedJob.error">{{ displayedJob.error }}</small></span>
    </section>

    <footer>
      <button v-if="displayedJob?.state === 'succeeded' || displayedJob?.state === 'rolled_back'" class="quiet-button" type="button" @click="reloadPage"><AppIcon name="refresh" :size="16" />刷新页面</button>
      <button v-else-if="status?.canRollback && !npmUpdate && !jobRunning && !prepared" class="quiet-button danger" type="button" :disabled="busy" @click="rollback">回滚上一版本</button>
      <button class="quiet-button" type="button" :disabled="checking || busy || operationStarting || jobRunning" @click="refresh(true)"><AppIcon name="refresh" :size="16" />{{ checking ? '检查中…' : '检查更新' }}</button>
      <button v-if="prepared" class="solid-button restart-server" type="button" :disabled="busy || operationStarting || !status?.supported" @click="activateUpdate"><AppIcon name="refresh" :size="16" />重启服务器</button>
      <button v-else class="solid-button" type="button" :disabled="!canApply || !!error || !remoteChecked" @click="applyUpdate"><AppIcon name="download" :size="16" />{{ jobRunning ? '升级中…' : error ? '暂无法检查' : !remoteChecked ? '待检查更新' : status?.updateAvailable ? npmUpdate ? '下载更新' : '升级 Web' : '已是最新版本' }}</button>
    </footer>
  </section>
</template>

<style scoped>
.system-update-panel { display: grid; gap: 18px; }
.system-update-intro { margin: 0; max-width: 620px; color: var(--text-secondary); font-size: 14px; line-height: 1.65; }
.system-update-error,.version-warning { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 12px 14px; border-radius: 10px; font-size: 13px; line-height: 1.55; }
.system-update-error { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }
.version-warning { background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); }
.version-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-block: 1px solid var(--line); }
.version-grid article { display: grid; gap: 7px; padding: 18px 20px; border-bottom: 1px solid var(--line); }
.version-grid article:nth-child(odd) { border-right: 1px solid var(--line); }
.version-grid article:nth-last-child(-n+2) { border-bottom: 0; }
.version-grid small { color: var(--text-muted); font-size: 12px; }
.version-grid strong { font-size: 20px; letter-spacing: -.02em; }
.mode-note { margin: -4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.update-progress { display: flex; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.progress-icon { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 50%; background: var(--surface-raised); color: var(--text-secondary); }
.update-progress > span:last-child { display: grid; gap: 4px; min-width: 0; }
.update-progress strong { font-size: 14px; }
.update-progress small { color: var(--danger); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.update-progress:not(.update-progress--prepared, .update-progress--failed, .update-progress--succeeded, .update-progress--rolled_back) .progress-icon:not(.npm-progress) { animation: update-spin 1s linear infinite; }
.npm-progress svg{width:22px;height:22px;transform:rotate(-90deg)}.npm-progress circle{fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round}.npm-progress__track{opacity:.18}.npm-progress--spinning svg{animation:update-spin 1s linear infinite}
.update-progress--prepared .progress-icon{color:var(--success)}
@media(prefers-reduced-motion:reduce){.npm-progress--spinning svg,.update-progress .progress-icon{animation:none!important}}
.update-progress--succeeded .progress-icon,.update-progress--rolled_back .progress-icon { color: var(--success); }
.update-progress--failed .progress-icon { color: var(--danger); }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 6px; padding-top: 18px; border-top: 1px solid var(--line); }
button { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; gap: 7px; padding: 0 14px; border: 0; border-radius: 9px; cursor: pointer; font: 600 13px var(--font-ui); }
.quiet-button { border: 1px solid var(--line); background: var(--surface-raised); color: var(--text-secondary); }
.solid-button { background: var(--accent); color: var(--text-on-solid); }
button:disabled { cursor: not-allowed; opacity: .5; }
.danger { margin-right: auto; color: var(--danger); }
@keyframes update-spin { to { transform: rotate(360deg); } }
@media (max-width: 700px) {
  .version-grid { grid-template-columns: 1fr; }
  .version-grid article,.version-grid article:nth-child(odd),.version-grid article:nth-last-child(-n+2) { border-right: 0; border-bottom: 1px solid var(--line); }
  .version-grid article:last-child { border-bottom: 0; }
  footer .solid-button { flex: 1 1 100%; }
}
</style>
