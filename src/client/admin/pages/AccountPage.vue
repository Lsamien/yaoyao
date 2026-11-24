<script setup lang="ts">
import { ref } from 'vue'
import PasswordForm from '../PasswordForm.vue'
import TwoStepSetup from '../TwoStepSetup.vue'
import { disableTwoStep, type ConsoleSession } from '../api'

const props = defineProps<{ session: ConsoleSession }>()
const emit = defineEmits<{ changed: [] }>()
const settingUp = ref(false)
const busy = ref(false)
const error = ref('')
const confirmOff = ref(false)

async function turnOff() {
  busy.value = true; error.value = ''
  try { await disableTwoStep(); confirmOff.value = false; emit('changed') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '关闭失败' }
  finally { busy.value = false }
}
const enabledLabel = () => props.session.twoStep?.enabledAt ? new Date(props.session.twoStep.enabledAt).toLocaleString('zh-CN') : ''
</script>

<template>
  <div class="stack">
    <section>
      <h2>修改密码</h2>
      <p class="hint">修改后，这个管理员账号在夭夭 Web、手机和电脑客户端上的登录都会退出。</p>
      <PasswordForm @done="emit('changed')" />
    </section>
    <section>
      <h2>二次验证</h2>
      <template v-if="session.twoStep?.enabled && !settingUp">
        <p class="status ok">已开启（{{ enabledLabel() }}）。剩余恢复码 {{ session.twoStep.recoveryCodesLeft }} 个。</p>
        <div class="actions">
          <button class="ghost" type="button" @click="settingUp = true">更换验证器并生成新恢复码</button>
          <template v-if="!session.twoStepRequired">
            <button v-if="!confirmOff" class="ghost danger" type="button" @click="confirmOff = true">关闭二次验证</button>
            <template v-else>
              <span class="hint">关闭后只用密码即可登录后台。</span>
              <button class="ghost danger" type="button" :disabled="busy" @click="turnOff">确认关闭</button>
              <button class="ghost" type="button" @click="confirmOff = false">取消</button>
            </template>
          </template>
          <span v-else class="hint">管理后台允许远程访问，二次验证不能关闭。</span>
        </div>
      </template>
      <template v-else-if="!settingUp">
        <p class="status">未开启。开启后，登录后台需要密码和验证器 App 上的 6 位验证码。</p>
        <div class="actions"><button class="solid" type="button" @click="settingUp = true">开启二次验证</button></div>
      </template>
      <TwoStepSetup v-else @done="settingUp = false; emit('changed')" />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 28px; max-width: 640px; }
section { display: grid; gap: 12px; }
h2 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 15px; }
.hint { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.status { margin: 0; font-size: 13px; }
.status.ok { color: var(--success); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.solid, .ghost { height: 36px; padding: 0 14px; border-radius: 9px; font: 600 13px var(--font-ui); cursor: pointer; }
.solid { border: 0; background: var(--accent); color: var(--text-on-solid); }
.ghost { border: 1px solid var(--line-strong); background: var(--surface); color: var(--text-primary); }
.ghost.danger { color: var(--danger); }
.error { margin: 0; color: var(--danger); font-size: 13px; }
</style>
