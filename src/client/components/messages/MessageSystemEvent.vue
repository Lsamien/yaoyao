<script setup lang="ts">
import { computed } from 'vue'
import type { UiMessage } from './types'
import { systemMessageNotice } from '@/utils/systemMessageNotice'
import MarkdownContent from './MarkdownContent.vue'
import SystemMessageNotice from './SystemMessageNotice.vue'

const props = defineProps<{ message: UiMessage }>()
const notice = computed(() => systemMessageNotice(props.message))
const metadata = computed(() => {
  const data = props.message.timelineMetadata
  if (!data) return ''
  if (props.message.timelineKind === 'delegation-complete') {
    const completed = Number(data.completed_count ?? 0)
    const failed = Number(data.failed_count ?? 0)
    const seconds = Number(data.duration_seconds ?? 0)
    const duration = seconds > 0 ? ` · 耗时 ${Math.round(seconds)} 秒` : ''
    return `${Number(data.task_count) || completed + failed || 1} 个子任务 · ${completed} 已完成 · ${failed} 失败${duration}`
  }
  if (props.message.timelineKind === 'background-process') return [data.exit_code != null ? `退出码：${data.exit_code}` : '', data.signal ? `信号：${data.signal}` : ''].filter(Boolean).join(' · ')
  return ''
})
</script>

<template>
  <SystemMessageNotice v-if="notice" :title="notice.title" :icon="notice.icon">
    <p v-if="metadata">{{ metadata }}</p>
    <MarkdownContent v-if="message.content" process-content :content="message.content" />
  </SystemMessageNotice>
</template>
