<script setup lang="ts">
import DuplexVoicePanel from '@/components/app/DuplexVoicePanel.vue'
import WorkspaceVoiceProviders from '@/components/workspace/WorkspaceVoiceProviders.vue'
</script>

<template>
  <div class="stack">
    <DuplexVoicePanel />
    <WorkspaceVoiceProviders />
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 24px; }
</style>
