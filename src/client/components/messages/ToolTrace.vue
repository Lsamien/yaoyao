<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { apiRequest } from '@/api/client'
import type { UiToolCall } from './types'

const props = withDefaults(defineProps<{ tool: UiToolCall; expanded?: boolean }>(), { expanded: false })
const open = ref(props.expanded || props.tool.status === 'error')
const loaded = shallowRef<{ input?: unknown; output?: unknown }>()
const loading = ref(false), error = ref('')
let request: AbortController | undefined
async function loadDetails() {
  const url = props.tool.detailsUrl
  if (!open.value || !url || loaded.value || loading.value) return
  const controller = new AbortController()
  request = controller; loading.value = true; error.value = ''
  try {
    const value = await apiRequest<{ input?: unknown; output?: unknown }>(url, { signal: controller.signal })
    if (request === controller && !controller.signal.aborted) loaded.value = value
  } catch (cause) {
    if (request === controller && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '工具详情加载失败'
  } finally { if (request === controller) loading.value = false }
}
watch(() => props.tool.detailsUrl, () => { request?.abort();request = undefined;loaded.value = undefined;loading.value = false;error.value = '';void loadDetails() })
watch(open, () => { void loadDetails() }, { immediate: true })
onBeforeUnmount(() => request?.abort())
const statusLabel = computed(() => ({ running: '运行中', success: '完成', error: '失败', pending: '等待', interrupted: '已结束，结果未确认' })[props.tool.status])
function detail(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value ?? '') }
}
const inputDetail = computed(() => detail(loaded.value ? loaded.value.input : props.tool.input))
const outputDetail = computed(() => detail(loaded.value ? loaded.value.output : props.tool.output))
watch(() => props.expanded, value => { if (value) open.value = true })
</script>

<template>
  <div class="tool-trace" :class="`tool-trace--${tool.status}`">
    <button type="button" @click="open = !open">
      <strong>{{ tool.name }}</strong>
      <small v-if="tool.status === 'error' || tool.status === 'interrupted'">{{ statusLabel }}</small>
      <span class="tool-trace__caret" :class="{ open }">›</span>
    </button>
    <div v-if="open && (inputDetail || outputDetail || tool.detailsUrl)" class="tool-trace__details">
      <small v-if="loading" role="status">正在加载工具详情…</small>
      <button v-if="error" type="button" @click="loadDetails">{{ error }}，点击重试</button>
      <section v-if="inputDetail"><small>输入</small><pre>{{ inputDetail }}</pre></section>
      <section v-if="outputDetail"><small>输出</small><pre>{{ outputDetail }}</pre></section>
    </div>
  </div>
</template>

<style scoped>
.tool-trace { margin: 7px 0; color: var(--text-muted); }
.tool-trace > button { display: inline-flex; min-height: 22px; align-items: center; gap: 7px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: 10px/1.5 var(--font-code); text-align: left; }
.tool-trace > button:hover { color: var(--text-secondary); }
.tool-trace > button strong { font: inherit; font-weight: 400; letter-spacing: .01em; }
.tool-trace > button small { color: var(--danger); font: inherit; }
.tool-trace__caret { display: inline-block; width: 9px; color: var(--text-muted); font-size: 13px; line-height: 1; transition: transform 120ms ease; }.tool-trace__caret.open { transform: rotate(90deg); }
.tool-trace__details { margin: 4px 0 4px 16px; border-left: 1px dashed var(--line-strong); }.tool-trace__details section + section { margin-top: 7px; }.tool-trace__details small { display: block; padding: 0 9px 2px; color: var(--text-muted); font: 8px/1.4 var(--font-ui); letter-spacing: .05em; }.tool-trace__details pre { max-width: min(680px, 100%); max-height: 260px; margin: 0; padding: 4px 9px 7px; overflow: auto; background: transparent; color: var(--text-secondary); font: 10px/1.55 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-trace--error { color: var(--danger); }
</style>
