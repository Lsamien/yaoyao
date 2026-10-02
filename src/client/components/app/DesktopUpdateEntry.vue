<script setup lang="ts">
import { computed } from 'vue'
import type { DesktopUpdateState } from '@shared/desktopUpdate'
import AppIcon from '@/components/common/AppIcon.vue'

const props = defineProps<{ state?: DesktopUpdateState; pending?: boolean; error?: string }>()
const emit = defineEmits<{ activate: [] }>()
const busy = computed(() => Boolean(props.pending || ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(props.state?.phase ?? '')))
const progress = computed(() => props.state?.phase === 'downloading' && props.state.total > 0
  ? Math.max(0, Math.min(100, Math.floor(props.state.received / props.state.total * 100))) : undefined)
const label = computed(() => {
  const state = props.state
  if (state?.phase === 'ready') return state.installMode === 'restart' ? '重新启动' : '打开安装包'
  if (state?.phase === 'installing') return '正在重启…'
  if (state?.phase === 'downloading') return progress.value === undefined ? '正在下载…' : `正在下载 · ${progress.value}%`
  if (['verifying', 'preparing'].includes(state?.phase ?? '')) return '正在准备…'
  if (state?.phase === 'checking' || props.pending) return '正在检测…'
  if (state?.retryable === false) return '更新未完成'
  if (state?.available) return '可更新'
  if (state?.phase === 'failed' || props.error) return '重试更新'
  if (state?.phase === 'checked') return '已是最新版本'
  return '检测更新'
})
const detail = computed(() => props.error || props.state?.error || (props.state?.phase === 'ready'
  ? props.state.installMode === 'restart' ? '更新已下载，点击重新启动完成安装' : '更新已下载，点击打开安装包'
  : busy.value ? label.value : props.state?.available ? `App ${props.state.latestVersion ?? ''} 可更新，点击下载` : props.state?.message))
</script>

<template>
  <div class="desktop-update-entry" :class="{ 'desktop-update-entry--ready': state?.phase === 'ready' }" :title="detail">
    <button type="button" :title="detail" :aria-label="label" :aria-busy="busy" :disabled="busy || state?.retryable === false" @click="emit('activate')">
      <span v-if="busy" class="desktop-update-ring" :class="{ 'desktop-update-ring--spinning': progress === undefined }" role="progressbar" :aria-label="label" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="progress">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="desktop-update-ring__track" cx="12" cy="12" r="9" /><circle class="desktop-update-ring__value" cx="12" cy="12" r="9" pathLength="100" :stroke-dasharray="`${progress ?? 25} 100`" /></svg>
      </span>
      <AppIcon v-else :name="state?.phase === 'ready' ? state.installMode === 'restart' ? 'refresh' : 'download' : state?.retryable === false ? 'alert' : state?.available ? 'download' : 'refresh'" :size="20" />
      <span class="desktop-update-entry__label" aria-live="polite">{{ label }}</span>
      <span v-if="(state?.available || state?.phase === 'ready') && !busy" class="desktop-update-dot" aria-hidden="true" />
    </button>
    <p v-if="error || state?.error" class="desktop-update-error" role="alert">{{ error || state?.error }}</p>
  </div>
</template>

<style scoped>
.desktop-update-entry{position:relative;flex:0 0 auto;width:36px;height:36px;color:var(--accent)}
.desktop-update-entry button{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.desktop-update-entry button:hover{background:var(--surface-hover)}
.desktop-update-entry button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.desktop-update-entry button:disabled{cursor:default}
.desktop-update-entry__label,.desktop-update-error{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.desktop-update-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--accent)}
.desktop-update-entry--ready button{background:rgba(var(--accent-rgb), .10)}
.desktop-update-ring{display:inline-flex;flex:0 0 20px;width:20px;height:20px;color:var(--accent)}
.desktop-update-ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.desktop-update-ring circle{fill:none;stroke:currentColor;stroke-width:2.5}
.desktop-update-ring__track{opacity:.18}.desktop-update-ring__value{stroke-linecap:round}
.desktop-update-ring--spinning svg{animation:desktop-update-spin 1s linear infinite}
@keyframes desktop-update-spin{to{transform:rotate(270deg)}}
@media(prefers-reduced-motion:reduce){.desktop-update-ring--spinning svg{animation:none}}
</style>
