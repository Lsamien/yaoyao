<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest } from '@/api/client'
import ComputerPanel from '@/components/workspace/ComputerPanel.vue'
import type { WorkspaceAgent } from '@shared/workspace'
const route = useRoute(), agent = ref<WorkspaceAgent>(), error = ref(''), panel = ref<InstanceType<typeof ComputerPanel>>()
const backend = ref<'desktop' | 'cloud' | 'vm'>(), host = ref<string>()
let detach: (() => void) | undefined
async function finish(){await window.yaoyaoDesktop?.computerClosed()}
async function targetChanged(backend: 'desktop' | 'cloud' | 'vm', host?: string) {
  await window.yaoyaoDesktop?.computerTargetChanged?.({backend,host})
}
async function close() {
  if (panel.value) await panel.value.close()
  else await window.yaoyaoDesktop?.computerClosed()
}
onMounted(async () => {
  detach = window.yaoyaoDesktop?.onComputerClose(() => { void close() })
  try {
    const requestedBackend = route.query.backend, requestedHost = route.query.host
    if (requestedBackend !== undefined && requestedBackend !== 'desktop' && requestedBackend !== 'cloud' && requestedBackend !== 'vm')
      throw new Error('所选电脑无效，请关闭窗口后重新选择')
    if (requestedHost !== undefined && (requestedBackend !== 'desktop' || typeof requestedHost !== 'string' || !/^[\w-]{1,128}$/.test(requestedHost)))
      throw new Error('所选电脑无效，请关闭窗口后重新选择')
    backend.value = requestedBackend
    host.value = typeof requestedHost === 'string' ? requestedHost : undefined
    const result = await apiRequest<{agents: WorkspaceAgent[]}>('/api/app/agents')
    agent.value = result.agents.find(item => item.id === route.params.agentId)
    if (!agent.value) throw new Error('这台电脑不可用，或你已没有访问权限')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法打开电脑' }
})
onBeforeUnmount(() => detach?.())
</script>
<template>
  <ComputerPanel v-if="agent" ref="panel" :agents="[agent]" :backend="backend" :host="host" standalone auto-take @close="finish" @target-changed="targetChanged" />
  <main v-else class="viewer-loading" role="status"><p>{{ error || '正在连接电脑…' }}</p><button v-if="error" @click="close">关闭窗口</button></main>
</template>
<style scoped>
.viewer-loading{height:100dvh;display:grid;place-content:center;background:#111315;color:#f4f4f4;text-align:center}.viewer-loading button{padding:12px;border-radius:8px;border:1px solid #666;background:#292c30;color:inherit}
</style>
