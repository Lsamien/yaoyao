<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { ManagedBrowserCard } from '@shared/managedBrowser'
const props = defineProps<{ card: ManagedBrowserCard; readOnly?: boolean }>()
const emit = defineEmits<{ open: [card: ManagedBrowserCard] }>()
const status = computed(() => ({ preparing: '正在准备', ready: '可接管', active: '浏览器已打开', idle: '页面已保留', closed: '会话已结束', failed: '需要重试' })[props.card.status])
const progress = computed(() => {
  const value = props.card.installation?.progress
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined
})
</script>
<template>
  <section class="managed-browser-card" aria-label="托管浏览器会话">
    <div class="browser-card-heading"><AppIcon name="globe" :size="18" aria-hidden="true"/><strong>托管浏览器</strong><span class="browser-card-state" :class="{ failed: card.status === 'failed' }">{{ status }}</span></div>
    <strong class="browser-card-title">{{ card.title || `${card.agentName}的浏览器` }}</strong>
    <p v-if="card.url" class="browser-card-url">{{ card.url }}</p>
    <p v-if="card.message || card.installation?.message" role="status">{{ card.message || card.installation?.message }}</p>
    <progress v-if="card.status === 'preparing'" :value="progress" max="100" aria-label="浏览器准备进度"/>
    <p v-if="card.installation?.error && card.installation.error !== card.message" class="browser-card-error" role="alert">{{ card.installation.error }}</p>
    <button v-if="!readOnly" type="button" @click="emit('open', card)">{{ card.status === 'failed' ? '重试并接管浏览器' : card.status === 'closed' ? '打开此 Bot 的浏览器' : '接管浏览器' }}<AppIcon name="external" :size="14" aria-hidden="true"/></button>
    <small v-if="card.status === 'closed'">打开此 Bot 当前的浏览器；已关闭或回收的页面不会自动恢复。</small>
    <small v-else-if="card.status === 'idle'">页面可跨任务继续使用；长时间空闲后可能回收。</small>
    <small v-else>接管后暂停机器人的浏览器操作；交还后恢复仍在运行的任务。</small>
  </section>
</template>
<style scoped>
.managed-browser-card{box-sizing:border-box;display:grid;gap:10px;width:420px;max-width:100%;min-width:0;padding:16px;margin:6px 0;border:1px solid var(--line);border-radius:12px;background:var(--surface-soft);color:var(--text-primary)}
.browser-card-heading{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}.browser-card-state{margin-left:auto;font-size:12px;color:var(--text-secondary);text-align:right}.browser-card-title{font-size:15px;line-height:1.5;overflow-wrap:anywhere}.managed-browser-card p{margin:0;font-size:13px;line-height:1.6;overflow-wrap:anywhere;color:var(--text-secondary)}.managed-browser-card .browser-card-url{font-size:12px}.managed-browser-card small{font-size:12px;line-height:1.6;color:var(--text-secondary)}.managed-browser-card .failed,.managed-browser-card .browser-card-error{color:var(--danger)}
.managed-browser-card progress{width:100%;height:6px;accent-color:var(--accent)}.managed-browser-card button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:13px;font-weight:600;background:var(--surface);color:var(--text-primary);cursor:pointer}.managed-browser-card button:hover{background:var(--surface-hover)}.managed-browser-card button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.managed-browser-card button:active{background:var(--surface-raised)}
@media(max-width:480px){.managed-browser-card{width:100%;padding:12px}.browser-card-heading{flex-wrap:wrap}}
</style>
