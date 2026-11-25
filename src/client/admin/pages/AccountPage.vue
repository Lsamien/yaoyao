<script setup lang="ts">
import { ref, watch } from 'vue'
import PasswordForm from '../PasswordForm.vue'
import { changeUsername, type ConsoleSession } from '../api'

const props = defineProps<{ session: ConsoleSession }>()
const emit = defineEmits<{ changed: [] }>()
const username = ref(props.session.user?.username ?? '')
const password = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
watch(() => props.session.user?.username, value => { if (value && !busy.value) username.value = value })

async function rename() {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await changeUsername(username.value.trim(), password.value)
    password.value = ''
    notice.value = '用户名已修改，下次登录请使用新用户名。'
    emit('changed')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '修改失败' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="stack">
    <section>
      <h2>用户名</h2>
      <form class="form" @submit.prevent="rename">
        <label for="console-username-new">新用户名<input id="console-username-new" v-model="username" autocomplete="username" maxlength="100" required :disabled="busy" /></label>
        <label for="console-username-password">当前密码<input id="console-username-password" v-model="password" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
        <button class="solid-button" :disabled="busy || !password || !username.trim() || username.trim() === session.user?.username">{{ busy ? '正在保存…' : '修改用户名' }}</button>
      </form>
    </section>
    <section>
      <h2>修改密码</h2>
      <p class="hint">修改后，这个管理员账号在夭夭 Web、手机和电脑客户端上的登录都会退出。</p>
      <PasswordForm @done="emit('changed')" />
    </section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 28px; max-width: 640px; }
section { display: grid; gap: 12px; }
h2 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 15px; }
.hint { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.form { display: grid; gap: 12px; max-width: 380px; }
label { display: grid; gap: 6px; font-size: 13px; color: var(--text-secondary); font-weight: 600; }
input { height: 40px; padding: 0 12px; border: 1px solid var(--input-border-color); border-radius: 9px; background: var(--surface); color: var(--text-primary); font: 14px var(--font-ui); }
input:focus { outline: 0; border-color: var(--input-border-focus-color); box-shadow: 0 0 0 3px var(--focus-ring); }
.solid-button { height: 40px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); cursor: pointer; }
.solid-button:disabled { opacity: .5; cursor: default; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.notice { margin: 0; color: var(--success); font-size: 13px; }
</style>
