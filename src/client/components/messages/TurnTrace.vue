<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from './MarkdownContent.vue'
import ToolTrace from './ToolTrace.vue'
import SystemMessageNotice from './SystemMessageNotice.vue'
import type { TurnTraceGroup } from '@/utils/turnTrace'

const props = defineProps<{ group: TurnTraceGroup; streamIntervalMs?: number }>()
const reasoningCount = computed(() => props.group.entries.filter(entry => entry.type === 'reasoning').length)
const toolCount = computed(() => props.group.entries.filter(entry => entry.type === 'tool').length)
const summary = computed(() => [
  reasoningCount.value ? `${reasoningCount.value} 段思考` : '',
  toolCount.value ? `${toolCount.value} 个工具` : '',
].filter(Boolean).join(' · '))
const statusLabel = computed(() => props.group.status === 'running' ? '进行中' : props.group.status === 'error' ? '有错误' : '')
</script>

<template>
  <SystemMessageNotice class="turn-trace" icon="brain" :title="group.status === 'running' ? '正在思考与使用工具' : group.status === 'error' ? '思考与工具出现错误' : '思考与工具'">
    <p class="turn-trace__summary">{{ summary }}<template v-if="statusLabel"> · {{ statusLabel }}</template></p>
    <div class="turn-trace__content">
      <template v-for="entry in group.entries" :key="entry.id">
        <section v-if="entry.type === 'reasoning'" class="turn-trace__item turn-trace__reasoning">
          <header><AppIcon name="brain" :size="12" />思考过程 · {{ entry.content.length }} 字</header>
          <MarkdownContent process-content :content="entry.content" :streaming="group.status === 'running'" :stream-interval-ms="streamIntervalMs" />
        </section>
        <ToolTrace v-else class="turn-trace__item turn-trace__tool" :tool="entry.tool" expanded />
      </template>
    </div>
  </SystemMessageNotice>
</template>

<style scoped>
.turn-trace { margin: 2px 0 9px; }
.turn-trace__summary { margin: 0 0 8px; color: var(--text-secondary); font-size: 12px; }
.turn-trace__content { display: grid; max-height: min(420px, 52vh); margin: 1px 0 6px; padding: 2px 8px 4px 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.turn-trace__item { min-width: 0; }
.turn-trace__reasoning { max-width: 620px; padding: 7px 0 5px; color: var(--text-secondary); }.turn-trace__reasoning header { display: flex; min-height: 22px; align-items: center; gap: 5px; margin-bottom: 6px; color: var(--text-muted); font-size: 9px; }.turn-trace__reasoning :deep(.markdown) { font-size: 11px; line-height: 1.58; }
.turn-trace :deep(.turn-trace__tool) { margin: 0; padding: 5px 0; }
.turn-trace :deep(.turn-trace__tool .tool-trace__details) { margin-left: 0; border-left: 0; }
.turn-trace :deep(.turn-trace__tool .tool-trace__details pre) { max-height: none; overflow: visible; }
@media (prefers-reduced-motion: reduce) { .turn-trace, .turn-trace > summary, .turn-trace__caret { transition: none; } }
</style>
