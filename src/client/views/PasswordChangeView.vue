<script setup lang="ts">
import { computed, ref } from 'vue'
import BrandMark from '@/components/common/BrandMark.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')
const canSubmit = computed(() => currentPassword.value && newPassword.value.length >= 8
  && newPassword.value === confirmation.value)

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    await auth.changeCredentials({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '修改密码失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="password-change">
    <section>
      <BrandMark :size="68" />
      <div><h1>先修改初始密码</h1><p>默认密码或管理员重置的临时密码不能继续用于工作区。</p></div>
      <form @submit.prevent="submit">
        <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label>
        <label><span>新密码</span><input v-model="newPassword" type="password" autocomplete="new-password" placeholder="至少 8 个字符" /></label>
        <label><span>确认新密码</span><input v-model="confirmation" type="password" autocomplete="new-password" /></label>
        <p v-if="newPassword && confirmation && newPassword !== confirmation" class="error">两次输入的新密码不一致</p>
        <p v-else-if="error" class="error">{{ error }}</p>
        <button class="solid-button" type="submit" :disabled="busy || !canSubmit">{{ busy ? '正在保存…' : '保存并进入夭夭' }}</button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.password-change { display: grid; min-height: 100%; place-items: center; padding: 24px; background: var(--canvas); }.password-change > section { width: min(380px, 100%); }.password-change :deep(.brand-mark) { display: flex; justify-content: center; }.password-change > section > div { margin: 28px 0 22px; text-align: center; }h1 { margin: 0 0 8px; font-size: 19px; }p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.6; }form { display: grid; gap: 13px; }label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 10px; }input { height: 43px; padding: 0 11px; border: 1px solid var(--line); border-radius: 11px; outline: none; background: var(--surface-raised); color: var(--text-primary); }input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.error { color: var(--danger); }.solid-button { min-height: 43px; margin-top: 3px; }
</style>
