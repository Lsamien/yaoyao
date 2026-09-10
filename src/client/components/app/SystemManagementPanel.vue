<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import RunnerSettingsPanel from './RunnerSettingsPanel.vue'
import {
  createUser,
  deleteUser,
  getAllowedHostsSettings,
  getUpstreamConnectionStatus,
  listUsers,
  saveAllowedHostsSettings,
  setUpstreamCredentials,
  updateUser,
  type AllowedHostsSettings,
  type ManagedUser,
  type UpstreamConnectionStatus,
} from '@/api/admin'
import {
  getPushSystemStatus,
  saveFCMPushSystemConfig,
  savePushSystemConfig,
  type APNsEnvironment,
  type PushSystemStatus,
} from '@/api/push'

type SystemManagementSection = 'users' | 'connection' | 'push'

const props = withDefaults(defineProps<{
  profiles?: Profile[]
  section: SystemManagementSection
  active?: boolean
  upstreamReady?: boolean
  upstreamError?: string
}>(), {
  active: true,
  profiles: () => [],
  upstreamReady: false,
  upstreamError: '',
})

const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

const runnerSettingsOpen = ref(false)
const assignedProfiles = ref<string[]>([])
const userAssignments = ref<Record<string, string[]>>({})
const users = ref<ManagedUser[]>([])
const username = ref('')
const password = ref('')
const upstreamUsername = ref('')
const upstreamPassword = ref('')
const connectionBaseline = ref({ username: '', password: '' })
const connectionStatus = ref<UpstreamConnectionStatus>()
const allowedHostsSettings = ref<AllowedHostsSettings>()
const allowedHostsText = ref('')
const allowedHostsBaseline = ref('')
const allowedHostsBusy = ref(false)
const allowedHostsError = ref('')
const allowedHostsNotice = ref('')
const busy = ref(false)
const error = ref('')
const pushStatus = ref<PushSystemStatus>()
const pushStatusLoadError = ref('')
const pushBusy = ref(false)
const pushError = ref('')
const pushNotice = ref('')
const pushKeyFile = ref('')
const pushKeyId = ref('')
const pushTeamId = ref('')
const pushTopic = ref('cn.samien.yaoyao.hermes')
const pushEnvironments = ref<APNsEnvironment[]>(['development', 'production'])
const fcmServiceAccountFile = ref('')
const fcmProjectId = ref('')
const fcmPackageName = ref('cn.samien.yaoyao.hermes')
const fcmBusy = ref(false)
const fcmError = ref('')
const fcmNotice = ref('')
const currentAccessHost = window.location.hostname || 'localhost'
const effectiveUpstreamReady = computed(() => connectionStatus.value?.ready ?? props.upstreamReady)
const effectiveUpstreamError = computed(() => connectionStatus.value?.error || props.upstreamError)
const passwordAuthentication = computed(() => !['loopback-token', 'loopback-direct'].includes(connectionStatus.value?.authMode ?? 'unknown'))
const authModeLabel = computed(() => {
  if (connectionStatus.value?.authMode === 'loopback-token') return '本机 Session Token（自动）'
  if (connectionStatus.value?.authMode === 'loopback-direct') return '本机直连（兼容模式）'
  if (connectionStatus.value?.authMode === 'password') return '用户名和密码'
  return '等待检测'
})
const verifiedAtLabel = computed(() => {
  const value = connectionStatus.value?.lastVerifiedAt
  return value === undefined ? '尚未成功验证' : new Date(value).toLocaleString()
})

interface APNsFormSnapshot {
  keyFile: string
  keyId: string
  teamId: string
  topic: string
  environments: string
}

interface FCMFormSnapshot {
  serviceAccountFile: string
  projectId: string
  packageName: string
}

const apnsBaseline = ref<APNsFormSnapshot>()
const fcmBaseline = ref<FCMFormSnapshot>()
const pushManagedByEnvironment = computed(() => pushStatus.value?.source === 'environment')
const fcmStatus = computed(() => pushStatus.value?.providers?.fcm)
const fcmManagedByEnvironment = computed(() => fcmStatus.value?.source === 'environment')
const fcmCanSave = computed(() => Boolean(
  fcmStatus.value?.managementAvailable && fcmStatus.value.editable && !fcmBusy.value && !pushBusy.value,
))
const fcmStatusText = computed(() => {
  if (!fcmStatus.value) return '当前版本未提供 Android 推送状态'
  if (!fcmStatus.value.configured && fcmStatus.value.lastError) return `FCM 配置无效：${fcmStatus.value.lastError}`
  if (!fcmStatus.value.configured) return '尚未配置 FCM 服务账号文件'
  if (fcmStatus.value.healthy) return 'FCM 推送服务正常'
  return fcmStatus.value.lastError || 'FCM 推送服务异常'
})
const pushCanSave = computed(() => Boolean(
  pushStatus.value?.managementAvailable
    && pushStatus.value.editable
    && !pushBusy.value
    && !fcmBusy.value,
))
const pushStatusText = computed(() => {
  if (!pushStatus.value) return pushStatusLoadError.value || '当前版本未提供推送状态'
  if (!pushStatus.value.configured && pushStatus.value.lastError) return `APNs 配置无效：${pushStatus.value.lastError}`
  if (!pushStatus.value.configured) return '尚未配置 APNs 密钥文件'
  if (pushStatus.value.healthy) return 'APNs 推送服务正常'
  return pushStatus.value.lastError || 'APNs 推送服务异常'
})

function apnsSnapshot(): APNsFormSnapshot {
  return {
    keyFile: pushKeyFile.value,
    keyId: pushKeyId.value,
    teamId: pushTeamId.value,
    topic: pushTopic.value,
    environments: [...pushEnvironments.value].sort().join(','),
  }
}

function fcmSnapshot(): FCMFormSnapshot {
  return {
    serviceAccountFile: fcmServiceAccountFile.value,
    projectId: fcmProjectId.value,
    packageName: fcmPackageName.value,
  }
}

const dirty = computed(() => {
  if (props.section === 'users') return Boolean(username.value.trim() || password.value)
  if (props.section === 'connection') {
    return upstreamUsername.value !== connectionBaseline.value.username
      || upstreamPassword.value !== connectionBaseline.value.password
      || allowedHostsText.value !== allowedHostsBaseline.value
  }
  if (props.section !== 'push') return false
  const apnsDirty = Boolean(apnsBaseline.value) && Object.keys(apnsSnapshot()).some(key => apnsSnapshot()[key as keyof APNsFormSnapshot] !== apnsBaseline.value?.[key as keyof APNsFormSnapshot])
  const fcmDirty = Boolean(fcmBaseline.value) && Object.keys(fcmSnapshot()).some(key => fcmSnapshot()[key as keyof FCMFormSnapshot] !== fcmBaseline.value?.[key as keyof FCMFormSnapshot])
  return apnsDirty || fcmDirty
})

watch(dirty, value => emit('dirty-change', value), { immediate: true })

function hydrateAPNsForm(status: PushSystemStatus) {
  pushKeyFile.value = status.keyFile ?? ''
  pushKeyId.value = status.keyId ?? ''
  pushTeamId.value = status.teamId ?? ''
  pushTopic.value = status.topic || 'cn.samien.yaoyao.hermes'
  pushEnvironments.value = status.environments.length
    ? [...status.environments]
    : ['development', 'production']
  apnsBaseline.value = apnsSnapshot()
}

function hydrateFCMForm(status: PushSystemStatus) {
  const fcm = status.providers?.fcm
  fcmServiceAccountFile.value = fcm?.serviceAccountFile ?? ''
  fcmProjectId.value = fcm?.projectId ?? ''
  fcmPackageName.value = fcm?.packageName || 'cn.samien.yaoyao.hermes'
  fcmBaseline.value = fcmSnapshot()
}

function hydratePushForm(status: PushSystemStatus) {
  hydrateAPNsForm(status)
  hydrateFCMForm(status)
}

async function refresh() {
  error.value = ''
  if (props.section === 'users') {
    users.value = await listUsers()
    userAssignments.value = Object.fromEntries(users.value.map(user => [user.id, [...(user.assignedProfiles ?? [])]]))
    return
  }
  if (props.section === 'connection') {
    const [settings, status] = await Promise.all([
      getAllowedHostsSettings(),
      getUpstreamConnectionStatus(),
    ])
    allowedHostsSettings.value = settings
    connectionStatus.value = status
    allowedHostsText.value = settings.editableHosts.join('\n')
    allowedHostsBaseline.value = allowedHostsText.value
    return
  }
  if (props.section !== 'push') return

  pushStatusLoadError.value = ''
  const next = await getPushSystemStatus().catch(cause => {
    if ((cause as { status?: unknown })?.status !== 404) {
      pushStatusLoadError.value = `无法读取 APNs 状态：${cause instanceof Error ? cause.message : '请求失败'}`
    }
    return undefined
  })
  pushStatus.value = next
  if (next) hydratePushForm(next)
  else {
    apnsBaseline.value = undefined
    fcmBaseline.value = undefined
  }
}

defineExpose({ refresh })

async function run(action: () => Promise<void>, refreshAfter = true) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    if (refreshAfter) await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    busy.value = false
  }
}

function add() {
  void run(async () => {
    await createUser(username.value.trim(), password.value, assignedProfiles.value)
    assignedProfiles.value = []
    username.value = ''
    password.value = ''
  })
}

function saveAssignments(user: ManagedUser) {
  void run(async () => { await updateUser(user.id, { assignedProfiles: userAssignments.value[user.id] ?? [] }) })
}

function toggle(user: ManagedUser) {
  void run(async () => { await updateUser(user.id, { enabled: !user.enabled }) })
}

function reset(user: ManagedUser) {
  const value = window.prompt(`为“${user.username}”设置临时密码（至少 8 个字符）`)
  if (value) void run(async () => { await updateUser(user.id, { password: value }) })
}

function remove(user: ManagedUser) {
  if (window.confirm(`删除用户“${user.username}”？`)) {
    void run(async () => { await deleteUser(user.id) })
  }
}

async function saveUpstream() {
  if (busy.value) return
  const submittedUsername = upstreamUsername.value.trim()
  const submittedPassword = upstreamPassword.value
  await run(async () => {
    await setUpstreamCredentials(submittedUsername, submittedPassword)
    upstreamUsername.value = submittedUsername
    upstreamPassword.value = ''
    connectionBaseline.value = { username: submittedUsername, password: '' }
  })
}

function parsedAllowedHosts(): string[] {
  return allowedHostsText.value
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean)
}

async function saveAllowedHosts() {
  if (allowedHostsBusy.value) return
  allowedHostsBusy.value = true
  allowedHostsError.value = ''
  allowedHostsNotice.value = ''
  try {
    const settings = await saveAllowedHostsSettings(parsedAllowedHosts())
    allowedHostsSettings.value = settings
    allowedHostsText.value = settings.editableHosts.join('\n')
    allowedHostsBaseline.value = allowedHostsText.value
    allowedHostsNotice.value = '允许的访问地址已保存并立即生效'
  } catch (cause) {
    allowedHostsError.value = cause instanceof Error ? cause.message : '无法保存允许的访问地址'
  } finally {
    allowedHostsBusy.value = false
  }
}

async function savePush() {
  if (!pushStatus.value?.editable || pushManagedByEnvironment.value || pushBusy.value || fcmBusy.value) return
  const keyFile = pushKeyFile.value.trim()
  const keyId = pushKeyId.value.trim()
  const teamId = pushTeamId.value.trim()
  const topic = pushTopic.value.trim()
  const environments = (['development', 'production'] as const)
    .filter(environment => pushEnvironments.value.includes(environment))
  pushError.value = ''
  pushNotice.value = ''
  if (!keyFile.startsWith('/')) {
    pushError.value = '请输入 15300 所在机器上的 .p8 文件绝对路径'
    return
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(keyId)) {
    pushError.value = 'Key ID 仅支持 1–128 位字母或数字'
    return
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(teamId)) {
    pushError.value = 'Team ID 仅支持 1–128 位字母或数字'
    return
  }
  if (topic.length > 255 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(topic)) {
    pushError.value = 'Topic 必须是有效的 App Bundle ID'
    return
  }
  if (!environments.length) {
    pushError.value = '至少选择 Sandbox 或 Production'
    return
  }
  pushBusy.value = true
  try {
    const next = await savePushSystemConfig({ keyFile, keyId, teamId, topic, environments })
    pushStatus.value = next
    hydrateAPNsForm(next)
    const environmentText = environments.length === 2
      ? 'Sandbox 与 Production'
      : environments[0] === 'development' ? 'Sandbox' : 'Production'
    pushNotice.value = `${environmentText} 验证通过，APNs 已启用`
  } catch (cause) {
    pushError.value = cause instanceof Error ? cause.message : '无法验证并启用 APNs'
  } finally {
    pushBusy.value = false
  }
}

async function saveFCM() {
  if (!fcmStatus.value?.editable || fcmManagedByEnvironment.value || fcmBusy.value || pushBusy.value) return
  const serviceAccountFile = fcmServiceAccountFile.value.trim()
  const projectId = fcmProjectId.value.trim()
  const packageName = fcmPackageName.value.trim()
  fcmError.value = ''
  fcmNotice.value = ''
  if (!serviceAccountFile.startsWith('/')) {
    fcmError.value = '请输入 15300 所在机器上的服务账号 JSON 文件绝对路径'
    return
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    fcmError.value = '请输入有效的 Firebase Project ID'
    return
  }
  if (packageName !== 'cn.samien.yaoyao.hermes') {
    fcmError.value = 'Android 包名必须是 cn.samien.yaoyao.hermes'
    return
  }
  fcmBusy.value = true
  try {
    const next = await saveFCMPushSystemConfig({ serviceAccountFile, projectId, packageName })
    pushStatus.value = next
    hydrateFCMForm(next)
    fcmNotice.value = 'Firebase 权限与项目验证通过，FCM 已启用'
  } catch (cause) {
    fcmError.value = cause instanceof Error ? cause.message : '无法验证并启用 FCM'
  } finally {
    fcmBusy.value = false
  }
}

watch(() => [props.active, props.section] as const, ([active, section]) => {
  if (!active) return
  if (section === 'push') {
    pushError.value = ''
    pushNotice.value = ''
    fcmError.value = ''
    fcmNotice.value = ''
  }
  if (section === 'connection') {
    allowedHostsError.value = ''
    allowedHostsNotice.value = ''
  }
  void refresh().catch(cause => {
    error.value = cause instanceof Error ? cause.message : '读取系统设置失败'
  })
}, { immediate: true })
</script>

<template>
  <section class="system-management-panel" :data-section="section">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="section === 'users'" class="block">
      <h3>用户</h3>
      <div v-for="user in users" :key="user.id" class="user">
        <span>
          <b>{{ user.username }}</b>
          <small>{{ user.role === 'admin' ? '管理员' : user.enabled ? (user.mustChangePassword ? '等待修改临时密码' : '普通用户') : '已禁用' }}</small>
        </span>
        <template v-if="user.role !== 'admin'">
          <label class="user-assignment">基础机器人
            <select v-model="userAssignments[user.id]" multiple :disabled="busy" :aria-label="`分配给 ${user.username} 的基础机器人`">
              <option v-for="profile in profiles" :key="profile.name" :value="profile.name">{{ profile.agentName || profile.displayName || profile.name }}</option>
            </select>
          </label>
          <button type="button" :disabled="busy" @click="saveAssignments(user)">保存分配</button>
          <button type="button" :aria-label="`为用户 ${user.username} 重置密码`" :disabled="busy" @click="reset(user)">重置密码</button>
          <button type="button" :aria-label="`${user.enabled ? '禁用' : '启用'}用户 ${user.username}`" :disabled="busy" @click="toggle(user)">{{ user.enabled ? '禁用' : '启用' }}</button>
          <button class="danger" type="button" :aria-label="`删除用户 ${user.username}`" :disabled="busy" @click="remove(user)">删除</button>
        </template>
      </div>
      <form class="user-create-form" aria-label="创建用户" @submit.prevent="add">
        <label><span>新用户名</span><input v-model="username" name="managed-username" autocomplete="off" :disabled="busy" /></label>
        <label><span>临时密码</span><input v-model="password" name="managed-temporary-password" type="password" autocomplete="new-password" :disabled="busy" /><small>至少 8 位</small></label>
        <label class="create-assignment"><span>分配基础机器人</span><select v-model="assignedProfiles" multiple :disabled="busy" aria-label="新子账号的基础机器人"><option v-for="profile in profiles" :key="profile.name" :value="profile.name">{{ profile.agentName || profile.displayName || profile.name }}</option></select><small>子账号仅可使用 Bot 模式，基于分配的机器人创建自己的机器人；未分配时不可创建。保存权限后需重新登录。</small></label>
        <button class="solid-button" :disabled="busy || !username.trim() || password.length < 8">创建用户</button>
      </form>
    </div>

    <div v-else-if="section === 'connection'" class="block">
      <h3>Hermes 连接</h3>
      <p :class="{ ok: effectiveUpstreamReady }">{{ effectiveUpstreamReady ? '9119 连接正常' : effectiveUpstreamError || '尚未验证上游连接' }}</p>
      <div class="connection-summary" aria-label="Hermes 连接状态">
        <span><small>9119 地址</small><b>{{ connectionStatus?.endpoint || '等待检测' }}</b></span>
        <span><small>认证模式</small><b>{{ authModeLabel }}</b></span>
        <span><small>15300 网络范围</small><b>{{ connectionStatus?.webNetworkScope === 'local' ? '仅本机' : '局域网可访问' }}</b></span>
        <span><small>9119 网络范围</small><b>{{ connectionStatus?.networkScope === 'network' ? '网络可访问' : '仅本机' }}</b></span>
        <span class="wide"><small>最近验证</small><b>{{ verifiedAtLabel }}</b></span>
      </div>
      <p v-if="connectionStatus?.authMode === 'loopback-token'" class="connection-mode-note">9119 使用本机临时 Token，15300 会自动读取并在 9119 重启后刷新；Token 不会在设置中显示。</p>
      <p v-else-if="connectionStatus?.authMode === 'loopback-direct'" class="connection-mode-note">当前 9119 允许本机直接访问，不需要账号或 Token；该兼容模式只允许回环地址使用。</p>
      <p class="network-description">直连本机 127.0.0.1 或 ::1 且 Hermes 启用本机授权时，自动使用临时会话令牌，无需配置用户名和密码。远程上游或已启用账号鉴权的 9119 仍需服务账号；15300 登录保护保持不变，不会自动修改 Hermes 账号配置。</p>
      <h4 v-if="passwordAuthentication">服务账号（按需配置）</h4>
      <form v-if="passwordAuthentication" @submit.prevent="saveUpstream">
        <label><span>9119 用户名</span><input v-model="upstreamUsername" name="upstream-username" autocomplete="off" :disabled="busy" /></label>
        <label><span>9119 密码</span><input v-model="upstreamPassword" name="upstream-password" type="password" autocomplete="new-password" :disabled="busy" /></label>
        <button class="solid-button" :disabled="busy || !upstreamUsername.trim() || !upstreamPassword">验证并保存</button>
      </form>
      <details class="runner-settings" @toggle="runnerSettingsOpen = ($event.target as HTMLDetailsElement).open">
        <summary>执行节点</summary>
        <RunnerSettingsPanel v-if="runnerSettingsOpen" />
      </details>
      <div class="block network-access-block">
        <h3>外网访问地址</h3>
        <p class="network-description">允许通过指定域名或公网 IP 访问 15300。每行填写一个地址，不要包含 <code>http://</code>、端口或路径。</p>
        <form class="allowed-hosts-form" @submit.prevent="saveAllowedHosts">
          <label>
            <span>允许的域名和 IP</span>
            <textarea v-model="allowedHostsText" name="allowed-hosts" rows="5" :disabled="allowedHostsBusy" spellcheck="false" placeholder="yaoyao.example.com&#10;203.0.113.10&#10;2001:db8::10"></textarea>
            <small>当前访问地址：{{ currentAccessHost }}。保存后立即生效，无需重启 Web。</small>
          </label>
          <div v-if="allowedHostsSettings?.environmentHosts.length" class="environment-hosts">
            <small>环境变量保留地址（Web 中不能移除）</small>
            <code>{{ allowedHostsSettings.environmentHosts.join(', ') }}</code>
          </div>
          <p v-if="allowedHostsSettings?.configurationError" class="allowed-hosts-error" role="alert">现有配置异常：{{ allowedHostsSettings.configurationError }}</p>
          <p v-if="allowedHostsError" class="allowed-hosts-error" role="alert">{{ allowedHostsError }}</p>
          <p v-else-if="allowedHostsNotice" class="allowed-hosts-notice" role="status">{{ allowedHostsNotice }}</p>
          <footer><button class="solid-button" :disabled="allowedHostsBusy || allowedHostsText === allowedHostsBaseline">{{ allowedHostsBusy ? '保存中…' : '保存访问地址' }}</button></footer>
        </form>
      </div>
    </div>

    <template v-else>
      <div class="block push-block">
        <h3>iOS 消息推送</h3>
        <p class="push-health" :class="{ ok: pushStatus?.configured && pushStatus?.healthy }">{{ pushStatusText }}</p>
        <div v-if="pushStatus" class="push-status">
          <span><small>Topic</small><b>{{ pushStatus.topic || '—' }}</b></span>
          <span><small>注册设备</small><b>{{ pushStatus.registrationCount }}</b></span>
          <span><small>待发送</small><b>{{ pushStatus.pendingCount }}</b></span>
        </div>

        <template v-if="pushStatus?.managementAvailable">
          <p v-if="pushManagedByEnvironment" class="push-managed-note">当前 APNs 配置由服务环境变量管理，Web 仅可查看。请修改 LaunchAgent、Docker 或进程环境后重启服务。</p>
          <p v-else-if="!pushStatus.editable" class="push-managed-note">当前 APNs 配置为只读，请在 15300 服务端修改后重启服务。</p>
          <form class="push-config-form" @submit.prevent="savePush">
            <label class="wide"><span>.p8 本地路径</span><input v-model="pushKeyFile" name="push-key-file" :readonly="!pushStatus.editable || pushBusy || fcmBusy" autocomplete="off" spellcheck="false" placeholder="/Users/…/AuthKey_XXXXXXXXXX.p8" /><small>填写 15300 所在机器上的绝对路径，私钥内容不会经过浏览器。</small></label>
            <label><span>Key ID</span><input v-model="pushKeyId" name="push-key-id" :readonly="!pushStatus.editable || pushBusy || fcmBusy" autocomplete="off" spellcheck="false" /></label>
            <label><span>Team ID</span><input v-model="pushTeamId" name="push-team-id" :readonly="!pushStatus.editable || pushBusy || fcmBusy" autocomplete="off" spellcheck="false" /></label>
            <label class="wide"><span>Topic（Bundle ID）</span><input v-model="pushTopic" name="push-topic" :readonly="!pushStatus.editable || pushBusy || fcmBusy" autocomplete="off" spellcheck="false" /></label>
            <fieldset class="wide" :disabled="!pushStatus.editable || pushBusy || fcmBusy">
              <legend>推送环境</legend>
              <label><input v-model="pushEnvironments" type="checkbox" value="development" />Sandbox（开发）</label>
              <label><input v-model="pushEnvironments" type="checkbox" value="production" />Production（TestFlight / App Store）</label>
            </fieldset>
            <div v-if="pushStatus.warnings.length" class="wide push-warnings" aria-live="polite">
              <p v-for="warning in pushStatus.warnings" :key="`${warning.code}:${warning.message}`" class="push-warning" role="status"><AppIcon name="alert" :size="14" />{{ warning.message }}</p>
            </div>
            <p v-if="pushError" class="wide push-error" role="alert">{{ pushError }}</p>
            <p v-else-if="pushNotice" class="wide push-notice" role="status">{{ pushNotice }}</p>
            <footer v-if="pushStatus.editable" class="wide"><button class="solid-button" :disabled="!pushCanSave">{{ pushBusy ? '验证中…' : '验证并启用' }}</button></footer>
          </form>
        </template>
        <p v-else-if="pushStatus" class="push-managed-note">当前服务版本只提供推送状态，不能在 Web 中修改配置。</p>
      </div>

      <div class="block push-block">
        <h3>Android 消息推送</h3>
        <p class="push-health" :class="{ ok: fcmStatus?.configured && fcmStatus?.healthy }">{{ fcmStatusText }}</p>
        <div v-if="fcmStatus" class="push-status">
          <span><small>Firebase Project</small><b>{{ fcmStatus.projectId || '—' }}</b></span>
          <span><small>注册设备</small><b>{{ fcmStatus.registrationCount }}</b></span>
          <span><small>待发送</small><b>{{ fcmStatus.pendingCount }}</b></span>
        </div>

        <template v-if="fcmStatus?.managementAvailable">
          <p v-if="fcmManagedByEnvironment" class="push-managed-note">当前 FCM 配置由服务环境变量管理，Web 仅可查看。请修改 LaunchAgent、Docker 或进程环境后重启服务。</p>
          <p v-else-if="!fcmStatus.editable" class="push-managed-note">当前 FCM 配置为只读，请在 15300 服务端修改后重启服务。</p>
          <form class="push-config-form" @submit.prevent="saveFCM">
            <label class="wide"><span>服务账号 JSON 本地路径</span><input v-model="fcmServiceAccountFile" name="fcm-service-account-file" :readonly="!fcmStatus.editable || fcmBusy || pushBusy" autocomplete="off" spellcheck="false" placeholder="/Users/…/firebase-service-account.json" /><small>只填写 15300 所在机器上的绝对路径；JSON 内容和私钥不会经过浏览器，也不会写入夭夭配置。</small></label>
            <label><span>Firebase Project ID</span><input v-model="fcmProjectId" name="fcm-project-id" :readonly="!fcmStatus.editable || fcmBusy || pushBusy" autocomplete="off" spellcheck="false" /></label>
            <label><span>Android 包名</span><input v-model="fcmPackageName" name="fcm-package-name" :readonly="!fcmStatus.editable || fcmBusy || pushBusy" autocomplete="off" spellcheck="false" /></label>
            <div v-if="fcmStatus.warnings.length" class="wide push-warnings" aria-live="polite">
              <p v-for="warning in fcmStatus.warnings" :key="`${warning.code}:${warning.message}`" class="push-warning" role="status"><AppIcon name="alert" :size="14" />{{ warning.message }}</p>
            </div>
            <p v-if="fcmError" class="wide push-error" role="alert">{{ fcmError }}</p>
            <p v-else-if="fcmNotice" class="wide push-notice" role="status">{{ fcmNotice }}</p>
            <footer v-if="fcmStatus.editable" class="wide"><button class="solid-button" :disabled="!fcmCanSave">{{ fcmBusy ? '验证中…' : '验证并启用' }}</button></footer>
          </form>
        </template>
        <p v-else-if="fcmStatus" class="push-managed-note">当前服务版本只提供 FCM 状态，不能在 Web 中修改配置。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.runner-settings { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.runner-settings summary { cursor: pointer; font-weight: 600; padding: 8px 0; }
.system-management-panel { display: grid; }
.block { min-width: 0; margin: 0; padding: 0; }
.block + .block { margin-top: 26px; padding-top: 24px; border-top: 1px solid var(--line); }
.block h3 { margin: 0 0 14px; font-size: 16px; }
.block p { color: var(--danger); font-size: 13px; }
.block p.ok { color: var(--success, #21845b); }
.connection-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
.connection-summary span { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 12px; border-radius: 9px; background: var(--surface-soft); }
.connection-summary span.wide { grid-column: 1 / -1; }
.connection-summary small { color: var(--text-muted); font-size: 11px; }
.connection-summary b { overflow-wrap: anywhere; color: var(--text-primary); font-size: 13px; }
.block p.connection-mode-note { margin: 12px 0 0; padding: 9px 10px; border-radius: 9px; background: var(--surface-soft); color: var(--text-muted); line-height: 1.55; }
.network-description { margin: 0; color: var(--text-muted) !important; line-height: 1.6; }
.network-access-block { margin-top: 26px; padding-top: 24px; border-top: 1px solid var(--line); }
.network-description code { color: var(--text-secondary); }
.allowed-hosts-form { display: grid; grid-template-columns: 1fr; align-items: stretch; }
.allowed-hosts-form textarea { min-width: 0; resize: vertical; padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-raised); color: var(--text-primary); font: 13px/1.55 var(--font-mono, monospace); }
.allowed-hosts-form textarea:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.environment-hosts { display: grid; gap: 5px; padding: 10px 11px; border-radius: 9px; background: var(--surface-soft); }
.environment-hosts small { color: var(--text-muted); font-size: 11px; }
.environment-hosts code { overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12px; }
.allowed-hosts-error,.allowed-hosts-notice { margin: 0; padding: 9px 10px; border-radius: 9px; line-height: 1.55; }
.allowed-hosts-error { background: color-mix(in srgb, var(--danger) 8%, transparent); }
.allowed-hosts-notice { background: color-mix(in srgb, var(--success, #21845b) 9%, transparent); color: var(--success, #21845b) !important; }
.allowed-hosts-form footer { display: flex; justify-content: flex-end; }
.error { margin: 0 0 12px; color: var(--danger); font-size: 13px; }
.push-status { display: grid; grid-template-columns: minmax(0, 2fr) 1fr 1fr; gap: 8px; }
.push-status span { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 12px; border-radius: 9px; background: var(--surface-soft); }
.push-status small { color: var(--text-muted); font-size: 11px; }
.push-status b { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.push-config-form { grid-template-columns: 1fr 1fr; margin-top: 16px; padding: 16px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); }
.push-config-form .wide { grid-column: 1 / -1; }
.push-config-form > label { display: grid; min-width: 0; gap: 6px; color: var(--text-secondary); font-size: 12px; font-weight: 650; }
.push-config-form > label small { color: var(--text-muted); font-size: 11px; font-weight: 400; line-height: 1.5; }
.push-config-form input[readonly] { opacity: .72; cursor: default; }
.push-config-form fieldset { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; }
.push-config-form legend { padding: 0 4px; color: var(--text-secondary); font-size: 12px; font-weight: 650; }
.push-config-form fieldset label { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; }
.push-config-form fieldset input { width: 14px; height: 14px; accent-color: var(--accent); }
.push-managed-note { margin: 10px 0 0; padding: 9px 10px; border-radius: 9px; background: var(--surface-soft); color: var(--text-muted) !important; line-height: 1.55; }
.push-warnings { display: grid; gap: 6px; }
.push-warning { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 9px 10px; border-radius: 9px; background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary) !important; line-height: 1.55; }
.push-error, .push-notice { margin: 0; padding: 9px 10px; border-radius: 9px; line-height: 1.55; }
.push-error { background: color-mix(in srgb, var(--danger) 8%, transparent); }
.push-notice { background: color-mix(in srgb, var(--success, #21845b) 9%, transparent); color: var(--success, #21845b) !important; }
.push-config-form footer { display: flex; justify-content: flex-end; }
.user { display: flex; flex-wrap: wrap; padding: 12px 0; min-height: 58px; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); }
.user > span { flex-basis: 100%; }
.user-assignment { display: grid; flex: 1; min-width: 150px; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.user-assignment select, .create-assignment select { width: 100%; min-height: 76px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-primary); font: inherit; }
.create-assignment { grid-column: 1 / -1; }
.user span { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.user b { font-size: 14px; }
.user small { color: var(--text-muted); font-size: 12px; }
.user button { min-height: 34px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.user button:hover { background: var(--surface-soft); }
.user button.danger { color: var(--danger); }
form { display: grid; grid-template-columns: 1fr 1fr auto; align-items: end; gap: 10px; margin-top: 16px; }
form > label { display: grid; min-width: 0; gap: 6px; color: var(--text-secondary); font-size: 12px; font-weight: 650; }
form > label small { color: var(--text-muted); font-size: 11px; font-weight: 400; }
.user-create-form { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 12px; margin-top: 18px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.user-create-form .solid-button { grid-column: 1 / -1; min-width: 104px; justify-self: end; }
input:not([type="checkbox"]) { min-width: 0; height: 42px; padding: 0 11px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-raised); color: var(--text-primary); font: 13px var(--font-ui); }
input:not([type="checkbox"]):focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.solid-button { min-height: 42px; padding: 0 14px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); }
.solid-button:disabled,.user button:disabled { cursor: not-allowed; opacity: .5; }
@media (max-width: 600px) {
  form { grid-template-columns: 1fr; }
  .user-create-form { grid-template-columns: 1fr; }
  .user { flex-wrap: wrap; padding: 8px 0; }
  .user span { flex-basis: 100%; }
  .push-status { grid-template-columns: 1fr; }
  .push-config-form { grid-template-columns: 1fr; }
  .push-config-form .wide { grid-column: 1; }
  .connection-summary { grid-template-columns: 1fr; }
  .connection-summary span.wide { grid-column: 1; }
}
</style>
