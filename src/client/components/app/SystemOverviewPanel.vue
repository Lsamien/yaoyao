<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { listUsers, type ManagedUser } from '@/api/admin'
import { getDuplexVoiceSettings, type DuplexVoiceSettings } from '@/api/agentManagement'
import { pairedDevices, type PairedDevicesResponse } from '@/api/pairing'
import { getPushSystemStatus, type PushSystemStatus } from '@/api/push'
import { systemUpdateStatus, type SystemUpdateStatus } from '@/api/systemUpdate'

type Destination = 'system-users' | 'system-connection' | 'system-push' | 'system-voice' | 'system-update'

const props = withDefaults(defineProps<{
  active?: boolean
  upstreamReady?: boolean
  upstreamError?: string
}>(), {
  active: true,
  upstreamReady: false,
  upstreamError: '',
})
const emit = defineEmits<{ navigate: [destination: Destination] }>()

const users = ref<ManagedUser[]>()
const push = ref<PushSystemStatus>()
const devices = ref<PairedDevicesResponse>()
const voice = ref<DuplexVoiceSettings>()
const update = ref<SystemUpdateStatus>()
const checking = ref(false)
const error = ref('')

const userStatus = computed(() => users.value
  ? `${users.value.filter(user => user.role === 'admin').length} 位管理员 · ${users.value.length} 位用户`
  : '尚未读取用户状态')
const pushStatus = computed(() => {
  if (!push.value) return '尚未读取推送状态'
  const apns = push.value.configured && push.value.healthy ? 'APNs 已启用' : 'APNs 未就绪'
  const fcm = push.value.providers?.fcm
  return `${apns} · ${fcm?.configured && fcm.healthy ? 'FCM 已启用' : 'FCM 未配置'}`
})
const voiceStatus = computed(() => voice.value ? `已配置 ${voice.value.voices.length} 个音色` : '尚未读取语音状态')
const updateStatus = computed(() => {
  if (!update.value) return '尚未读取版本状态'
  return `Web ${update.value.current.webVersion} · 可独立升级与回滚`
})

async function refresh() {
  checking.value = true
  error.value = ''
  const results = await Promise.allSettled([
    listUsers(),
    getPushSystemStatus(),
    pairedDevices(),
    getDuplexVoiceSettings(),
    // Publish local update status immediately, without waiting for 9119 panels.
    systemUpdateStatus().then(value => { update.value = value; return value }),
  ])
  if (results[0]?.status === 'fulfilled') users.value = results[0].value
  if (results[1]?.status === 'fulfilled') push.value = results[1].value
  if (results[2]?.status === 'fulfilled') devices.value = results[2].value
  if (results[3]?.status === 'fulfilled') voice.value = results[3].value
  if (results[4]?.status === 'fulfilled') update.value = results[4].value
  const failed = results.filter(result => result.status === 'rejected').length
  if (failed) error.value = failed === results.length ? '无法读取系统状态' : `${failed} 项状态暂时无法读取，可进入对应页面重试。`
  checking.value = false
}

watch(() => props.active, active => { if (active) void refresh() }, { immediate: true })
</script>

<template>
  <section class="system-overview-panel" aria-label="系统概览">
    <div class="overview-toolbar">
      <p>影响整个夭夭安装及所有机器人，仅管理员可见。</p>
      <button type="button" :disabled="checking" @click="refresh"><AppIcon name="refresh" :size="16" />{{ checking ? '检查中…' : '检查系统状态' }}</button>
    </div>
    <p v-if="error" class="overview-warning" role="status">{{ error }}</p>

    <div class="overview-list">
      <button type="button" @click="emit('navigate', 'system-users')">
        <AppIcon name="users" :size="22" />
        <span><strong>用户与权限</strong><small>{{ userStatus }}</small></span>
        <AppIcon class="chevron" name="chevron-left" :size="18" />
      </button>
      <button type="button" @click="emit('navigate', 'system-connection')">
        <AppIcon name="link" :size="22" />
        <span><strong>Hermes 连接</strong><small :class="{ success: upstreamReady }">{{ upstreamReady ? '9119 连接正常' : upstreamError || '尚未验证上游连接' }}</small></span>
        <AppIcon class="chevron" name="chevron-left" :size="18" />
      </button>
      <button type="button" @click="emit('navigate', 'system-push')">
        <AppIcon name="bell" :size="22" />
        <span><strong>消息推送</strong><small>{{ pushStatus }}</small></span>
        <AppIcon class="chevron" name="chevron-left" :size="18" />
      </button>
      <button type="button" @click="emit('navigate', 'system-voice')">
        <AppIcon name="audio" :size="22" />
        <span><strong>双流语音 <em>全局</em></strong><small>{{ voiceStatus }}</small></span>
        <AppIcon class="chevron" name="chevron-left" :size="18" />
      </button>
      <button type="button" @click="emit('navigate', 'system-update')">
        <AppIcon name="refresh" :size="22" />
        <span><strong>更新与回滚</strong><small>{{ updateStatus }} <b v-if="update?.latest && !update.updateAvailable">已是最新版本</b></small></span>
        <AppIcon class="chevron" name="chevron-left" :size="18" />
      </button>
    </div>

    <p class="ownership-note">15300 通过官方 API 管理 Hermes 9119；外部文件与进程不在此处控制。</p>
  </section>
</template>

<style scoped>
.system-overview-panel { display: grid; gap: 16px; }
.overview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.overview-toolbar p { margin: 0; color: var(--text-secondary); font-size: 14px; }
.overview-toolbar button { display: inline-flex; min-height: 40px; flex: 0 0 auto; align-items: center; gap: 7px; padding: 0 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-raised); color: var(--text-primary); cursor: pointer; font: 600 13px var(--font-ui); }
.overview-toolbar button:disabled { cursor: wait; opacity: .55; }
.overview-warning { margin: 0; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); font-size: 12px; }
.overview-list { border-top: 1px solid var(--line); }
.overview-list > button { display: grid; width: 100%; min-height: 76px; grid-template-columns: 28px minmax(0, 1fr) 22px; align-items: center; gap: 15px; padding: 12px 8px; border: 0; border-bottom: 1px solid var(--line); border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.overview-list > button:hover { background: var(--surface-soft); }
.overview-list > button:focus-visible { outline: 0; box-shadow: inset 0 0 0 2px color-mix(in srgb, #7c4dff 72%, var(--line-strong)); }
.overview-list > button > span { display: grid; min-width: 0; gap: 6px; }
.overview-list strong { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.overview-list small { color: var(--text-muted); font-size: 13px; }
.overview-list small.success,.overview-list small b { color: var(--success, #21845b); font-weight: 600; }
.overview-list em { padding: 2px 7px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--text-muted); font: normal 11px var(--font-ui); }
.chevron { transform: rotate(180deg); color: var(--text-muted); }
.ownership-note { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
@media (max-width: 700px) {
  .overview-toolbar { align-items: stretch; flex-direction: column; }
  .overview-toolbar button { justify-content: center; }
  .overview-list > button { min-height: 72px; padding-inline: 4px; }
}
</style>
