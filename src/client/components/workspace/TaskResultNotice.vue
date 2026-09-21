<script setup lang="ts">
import { computed } from 'vue'
import SystemMessageNotice from '@/components/messages/SystemMessageNotice.vue'

const props = defineProps<{
  content: string
  taskReference: { conversationId: string; taskId: string }
}>()

const lines = computed(() => props.content
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !/^\[打开任务\]\(/.test(line)))

const waitingForReview = computed(() => props.content.includes('等待管理员复核'))
const title = computed(() => waitingForReview.value ? '任务已有新结果' : props.content.includes('已完成') ? '任务已完成' : '任务状态已更新')
const context = computed(() => {
  const match = lines.value[0]?.match(/^「([^」]+)」的任务「([^」]+)」/)
  return match ? `${match[1]} · ${match[2]}` : lines.value[0] || '团队交付任务'
})
const supporting = computed(() => {
  if (waitingForReview.value) return '等待管理员复核后继续'
  return lines.value.slice(1).join(' ') || '打开任务查看完整交付与验收状态'
})
const href = computed(() => `/conversations/${encodeURIComponent(props.taskReference.conversationId)}?taskId=${encodeURIComponent(props.taskReference.taskId)}`)
</script>

<template>
  <SystemMessageNotice class="task-result-notice" :title="title" :icon="waitingForReview ? 'file' : 'check'" :href="href" :accessible-label="`${title}，${context}，${supporting}，打开任务`" />
</template>
