<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { beginTwoStep, confirmTwoStep } from './api'

const emit = defineEmits<{ done: [] }>()
const secret = ref('')
const otpauth = ref('')
const code = ref('')
const recoveryCodes = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const copied = ref(false)

const grouped = (value: string) => value.replace(/(.{4})/g, '$1 ').trim()

async function begin() {
  busy.value = true; error.value = ''
  try { const started = await beginTwoStep(); secret.value = started.secret; otpauth.value = started.otpauth }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法开始设置' }
  finally { busy.value = false }
}

async function confirm() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { recoveryCodes.value = (await confirmTwoStep(code.value.trim())).recoveryCodes }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '验证失败' }
  finally { busy.value = false }
}

async function copyCodes() {
  try { await navigator.clipboard.writeText(recoveryCodes.value.join('\n')); copied.value = true }
  catch { copied.value = false }
}

onMounted(begin)
</script>

<template>
  <div class="two-step">
    <template v-if="!recoveryCodes.length">
      <ol>
        <li>在手机上打开验证器 App（如 Google Authenticator、Microsoft Authenticator、1Password），选择「手动输入密钥」。</li>
        <li>账号填「夭夭管理后台」，密钥填下面这串字符，类型选「基于时间」。</li>
        <li>输入 App 上显示的 6 位验证码完成绑定。</li>
      </ol>
      <div v-if="secret" class="secret" aria-label="密钥"><code>{{ grouped(secret) }}</code></div>
      <details v-if="otpauth"><summary>使用 otpauth 链接</summary><code class="link">{{ otpauth }}</code></details>
      <form class="confirm" @submit.prevent="confirm">
        <label for="two-step-code">验证码<input id="two-step-code" v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="6 位数字" required :disabled="busy || !secret" /></label>
        <button class="solid-button" :disabled="busy || code.trim().length < 6">完成绑定</button>
      </form>
    </template>
    <template v-else>
      <p class="done">二次验证已开启。下面是 10 个一次性恢复码，手机丢失时可代替验证码登录，每个只能用一次。它们只显示这一次，请保存到安全的地方。</p>
      <ul class="codes"><li v-for="item in recoveryCodes" :key="item"><code>{{ item }}</code></li></ul>
      <div class="actions">
        <button class="ghost-button" type="button" @click="copyCodes">{{ copied ? '已复制' : '复制恢复码' }}</button>
        <button class="solid-button" type="button" @click="emit('done')">我已保存，继续</button>
      </div>
    </template>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.two-step { display: grid; gap: 14px; }
ol { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
.secret { padding: 12px 14px; border-radius: 10px; background: var(--surface-soft); font: 600 16px var(--font-code); letter-spacing: .06em; overflow-wrap: anywhere; }
details { font-size: 12px; color: var(--text-muted); }
.link { display: block; margin-top: 6px; overflow-wrap: anywhere; font-size: 11px; }
.confirm { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
label { display: grid; gap: 6px; font-size: 13px; color: var(--text-secondary); font-weight: 600; }
input { width: 160px; height: 40px; padding: 0 12px; border: 1px solid var(--input-border-color); border-radius: 9px; background: var(--surface); color: var(--text-primary); font: 600 16px var(--font-code); letter-spacing: .12em; }
.solid-button, .ghost-button { height: 40px; padding: 0 16px; border-radius: 9px; font: 600 13px var(--font-ui); cursor: pointer; }
.solid-button { border: 0; background: var(--accent); color: var(--text-on-solid); }
.ghost-button { border: 1px solid var(--line-strong); background: var(--surface); color: var(--text-primary); }
.solid-button:disabled { opacity: .5; cursor: default; }
.done { margin: 0; font-size: 13px; line-height: 1.6; }
.codes { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.codes code { display: block; padding: 7px 10px; border-radius: 7px; background: var(--surface-soft); font: 13px var(--font-code); text-align: center; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
</style>
