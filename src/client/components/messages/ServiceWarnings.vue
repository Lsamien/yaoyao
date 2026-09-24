<script setup lang="ts">
import SystemMessageNotice from './SystemMessageNotice.vue'
import type { UiMessage } from './types'
defineProps<{ warnings: NonNullable<UiMessage['serviceWarnings']> }>()
</script>
<template>
  <div v-if="warnings.length" class="service-warnings" aria-label="服务状态提示">
    <SystemMessageNotice v-for="(warning,index) in warnings" :key="`${warning.service}:${warning.code}:${index}`" :title="`${warning.service}：${warning.message}`" icon="info"/>
  </div>
</template>
