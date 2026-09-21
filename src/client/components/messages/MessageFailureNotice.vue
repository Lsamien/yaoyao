<script setup lang="ts">
import SystemMessageNotice from './SystemMessageNotice.vue'
import type { MessageFailure } from '@/utils/messageFailure'
defineProps<{ failure: MessageFailure }>()
</script>

<template>
  <SystemMessageNotice class="failure-notice" :title="failure.title" icon="info">
    <p>{{ failure.hint }}</p>
    <pre v-if="failure.detail">{{ failure.detail }}</pre>
  </SystemMessageNotice>
</template>

<style scoped>
.failure-notice { margin-top: 6px; }
p { margin: 0 0 8px; }
pre { max-height: 240px; overflow: auto; margin: 0; padding-top: 10px; border-top: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 var(--font-code); }
</style>
