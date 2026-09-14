<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { checkSystemUpdate, systemUpdateStatus, type SystemUpdateStatus } from '@/api/systemUpdate'
import AppIcon from '@/components/common/AppIcon.vue'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'

const emit = defineEmits<{ close: []; manage: [] }>()
const status = ref<SystemUpdateStatus>()
const checking = ref(true)
const checked = ref(false)
const error = ref('')
let disposed = false
const message = computed(() => checking.value ? '正在检测更新…'
  : error.value ? '检测失败，请重试'
    : status.value?.updateAvailable ? `发现新版本 ${status.value.latest?.webVersion}` : '当前已是最新版本')
const releasePage = computed(() => {
  try {
    const url = new URL(status.value?.releasePageUrl || '')
    return url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
})

async function check() {
  checking.value = true
  checked.value = false
  error.value = ''
  try {
    const next = await checkSystemUpdate()
    if (disposed) return
    status.value = next
    checked.value = true
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '无法连接更新服务'
  } finally { if (!disposed) checking.value = false }
}
onMounted(async () => {
  // Keep the installed version visible even when the remote check fails.
  try { const current = await systemUpdateStatus(); if (!disposed) status.value = current } catch { /* The check below reports actionable errors. */ }
  if (!disposed) await check()
})
onBeforeUnmount(() => { disposed = true })
</script>
<template>
  <StandaloneDialog title="检测更新" compact @close="emit('close')">
    <section class="update-check" :aria-busy="checking">
      <div class="update-check__icon" :class="{ spinning: checking }"><AppIcon :name="checking ? 'refresh' : error ? 'alert' : status?.updateAvailable ? 'download' : 'check'" :size="28" /></div>
      <p class="update-check__status" role="status" aria-live="polite">{{ message }}</p>
      <dl aria-label="Web 版本信息"><div><dt>当前 Web 版本</dt><dd>{{ status?.current.webVersion || '—' }}</dd></div><div><dt>最新版本</dt><dd>{{ checking ? '检测中…' : !checked ? '未获取' : status?.latest?.webVersion || status?.current.webVersion }}</dd></div></dl>
      <p v-if="error" class="update-check__error" role="alert">{{ error }}</p>
      <p v-if="checked && status?.updateAvailable && !status.supported" class="update-check__note">{{ status.unsupportedReason || '请通过部署环境更新 Web。' }}</p>
      <a v-if="checked && releasePage" :href="releasePage" target="_blank" rel="noopener noreferrer">查看发布说明<AppIcon name="external" :size="14" /></a>
      <div class="update-check__actions">
        <button type="button" :disabled="checking" @click="check">{{ checking ? '正在检测…' : error ? '重试' : '重新检测' }}</button>
        <button v-if="checked && status?.updateAvailable && status.supported" class="primary" type="button" @click="emit('manage')">前往更新</button>
      </div>
    </section>
  </StandaloneDialog>
</template>
<style scoped>
.update-check{display:grid;gap:18px;text-align:center}.update-check__icon{display:grid;place-items:center;color:var(--accent)}.update-check__status{margin:0;font-size:16px;font-weight:600;line-height:1.5}dl{display:grid;gap:12px;margin:0;padding:16px 0;border-block:1px solid var(--line);font-size:13px}dl div{display:flex;justify-content:space-between;gap:12px}dt{color:var(--text-secondary)}dd{margin:0;font-variant-numeric:tabular-nums}.update-check__error,.update-check__note{margin:0;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.update-check__error{color:var(--danger)}.update-check__note{color:var(--text-secondary)}a{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;color:var(--accent);font-size:13px;text-decoration:none}a:hover{text-decoration:underline}.update-check__actions{display:flex;gap:10px;flex-wrap:wrap}button{flex:1;min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:9px;background:var(--surface-raised);color:var(--text-primary);font:500 13px var(--font-ui);cursor:pointer}button:hover{background:var(--surface-hover)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--text-on-solid)}button:disabled{opacity:.6;cursor:wait}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.spinning{animation:update-spin 1s linear infinite}@keyframes update-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
