<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { onApiUnauthorized } from '@/api/client'
import { loadSession, login, logout, type ConsoleSession } from './api'
import AdminShell from './AdminShell.vue'
import TwoStepSetup from './TwoStepSetup.vue'
import PasswordForm from './PasswordForm.vue'

const session = ref<ConsoleSession>()
const loading = ref(true)
const loadError = ref('')
const username = ref('')
const password = ref('')
const code = ref('')
const needsCode = ref(false)
const busy = ref(false)
const error = ref('')

async function refresh() {
  loadError.value = ''
  try { session.value = await loadSession() }
  catch (cause) { loadError.value = cause instanceof Error ? cause.message : '无法连接管理后台' }
  finally { loading.value = false }
}

async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    session.value = await login(username.value.trim(), password.value, needsCode.value ? code.value.trim() : undefined)
    password.value = ''; code.value = ''; needsCode.value = false
  } catch (cause) {
    const failure = cause as { code?: string; message?: string }
    if (failure.code === 'admin_two_step_code_required') { needsCode.value = true; error.value = '' }
    else error.value = failure.message || '登录失败'
  } finally { busy.value = false }
}

async function signOut() {
  try { await logout() } catch { /* The session may already be gone. */ }
  await refresh()
}

let stop: (() => void) | undefined
onMounted(() => { stop = onApiUnauthorized(() => { void refresh() }); void refresh() })
onBeforeUnmount(() => stop?.())
</script>

<template>
  <div class="console-root">
    <div v-if="loading" class="center"><p class="muted">正在连接管理后台…</p></div>
    <div v-else-if="loadError" class="center">
      <div class="card">
        <h1>无法连接管理后台</h1>
        <p class="error" role="alert">{{ loadError }}</p>
        <button class="solid-button" type="button" @click="refresh">重试</button>
      </div>
    </div>

    <div v-else-if="!session?.user" class="center login-ground">
      <form class="card" @submit.prevent="submit">
        <div class="brand"><span class="mark" aria-hidden="true"></span>夭夭管理后台</div>
        <h1>管理员登录</h1>
        <p class="muted">此后台只允许管理员账号登录。普通账号请使用夭夭 Web。</p>
        <p v-if="session?.setupRequired" class="notice">尚未创建管理员。请先在夭夭 Web 首次打开时创建管理员账号。</p>
        <label for="console-username">账号<input id="console-username" v-model="username" name="username" autocomplete="username" required :disabled="busy" /></label>
        <label for="console-password">密码<input id="console-password" v-model="password" name="password" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <label v-if="needsCode" for="console-code">验证码<input id="console-code" v-model="code" name="one-time-code" inputmode="numeric" autocomplete="one-time-code" placeholder="验证器 App 上的 6 位数字，或恢复码" required :disabled="busy" /></label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="solid-button" :disabled="busy || !username.trim() || !password">{{ busy ? '正在登录…' : '登录' }}</button>
        <p class="hint">连续失败 5 次将锁定 15 分钟，所有登录尝试都会记入审计日志。使用 App 内置服务且从未设置过密码时，请先在夭夭「我的设置 → 登录与安全」中设置密码。</p>
      </form>
    </div>

    <div v-else-if="session.stage === 'enroll'" class="center">
      <div class="card wide">
        <h1>设置二次验证</h1>
        <p class="muted">管理后台允许从其他电脑访问，登录必须使用验证器 App 的验证码。设置完成后才能使用后台。</p>
        <TwoStepSetup @done="refresh" />
        <button class="text-button" type="button" @click="signOut">退出登录</button>
      </div>
    </div>

    <div v-else-if="session.user.mustChangePassword" class="center">
      <div class="card">
        <h1>修改初始密码</h1>
        <p class="muted">首次使用管理后台前，请设置新的管理员密码。</p>
        <PasswordForm @done="refresh" />
        <button class="text-button" type="button" @click="signOut">退出登录</button>
      </div>
    </div>

    <AdminShell v-else :session="session" @refresh="refresh" @logout="signOut" />
  </div>
</template>

<style scoped>
.console-root { height: 100%; overflow: auto; background: var(--canvas); color: var(--text-primary); }
.center { min-height: 100%; display: grid; place-items: center; padding: 32px max(16px, env(safe-area-inset-left, 0px)); }
.login-ground { background: radial-gradient(circle at 25% 15%, var(--surface-soft), var(--canvas) 60%); }
.card { width: min(400px, 100%); display: grid; gap: 14px; padding: 28px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
.card.wide { width: min(520px, 100%); }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; }
.mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #4cc5a6, #1f8f76); }
h1 { margin: 0; font-size: 21px; }
label { display: grid; gap: 6px; font-size: 13px; color: var(--text-secondary); font-weight: 600; }
input { height: 42px; padding: 0 12px; border: 1px solid var(--input-border-color); border-radius: 10px; background: var(--surface); color: var(--text-primary); font: 14px var(--font-ui); }
input:focus { outline: 0; border-color: var(--input-border-focus-color); box-shadow: 0 0 0 3px var(--focus-ring); }
.solid-button { height: 42px; border: 0; border-radius: 10px; background: var(--accent); color: var(--text-on-solid); font: 600 14px var(--font-ui); cursor: pointer; }
.solid-button:disabled { opacity: .5; cursor: default; }
.text-button { justify-self: center; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
.muted, .hint { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.hint { font-size: 12px; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.notice { margin: 0; padding: 10px 12px; border-radius: 9px; background: var(--surface-soft); font-size: 13px; }
</style>
