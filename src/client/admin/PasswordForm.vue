<script setup lang="ts">
import { ref } from 'vue'
import { changePassword } from './api'

const emit = defineEmits<{ done: [] }>()
const current = ref('')
const next = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function submit() {
  if (busy.value) return
  if (next.value !== confirm.value) { error.value = '两次输入的新密码不一致'; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await changePassword(current.value, next.value)
    current.value = next.value = confirm.value = ''
    notice.value = '密码已修改。夭夭 Web 和其他设备上的登录已全部退出。'
    emit('done')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '修改失败' }
  finally { busy.value = false }
}
</script>

<template>
  <form class="password-form" @submit.prevent="submit">
    <label for="console-current-password">当前密码<input id="console-current-password" v-model="current" type="password" autocomplete="current-password" required :disabled="busy" /></label>
    <label for="console-new-password">新密码<input id="console-new-password" v-model="next" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" /></label>
    <label for="console-confirm-password">再次输入新密码<input id="console-confirm-password" v-model="confirm" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" /></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <button class="solid-button" :disabled="busy || !current || next.length < 8 || !confirm">{{ busy ? '正在保存…' : '修改密码' }}</button>
  </form>
</template>

<style scoped>
.password-form { display: grid; gap: 12px; max-width: 380px; }
label { display: grid; gap: 6px; font-size: 13px; color: var(--text-secondary); font-weight: 600; }
input { height: 40px; padding: 0 12px; border: 1px solid var(--input-border-color); border-radius: 9px; background: var(--surface); color: var(--text-primary); font: 14px var(--font-ui); }
input:focus { outline: 0; border-color: var(--input-border-focus-color); box-shadow: 0 0 0 3px var(--focus-ring); }
.solid-button { height: 40px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); cursor: pointer; }
.solid-button:disabled { opacity: .5; cursor: default; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.notice { margin: 0; color: var(--success); font-size: 13px; }
</style>
