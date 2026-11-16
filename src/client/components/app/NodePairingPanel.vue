<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import QRCode from 'qrcode'
import AppIcon from '@/components/common/AppIcon.vue'
import { accountPairingStatus, createAccountPairing, type AccountPairingSession } from '@/api/accountPairing'

/** Phone login QR: the phone signs in to this server's account (Bot mode). */
const props = withDefaults(defineProps<{
  active?: boolean
  mode?: 'account'
  insecureTransport?: boolean
  userName?: string
}>(), {
  active: true,
  mode: 'account',
  insecureTransport: false,
  userName: '',
})

const accountPairing = ref<AccountPairingSession>()
const accountQrImage = ref('')
const accountPairingComplete = ref(false)
const busy = ref(false)
const error = ref('')
const now = ref(Date.now())
let accountTimer: number | undefined
let lifecycleToken = 0
let accountPolling = false

const accountSecondsRemaining = computed(() => accountPairing.value
  ? Math.max(0, Math.ceil((accountPairing.value.expiresAt - now.value) / 1_000))
  : 0)

function stopAccountPolling() {
  if (accountTimer !== undefined) window.clearInterval(accountTimer)
  accountTimer = undefined
  accountPolling = false
}

function resetTransientState() {
  lifecycleToken += 1
  stopAccountPolling()
  accountPairing.value = undefined
  accountQrImage.value = ''
  accountPairingComplete.value = false
  error.value = ''
  busy.value = false
}

function isCurrent(token: number): boolean {
  return token === lifecycleToken && props.active
}

async function pollAccountPairing(token = lifecycleToken) {
  if (accountPolling || !isCurrent(token)) return
  accountPolling = true
  now.value = Date.now()
  const current = accountPairing.value
  if (!current || accountSecondsRemaining.value <= 0) { stopAccountPolling(); return }
  try {
    const status = await accountPairingStatus(current.pairingId)
    if (!isCurrent(token) || accountPairing.value?.pairingId !== current.pairingId) return
    if (status.state === 'claimed') {
      accountPairingComplete.value = true
      stopAccountPolling()
    } else if (status.state === 'expired') stopAccountPolling()
  } catch { /* Keep a still-valid QR code during transient polling failures. */ }
  finally { accountPolling = false }
}

async function beginAccountPairing() {
  if (busy.value || !props.active) return
  const token = lifecycleToken
  busy.value = true
  error.value = ''
  accountPairingComplete.value = false
  stopAccountPolling()
  try {
    const created = await createAccountPairing()
    if (!isCurrent(token)) return
    accountPairing.value = created
    now.value = Date.now()
    const image = await QRCode.toDataURL(created.qrPayload, {
      width: 296, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#191918', light: '#ffffff' },
    })
    if (!isCurrent(token)) return
    accountQrImage.value = image
    accountTimer = window.setInterval(() => { void pollAccountPairing(token) }, 1_000)
  } catch (cause) {
    if (isCurrent(token)) error.value = cause instanceof Error ? cause.message : '无法创建手机登录二维码'
  } finally {
    if (isCurrent(token)) busy.value = false
  }
}

watch(() => props.active, active => {
  resetTransientState()
  if (active) void beginAccountPairing()
}, { immediate: true })

onBeforeUnmount(resetTransientState)
</script>

<template>
  <section class="pairing-panel" aria-label="手机登录">
    <p class="pairing-intro">手机扫描登录二维码后，会把这台 15300 保存为服务器账号，并以 Bot 模式使用。</p>
    <p v-if="insecureTransport" class="pairing-warning"><AppIcon name="alert" :size="16" />当前是局域网 HTTP，二维码免密配对仅适用于可信网络。正式使用请配置 HTTPS 或 Tailscale。</p>
    <p v-if="error" class="pairing-error" role="alert">{{ error }}</p>
    <div class="device-heading"><strong>扫码登录并添加服务器</strong><small>{{ userName }}</small></div>
    <section v-if="accountPairing" class="qr-card">
      <img v-if="accountQrImage" :src="accountQrImage" alt="手机扫码登录并添加服务器" />
      <strong>{{ accountPairingComplete ? '手机已添加此服务器' : '在 iOS 登录页选择扫码' }}</strong>
      <span v-if="accountPairingComplete">该二维码已经失效</span>
      <span v-else-if="accountSecondsRemaining">二维码将在 {{ accountSecondsRemaining }} 秒后失效</span>
      <span v-else>二维码已失效</span>
      <button v-if="accountPairingComplete || !accountSecondsRemaining" class="quiet-button" type="button" @click="beginAccountPairing">重新生成</button>
    </section>
    <p v-else-if="busy" class="device-empty">正在生成登录二维码…</p>
  </section>
</template>

<style scoped>
.pairing-panel { display: grid; gap: 18px; }
.pairing-intro { margin: 0; max-width: 650px; color: var(--text-secondary); font-size: 14px; line-height: 1.65; }
.pairing-warning,.pairing-error { margin: 0; padding: 12px 14px; border-radius: 10px; font-size: 13px; line-height: 1.55; }
.pairing-warning { display: flex; gap: 8px; background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); }
.pairing-error { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }
.device-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.device-heading strong { font-size: 16px; }
.device-heading small,.device-empty { color: var(--text-muted); font-size: 13px; }
.device-empty { margin: 0; }
.qr-card { display: grid; width: min(360px, 100%); justify-self: center; justify-items: center; gap: 9px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: #fff; color: #191918; }
.qr-card img { width: min(260px, 100%); aspect-ratio: 1; }
.qr-card strong { font-size: 14px; }
.qr-card span { color: #686865; font-size: 12px; }
.quiet-button,.quiet-button { border: 1px solid var(--line); background: var(--surface-raised); color: var(--text-secondary); }
button:disabled { cursor: not-allowed; opacity: .5; }
@media (max-width: 700px) {
  .qr-card { width: 100%; box-sizing: border-box; }
  }
</style>
