<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from './MarkdownContent.vue'
import ToolTrace from './ToolTrace.vue'
import type { TurnTraceGroup } from '@/utils/turnTrace'

const props = defineProps<{ group: TurnTraceGroup }>()
const reasoningCount = computed(() => props.group.entries.filter(entry => entry.type === 'reasoning').length)
const toolCount = computed(() => props.group.entries.filter(entry => entry.type === 'tool').length)
const summary = computed(() => [
  reasoningCount.value ? `${reasoningCount.value} 段思考` : '',
  toolCount.value ? `${toolCount.value} 个工具` : '',
].filter(Boolean).join(' · '))
const statusLabel = computed(() => props.group.status === 'running' ? '进行中' : props.group.status === 'error' ? '有错误' : '')
</script>

<template>
  <details class="turn-trace" :class="`turn-trace--${group.status}`">
    <summary>
      <AppIcon name="brain" :size="13" />
      <strong>思考与工具</strong>
      <small>{{ summary }}</small>
      <em v-if="statusLabel">{{ statusLabel }}</em>
      <span class="turn-trace__caret">›</span>
    </summary>
    <div class="turn-trace__content">
      <template v-for="entry in group.entries" :key="entry.id">
        <section v-if="entry.type === 'reasoning'" class="turn-trace__item turn-trace__reasoning">
          <header><AppIcon name="brain" :size="12" />思考过程 · {{ entry.content.length }} 字</header>
          <MarkdownContent process-content :content="entry.content" :streaming="group.status === 'running'" />
        </section>
        <ToolTrace v-else class="turn-trace__item turn-trace__tool" :tool="entry.tool" expanded />
      </template>
    </div>
  </details>
</template>

<style scoped>
.turn-trace { width: min(680px, 100%); margin: 2px 0 9px; border-radius: 10px; color: var(--text-muted); transition: background-color 100ms ease; }.turn-trace[open] { background: color-mix(in srgb, var(--surface-soft) 45%, var(--surface)); }.turn-trace > summary { display: flex; width: fit-content; min-height: 28px; align-items: center; gap: 6px; padding: 2px 7px 2px 2px; border-radius: 7px; cursor: pointer; list-style: none; transition: background-color 100ms ease, color 100ms ease; }.turn-trace > summary::-webkit-details-marker { display: none; }.turn-trace > summary:hover, .turn-trace > summary:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-secondary); }.turn-trace > summary strong { color: var(--text-secondary); font-size: 10px; font-weight: 540; }.turn-trace > summary small { font-size: 9px; }.turn-trace > summary em { color: var(--warning); font-size: 8px; font-style: normal; }.turn-trace--error > summary em { color: var(--danger); }
.turn-trace__caret { display: inline-block; width: 9px; font-size: 14px; line-height: 1; transition: transform 120ms ease; }.turn-trace[open] .turn-trace__caret { transform: rotate(90deg); }
.turn-trace__content { display: grid; max-height: min(420px, 52vh); margin: 1px 0 6px; padding: 2px 8px 4px 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.turn-trace__item { min-width: 0; }
.turn-trace__reasoning { max-width: 620px; padding: 7px 0 5px; color: var(--text-secondary); }.turn-trace__reasoning header { display: flex; min-height: 22px; align-items: center; gap: 5px; margin-bottom: 6px; color: var(--text-muted); font-size: 9px; }.turn-trace__reasoning :deep(.markdown) { font-size: 11px; line-height: 1.58; }
.turn-trace :deep(.turn-trace__tool) { margin: 0; padding: 5px 0; }
.turn-trace :deep(.turn-trace__tool .tool-trace__details) { margin-left: 0; border-left: 0; }
.turn-trace :deep(.turn-trace__tool .tool-trace__details pre) { max-height: none; overflow: visible; }
@media (prefers-reduced-motion: reduce) { .turn-trace, .turn-trace > summary, .turn-trace__caret { transition: none; } }
</style>
