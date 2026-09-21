<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

type Mode = 'client' | 'server'
const desktop = window.yaoyaoDesktop
const state = ref<{ mode: Mode; serverURL: string; switching: boolean }>()
const selected = ref<Mode>('client')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const options = [
  { mode: 'client', title: '客户端模式', description: '连接另一台电脑上的夭夭服务器。本机无需安装 Hermes。', icon: 'link' },
  { mode: 'server', title: '服务器模式', description: '在这台电脑上运行夭夭服务，使用本机 Hermes，并供其他客户端连接。', icon: 'monitor' },
] as const

async function load() {
  busy.value = true; error.value = ''
  try {
    state.value = await desktop!.modeState!()
    selected.value = state.value.mode
  } catch (e) { error.value = e instanceof Error ? e.message : '无法读取运行模式，请重试。' }
  finally { busy.value = false }
}
async function switchMode() {
  if (busy.value || !state.value || selected.value === state.value.mode) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await desktop!.switchMode!(selected.value)
    if (!result.ok) throw new Error(result.error || '切换运行模式未完成，请重试。')
    if (result.pendingLogin) notice.value = '请在当前页面完成服务器连接与登录。'
    else await load()
  } catch (e) { error.value = e instanceof Error ? e.message : '切换运行模式未完成，请重试。' }
  finally { busy.value = false }
}
async function changeServer() {
  busy.value = true; error.value = ''; notice.value = ''
  try { await desktop!.openRemoteLogin!() }
  catch (e) { error.value = e instanceof Error ? e.message : '无法打开服务器登录页面。' }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <section class="desktop-mode-panel" aria-label="服务器与客户端模式" :aria-busy="busy">
    <div v-if="state" class="mode-status">
      <strong>当前：{{ state.mode === 'client' ? '客户端模式' : '服务器模式' }}</strong>
      <span v-if="state.serverURL">{{ state.serverURL }}</span>
    </div>
    <p v-else-if="busy" role="status">正在读取运行模式…</p>
    <fieldset :disabled="busy || !state || state.switching">
      <legend>这台电脑如何使用夭夭？</legend>
      <label v-for="option in options" :key="option.mode" class="mode-option" :class="{ selected: selected === option.mode }">
        <input v-model="selected" type="radio" name="desktop-running-mode" :value="option.mode" />
        <AppIcon :name="option.icon" :size="22" />
        <span><strong>{{ option.title }}</strong><small>{{ option.description }}</small></span>
      </label>
    </fieldset>
    <p class="mode-note">切换后会打开对应服务的页面，并记住选择。数据保留在原服务器；连接另一台服务器时，可能需要登录。</p>
    <p v-if="error" class="mode-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="mode-actions">
      <button v-if="!state" type="button" :disabled="busy" @click="load">重新读取</button>
      <button v-else class="mode-primary" type="button" :disabled="busy || state.switching || selected === state.mode" @click="switchMode">
        {{ busy ? '正在切换…' : selected === state.mode ? '正在使用此模式' : selected === 'client' ? '切换为客户端' : '切换为服务器' }}
      </button>
      <button v-if="desktop?.openRemoteLogin" type="button" :disabled="busy || state?.switching" @click="changeServer">更换服务器…</button>
    </div>
  </section>
</template>

<style scoped>
.desktop-mode-panel{display:grid;gap:20px;max-width:640px;color:var(--text-primary)}
.mode-status{display:grid;gap:6px;padding:16px;border-radius:12px;background:var(--surface-soft)}
.mode-status span{color:var(--text-secondary);font-size:13px;overflow-wrap:anywhere}
fieldset{display:grid;gap:12px;min-width:0;margin:0;padding:0;border:0}
legend{padding:0 0 12px;font-weight:600}
.mode-option{display:flex;align-items:center;gap:12px;padding:18px;border:1px solid var(--line-strong);border-radius:12px;cursor:pointer}
.mode-option.selected{border-color:var(--accent);background:var(--settings-selected)}
.mode-option input{flex:none;margin:0;accent-color:var(--accent)}
.mode-option span{display:grid;gap:6px;min-width:0}
.mode-option small{font-size:13px;line-height:1.6;color:var(--text-secondary)}
.mode-option:focus-within{outline:2px solid var(--accent);outline-offset:3px}
fieldset:disabled .mode-option{cursor:default;opacity:.65}
.mode-note{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.7}
.mode-error{margin:0;color:var(--danger)}
.mode-actions{display:flex;flex-wrap:wrap;gap:12px}
.mode-actions button{min-height:44px;padding:10px 18px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-soft);color:var(--text-primary);font:inherit;cursor:pointer}
.mode-actions .mode-primary{background:var(--accent);border-color:var(--accent);color:var(--text-on-solid)}
.mode-actions button:disabled{opacity:.5;cursor:default}
.mode-actions button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
