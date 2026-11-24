<script setup lang="ts">
import ExecutionSettingsPanel from '@/components/app/ExecutionSettingsPanel.vue'
import HostToolsPanel from '@/components/app/HostToolsPanel.vue'
import FileAccessPanel from '@/components/app/FileAccessPanel.vue'
</script>

<template>
  <div class="stack">
    <section><h2>执行位置与授权</h2><ExecutionSettingsPanel /></section>
    <section><h2>服务器本机工具</h2><HostToolsPanel /></section>
    <section><h2>文件访问</h2><p class="hint">控制聊天里服务器文件的预览和下载范围。</p><FileAccessPanel /></section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 28px; }
section { display: grid; gap: 10px; }
h2 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 15px; }
.hint { margin: 0; color: var(--text-muted); font-size: 12px; }
</style>
