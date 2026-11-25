<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { apiRequest } from '@/api/client'
import DeviceAuthorizationPanel from '@/components/app/DeviceAuthorizationPanel.vue'
import DesktopHostSettingsPanel from '@/components/app/DesktopHostSettingsPanel.vue'
import RunnerSettingsPanel from '@/components/app/RunnerSettingsPanel.vue'
import GrokAuthPanel from '@/components/workspace/GrokAuthPanel.vue'

const pairing = ref<{ code: string; expiresAt: number }>()
const busy = ref(false)
const error = ref('')
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now(); if (pairing.value && pairing.value.expiresAt <= now.value) pairing.value = undefined }, 1000)
onBeforeUnmount(() => clearInterval(timer))

async function createCode() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { pairing.value = await apiRequest<{ code: string; expiresAt: number }>('/api/app/admin/desktop-hosts/pairing-codes', { method: 'POST', body: {} }) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法生成配对码' }
  finally { busy.value = false }
}
const left = () => pairing.value ? Math.max(0, Math.ceil((pairing.value.expiresAt - now.value) / 1000)) : 0
</script>

<template>
  <div class="stack">
    <section>
      <h2>添加电脑</h2>
      <p class="hint">在要加入的 Mac 或 Windows 电脑上打开夭夭 App，登录这台服务器后选择「用配对码注册这台电脑」，输入下面的配对码。配对码 10 分钟内有效，只能使用一次。</p>
      <div class="pairing">
        <button class="solid" type="button" :disabled="busy" @click="createCode">{{ pairing ? '重新生成' : '生成配对码' }}</button>
        <template v-if="pairing">
          <code class="code" aria-label="配对码">{{ pairing.code }}</code>
          <span class="hint">剩余 {{ Math.floor(left() / 60) }}:{{ String(left() % 60).padStart(2, '0') }}</span>
        </template>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
    <section><h2>远程电脑</h2><DesktopHostSettingsPanel /></section>
    <section><DeviceAuthorizationPanel /></section>
    <section><h2>执行节点</h2><RunnerSettingsPanel /></section>
    <section><h2>Grok 云电脑授权</h2><GrokAuthPanel manage /></section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 28px; }
section { display: grid; gap: 10px; }
h2 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 15px; }
.hint { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.pairing { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.code { padding: 8px 16px; border-radius: 10px; background: var(--surface-soft); font: 600 22px var(--font-code); letter-spacing: .18em; }
.solid { height: 36px; padding: 0 16px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); cursor: pointer; }
.solid:disabled { opacity: .5; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
</style>
