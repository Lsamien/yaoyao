<script setup lang="ts">
import ServerIdentityPanel from './ServerIdentityPanel.vue'
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import AccountInitialAvatar from '@/components/common/AccountInitialAvatar.vue'
import { useAuthStore } from '@/stores/auth'

const props = withDefaults(defineProps<{
  active?: boolean
  open?: boolean
  formId?: string
  showActions?: boolean
}>(), {
  active: true,
  open: undefined,
  formId: undefined,
  showActions: true,
})

const emit = defineEmits<{
  saved: []
  logout: []
  'dirty-change': [dirty: boolean]
  'can-save-change': [canSave: boolean]
}>()

const auth = useAuthStore()
const initialUsername = ref('')
const username = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const avatarInput = ref<HTMLInputElement>()
const avatarBusy = ref(false)

const isAdmin = computed(() => auth.user?.role === 'admin')
const isActive = computed(() => props.open ?? props.active)
const passwordsMatch = computed(() => Boolean(confirmation.value) && newPassword.value === confirmation.value)
const confirmationState = computed<'empty' | 'match' | 'mismatch'>(() => {
  if (!confirmation.value) return 'empty'
  return passwordsMatch.value ? 'match' : 'mismatch'
})
const serverNameDirty = ref(false)
const dirty = computed(() => (
  serverNameDirty.value ||
  (isAdmin.value && username.value.trim() !== initialUsername.value)
  || Boolean(currentPassword.value || newPassword.value || confirmation.value)
))
const canSave = computed(() => (
  !busy.value
  && Boolean(currentPassword.value)
  && newPassword.value.length >= 8
  && passwordsMatch.value
  && (!isAdmin.value || Boolean(username.value.trim()))
))

function reset() {
  const currentUsername = auth.user?.username || ''
  initialUsername.value = currentUsername
  username.value = currentUsername
  currentPassword.value = ''
  newPassword.value = ''
  confirmation.value = ''
  error.value = ''
  notice.value = ''
  emit('dirty-change', false)
}

async function save() {
  const normalizedUsername = username.value.trim()
  if (isAdmin.value && !normalizedUsername) { error.value = '管理员用户名不能为空'; return }
  if (!currentPassword.value) { error.value = '请输入当前密码'; return }
  if (newPassword.value.length < 8) { error.value = '新密码至少需要 8 个字符'; return }
  if (!passwordsMatch.value) { error.value = '两次输入的新密码不一致'; return }

  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await auth.changeCredentials({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      ...(isAdmin.value ? { username: normalizedUsername } : {}),
    })
    const nextUsername = isAdmin.value ? normalizedUsername : (auth.user?.username || initialUsername.value)
    initialUsername.value = nextUsername
    username.value = nextUsername
    currentPassword.value = ''
    newPassword.value = ''
    confirmation.value = ''
    notice.value = '账号与密码已更新'
    emit('dirty-change', false)
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '修改账号失败'
  } finally {
    busy.value = false
  }
}

function imageUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

function resizeImage(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const ratio = Math.min(1, 256 / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('当前浏览器不支持图片处理'))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('请选择有效的 PNG、JPEG 或 WebP 图片'))
    image.src = source
  })
}

async function chooseAvatar(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  avatarBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB')
    await auth.updateAccountAvatar(await resizeImage(await imageUrl(file)))
    notice.value = '账号头像已更新，iOS 下次打开 Bot 模式时会同步显示'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存头像失败'
  } finally {
    avatarBusy.value = false
    input.value = ''
  }
}

async function resetAvatar() {
  avatarBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    await auth.updateAccountAvatar(null)
    notice.value = '已恢复首字母头像'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '恢复头像失败'
  } finally {
    avatarBusy.value = false
  }
}

watch(isActive, active => {
  if (active) reset()
}, { immediate: true })

watch(dirty, value => emit('dirty-change', value), { flush: 'sync' })
watch(canSave, value => emit('can-save-change', value), { immediate: true, flush: 'sync' })
</script>

<template>
  <section class="account-security-panel" aria-label="登录与安全">
    <header class="panel-heading">
      <div>
        <p class="panel-eyebrow">当前账号</p>
        <h2>登录与安全</h2>
        <p class="panel-description">管理此 15300 Web 账号的登录凭据。修改成功后，请使用新凭据登录。</p>
      </div>
      <span class="account-badge">{{ auth.user?.username || '当前账号' }}</span>
    </header>

    <ServerIdentityPanel v-if="auth.serverIdentity" @dirty-change="serverNameDirty = $event" />
    <section class="account-avatar-card" aria-label="账号头像">
      <AccountInitialAvatar :name="auth.user?.username || '当前账号'" :image-url="auth.user?.avatar" :size="64" />
      <div><strong>账号头像</strong><small>默认显示用户名首字母。头像只在 Web 修改，iOS 会同步显示。</small></div>
      <button type="button" :disabled="busy || avatarBusy" @click="avatarInput?.click()">{{ avatarBusy ? '正在保存…' : '更换头像' }}</button>
      <button v-if="auth.user?.avatar" type="button" :disabled="busy || avatarBusy" @click="resetAvatar">使用首字母</button>
      <input ref="avatarInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="chooseAvatar" />
    </section>

    <form :id="formId" class="security-form" @submit.prevent="save">
      <h3 v-if="isAdmin" class="security-section-title">账号信息</h3>
      <label v-if="isAdmin" class="field">
        <span>管理员用户名</span>
        <input v-model="username" name="username" autocomplete="username" :disabled="busy" />
        <small>仅修改当前 15300 Web 管理账号，不会更改 9119 服务账号。</small>
      </label>

      <h3 class="security-section-title security-section-title--password">修改密码</h3>
      <label class="field">
        <span>当前密码</span>
        <input v-model="currentPassword" name="current-password" type="password" autocomplete="current-password" :disabled="busy" />
        <small>用于确认是你本人；密码不会被回显或保存在浏览器中。</small>
      </label>

      <div class="password-grid">
        <label class="field">
          <span>新密码</span>
          <input v-model="newPassword" name="new-password" type="password" autocomplete="new-password" :disabled="busy" />
          <small>至少 8 个字符，建议混合使用字母、数字与符号。</small>
        </label>

        <label class="field">
          <span>确认新密码</span>
          <input v-model="confirmation" name="password-confirmation" type="password" autocomplete="new-password" :disabled="busy" />
          <small
            class="match-status"
            :class="`match-status--${confirmationState}`"
            :role="confirmationState === 'mismatch' ? 'alert' : 'status'"
            aria-live="polite"
          >
            {{ confirmationState === 'match' ? '两次输入一致' : confirmationState === 'mismatch' ? '两次输入不一致' : '再次输入新密码以确认' }}
          </small>
        </label>
      </div>

      <p v-if="error" class="form-message form-message--error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="form-message form-message--success" role="status">{{ notice }}</p>

      <footer v-if="showActions" class="form-actions">
        <span>保存后不会修改 Agent、Provider 或系统服务配置。</span>
        <button class="solid-button" type="submit" :disabled="!canSave">{{ busy ? '正在保存…' : '保存修改' }}</button>
      </footer>
    </form>

    <section class="logout-card" aria-label="退出登录">
      <div>
        <strong>退出当前账号</strong>
        <p>只退出这个浏览器中的当前 Web 会话，不会停止服务，也不会影响其他设备。</p>
      </div>
      <button class="logout-button" type="button" :disabled="busy" @click="emit('logout')">
        <AppIcon name="logout" :size="15" />退出当前账号
      </button>
    </section>
  </section>
</template>

<style scoped>
.account-security-panel{display:grid;max-width:620px;gap:28px;color:var(--text-primary)}
.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.panel-eyebrow{margin:0 0 5px;color:var(--text-muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.panel-heading h2{margin:0;font-size:22px;letter-spacing:-.035em}
.panel-description{max-width:520px;margin:8px 0 0;color:var(--text-secondary);font-size:13px;line-height:1.65}
.account-badge{max-width:180px;padding:6px 10px;overflow:hidden;border:1px solid var(--line);border-radius:999px;background:var(--surface-soft);color:var(--text-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.account-avatar-card{display:flex;align-items:center;gap:12px}.account-avatar-card>div{display:grid;min-width:0;flex:1;gap:4px}.account-avatar-card strong{font-size:14px}.account-avatar-card small{color:var(--text-muted);font-size:12px;line-height:1.5}.account-avatar-card button{min-height:36px;padding:0 11px;border:1px solid var(--line);border-radius:9px;background:var(--surface-raised);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600}.account-avatar-card button:disabled{cursor:wait;opacity:.5}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.security-form{display:grid;gap:20px}
.security-section-title{margin:0;font-size:16px}.security-section-title--password{margin-top:8px;padding-top:24px;border-top:1px solid var(--line)}
.field{display:grid;gap:8px;color:var(--text-secondary);font-size:14px;font-weight:650}
.field input{width:100%;height:46px;box-sizing:border-box;padding:0 13px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:14px var(--font-ui);font-weight:400}
.field input:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}
.field input:disabled{cursor:wait;opacity:.6}
.field small{min-height:18px;color:var(--text-muted);font-size:12px;font-weight:400;line-height:1.5}
.password-grid{display:grid;grid-template-columns:1fr;gap:20px}
.match-status--match{color:var(--success,#21845b)!important}
.match-status--mismatch{color:var(--danger)!important}
.form-message{margin:0;padding:11px 12px;border-radius:8px;font-size:13px}
.form-message--error{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}
.form-message--success{background:color-mix(in srgb,var(--success,#21845b) 9%,transparent);color:var(--success,#21845b)}
.form-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:2px}
.form-actions>span{color:var(--text-muted);font-size:12px;line-height:1.5}
.solid-button{display:inline-flex;min-width:120px;min-height:40px;align-items:center;justify-content:center;border:0;border-radius:9px;background:var(--accent);color:var(--text-on-solid);cursor:pointer;font-size:13px;font-weight:650}
.solid-button:disabled{cursor:not-allowed;opacity:.45}
.logout-card{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 0;border-top:1px solid var(--line)}
.logout-card strong{font-size:14px}
.logout-card p{max-width:470px;margin:5px 0 0;color:var(--text-muted);font-size:12px;line-height:1.55}
.logout-button{display:inline-flex;min-height:40px;flex:0 0 auto;align-items:center;justify-content:center;gap:7px;padding:0 12px;border:1px solid color-mix(in srgb,var(--danger) 35%,var(--line));border-radius:9px;background:var(--surface-raised);color:var(--danger);cursor:pointer;font-size:13px;font-weight:650}
.logout-button:disabled{cursor:wait;opacity:.5}
@media(max-width:620px){.panel-heading{align-items:flex-start;flex-direction:column;gap:10px}.account-avatar-card{align-items:flex-start;flex-wrap:wrap}.account-avatar-card>div{min-width:calc(100% - 84px)}.form-actions,.logout-card{align-items:stretch;flex-direction:column}.form-actions .solid-button,.logout-button{width:100%}}
</style>
