<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  applySystemUpdate,
  checkSystemUpdate,
  rollbackSystemUpdate,
  systemUpdateJob,
  systemUpdateStatus,
  type SystemUpdateStatus,
  type UpdateJob,
} from '@/api/systemUpdate'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const status = ref<SystemUpdateStatus>()
const job = ref<UpdateJob>()
const busy = ref(false)
const checking = ref(false)
const error = ref('')
let pollToken = 0

const terminal = computed(() => job.value && ['succeeded', 'failed', 'rolled_back'].includes(job.value.state))
const active = computed(() => job.value && !terminal.value)
const canApply = computed(() => Boolean(status.value?.supported && status.value.updateAvailable && status.value.latest && !active.value && !busy.value))

function stopPolling() { pollToken += 1 }
function reloadPage() { window.location.reload() }

async function refresh(checkRemote = false) {
  error.value = ''
  checking.value = checkRemote
  try {
    status.value = checkRemote ? await checkSystemUpdate() : await systemUpdateStatus()
    if (status.value.job) job.value = status.value.job
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取系统版本'
  } finally {
    checking.value = false
  }
}

async function poll(next: UpdateJob) {
  job.value = next
  const token = ++pollToken
  for (let attempt = 0; attempt < 300 && token === pollToken; attempt += 1) {
    if (['succeeded', 'failed', 'rolled_back'].includes(job.value.state)) break
    await new Promise(resolvePromise => window.setTimeout(resolvePromise, 1_000))
    try {
      job.value = await systemUpdateJob(next.id)
    } catch {
      // 15300 会在原子切换期间短暂不可用；继续等待新服务读取同一任务文件。
    }
  }
  if (token === pollToken && job.value && !['succeeded', 'failed', 'rolled_back'].includes(job.value.state)) {
    error.value = '升级仍在后台执行，请稍后重新打开此页面查看'
  }
  if (token === pollToken) await refresh(false)
}

async function applyUpdate() {
  const target = status.value?.latest
  if (!target || !window.confirm(`将 Web 升级到 ${target.webVersion}？`)) return
  busy.value = true
  error.value = ''
  try {
    await poll(await applySystemUpdate(target.releaseVersion))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法启动系统升级'
  } finally {
    busy.value = false
  }
}

async function rollback() {
  if (!window.confirm('回滚到上一个 Web 版本？')) return
  busy.value = true
  error.value = ''
  try {
    await poll(await rollbackSystemUpdate())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法启动系统回滚'
  } finally {
    busy.value = false
  }
}

watch(() => props.open, open => {
  stopPolling()
  error.value = ''
  if (open) {
    job.value = undefined
    busy.value = true
    void refresh(false)
      .then(() => refresh(true))
      .finally(() => { busy.value = false })
  }
})

onBeforeUnmount(stopPolling)
</script>

<template>
  <Teleport to="body">
    <Transition name="system-update-fade">
      <div v-if="open" class="system-update-layer" role="presentation" @mousedown.self="!active && emit('close')">
        <section class="system-update-dialog" role="dialog" aria-modal="true" aria-labelledby="system-update-title">
          <header>
            <div><small>SYSTEM RELEASE</small><h2 id="system-update-title">系统更新</h2></div>
            <button class="icon-button" type="button" aria-label="关闭系统更新" :disabled="!!active" @click="emit('close')"><AppIcon name="close" /></button>
          </header>

          <p class="system-update-intro">查看 Web 版本、检查更新或回滚到上一个版本。更新完成后刷新页面即可使用新版本。</p>
          <p v-if="error" class="system-update-error"><AppIcon name="alert" :size="15" />{{ error }}</p>

          <section v-if="status" class="version-grid">
            <article><small>当前 Web</small><strong>{{ status.current.webVersion }}</strong></article>
            <article><small>最新 Web</small><strong>{{ status.latest?.webVersion || status.current.webVersion }}</strong></article>
          </section>

          <p v-if="status?.installationMode === 'source'" class="mode-note">首次升级会把运行服务迁移到可回滚的版本目录；Git 工作区不会被覆盖。</p>
          <p v-if="status && !status.supported" class="mode-note">{{ status.unsupportedReason }}</p>

          <section v-if="job" class="update-progress" :class="`update-progress--${job.state}`">
            <span class="progress-icon"><AppIcon :name="job.state === 'succeeded' || job.state === 'rolled_back' ? 'check' : job.state === 'failed' ? 'alert' : 'refresh'" :size="17" /></span>
            <span><strong>{{ job.message }}</strong><small v-if="job.error">{{ job.error }}</small></span>
          </section>

          <footer>
            <button v-if="job?.state === 'succeeded' || job?.state === 'rolled_back'" class="quiet-button" type="button" @click="reloadPage"><AppIcon name="refresh" :size="15" />刷新页面</button>
            <button v-else-if="status?.canRollback && !active" class="quiet-button danger" type="button" :disabled="busy" @click="rollback">回滚上一版本</button>
            <button class="quiet-button" type="button" :disabled="checking || !!active" @click="refresh(true)"><AppIcon name="refresh" :size="15" />{{ checking ? '检查中…' : '检查更新' }}</button>
            <button class="solid-button" type="button" :disabled="!canApply" @click="applyUpdate"><AppIcon name="download" :size="16" />{{ active ? '升级中…' : status?.updateAvailable ? '升级 Web' : '已是最新版本' }}</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.system-update-layer { position: fixed; z-index: 270; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(6px); }
.system-update-dialog { width: min(520px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow-y: auto; padding: 19px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
header { display: flex; align-items: flex-start; justify-content: space-between; } header small { color: var(--text-muted); font-size: 9px; letter-spacing: .08em; } h2 { margin: 3px 0 0; font-size: 19px; letter-spacing: -.03em; }
.system-update-intro { margin: 17px 0 14px; color: var(--text-secondary); font-size: 11px; line-height: 1.65; }
.system-update-error, .version-warning { display: flex; align-items: flex-start; gap: 7px; margin: 0 0 13px; padding: 10px; border-radius: 10px; font-size: 10px; line-height: 1.55; }.system-update-error { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }.version-warning { background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); }
.version-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }.version-grid article { display: grid; gap: 5px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }.version-grid small { color: var(--text-muted); font-size: 9px; }.version-grid strong { font-size: 15px; }
.mode-note { margin: 12px 1px 0; color: var(--text-muted); font-size: 9px; line-height: 1.55; }
.update-progress { display: flex; gap: 10px; margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }.progress-icon { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 50%; background: var(--surface-raised); color: var(--text-secondary); }.update-progress > span:last-child { display: grid; gap: 4px; min-width: 0; }.update-progress strong { font-size: 11px; }.update-progress small { color: var(--danger); font-size: 9px; line-height: 1.5; overflow-wrap: anywhere; }.update-progress:not(.update-progress--failed, .update-progress--succeeded, .update-progress--rolled_back) .progress-icon { animation: update-spin 1s linear infinite; }.update-progress--succeeded .progress-icon, .update-progress--rolled_back .progress-icon { color: var(--success); }.update-progress--failed .progress-icon { color: var(--danger); }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); } footer button { gap: 6px; }.danger { margin-right: auto; color: var(--danger); }
.system-update-fade-enter-active, .system-update-fade-leave-active { transition: opacity 140ms ease; }.system-update-fade-enter-active .system-update-dialog, .system-update-fade-leave-active .system-update-dialog { transition: transform 170ms var(--ease-out); }.system-update-fade-enter-from, .system-update-fade-leave-to { opacity: 0; }.system-update-fade-enter-from .system-update-dialog, .system-update-fade-leave-to .system-update-dialog { transform: translateY(8px) scale(.985); }
@keyframes update-spin { to { transform: rotate(360deg); } }
@media (max-width: 540px) { .system-update-layer { place-items: end center; padding: 0; }.system-update-dialog { width: 100%; max-height: calc(100vh - 12px); border-radius: 19px 19px 0 0; padding-bottom: max(18px, env(safe-area-inset-bottom)); }.version-grid { grid-template-columns: 1fr 1fr; } footer .solid-button { flex: 1 1 100%; } }
</style>
