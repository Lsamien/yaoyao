<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { OpenVikingSyncStatus } from '@shared/openVikingSync'
const state = ref<OpenVikingSyncStatus>(), error = ref(''), busy = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined, closed = false
async function refresh(retry = false) {
  if (busy.value || closed) return
  busy.value = true
  try {
    const next = await apiRequest<OpenVikingSyncStatus>(`/api/app/admin/openviking/session-sync${retry ? '/retry' : ''}`, retry ? { method: 'POST', body: {} } : {})
    if (!closed) { state.value = next; error.value = '' }
  } catch (cause) { if (!closed) error.value = cause instanceof Error ? cause.message : '无法读取会话同步状态' }
  finally { busy.value = false }
}
async function poll() { await refresh(); if (!closed) timer = setTimeout(poll, 5000) }
onMounted(poll)
onBeforeUnmount(() => { closed = true; clearTimeout(timer) })
</script>
<template>
  <section class="session-sync" aria-label="OpenViking 会话同步">
    <h4>会话同步</h4>
    <p v-if="state && !state.enabled">同步已暂停，启用 OpenViking 后会继续补齐历史会话。</p>
    <p v-else-if="state?.backfilling" role="status">正在扫描历史会话…</p>
    <p v-if="state" role="status">待同步 {{ state.pending }} · 已完成 {{ state.complete }} · 失败 {{ state.failed }}</p>
    <p v-if="error || state?.lastError" class="sync-error" role="alert">{{ error || state?.lastError }}</p>
    <p class="hint">会话正文在后台同步，长期记忆继续使用现有提炼与遗忘规则。</p>
    <button type="button" :disabled="busy || !state?.enabled || !state.failed" @click="refresh(true)">{{ busy ? '读取中…' : '重试失败的同步' }}</button>
  </section>
</template>
<style scoped>
.session-sync{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}h4{margin:0 0 12px;font-size:15px}p{line-height:1.6;overflow-wrap:anywhere}.hint{color:var(--text-secondary)}.sync-error{color:var(--danger)}button{min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
