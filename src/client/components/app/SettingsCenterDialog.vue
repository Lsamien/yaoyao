<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AccountSecurityPanel from '@/components/app/AccountSecurityPanel.vue'
import AgentIdentityPanel from '@/components/app/AgentIdentityPanel.vue'
import DuplexVoicePanel from '@/components/app/DuplexVoicePanel.vue'
import ModelServicesPanel from '@/components/app/ModelServicesPanel.vue'
import NodePairingPanel from '@/components/app/NodePairingPanel.vue'
import WorkspaceNodesPanel from '@/components/workspace/WorkspaceNodesPanel.vue'
import WorkspaceVoiceProviders from '@/components/workspace/WorkspaceVoiceProviders.vue'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'
import SystemOverviewPanel from '@/components/app/SystemOverviewPanel.vue'
import FileAccessPanel from '@/components/app/FileAccessPanel.vue'
import SystemUpdatePanel from '@/components/app/SystemUpdatePanel.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import type { ProfileIdentityInput } from '@/api/profiles'
import AppIcon from '@/components/common/AppIcon.vue'
import { CheckmarkCircle, EllipseOutline } from '@vicons/ionicons5'

type SettingsPage =
  | 'agent-identity'
  | 'agent-models'
  | 'account-profile'
  | 'account-security'
  | 'account-mobile'
  | 'appearance'
  | 'system-overview'
  | 'system-file-access'
  | 'system-users'
  | 'system-connection'
  | 'system-push'
  | 'system-nodes'
  | 'system-voice'
  | 'system-update'

type SettingsIcon = 'users' | 'model' | 'settings' | 'panel' | 'monitor' | 'sun' | 'link' | 'bell' | 'audio' | 'refresh'
type ThemePreference = 'light' | 'dark' | 'system'

interface NavigationItem {
  key: SettingsPage
  label: string
  icon: SettingsIcon
}

const props = withDefaults(defineProps<{
  open: boolean
  botMode?: boolean
  initialPage?: SettingsPage
  userName?: string
  userAvatar?: string
  pairingUserName?: string
  activeProfile?: Profile
  profiles?: Profile[]
  theme?: 'light' | 'dark'
  themePreference?: ThemePreference
  insecureTransport?: boolean
  isAdmin?: boolean
  upstreamReady?: boolean
  upstreamError?: string
  identityBusy?: boolean
  identityError?: string
  identityResetVersion?: number
}>(), {
  initialPage: 'agent-identity',
  userName: '',
  userAvatar: '',
  pairingUserName: '',
  activeProfile: undefined,
  profiles: () => [],
  theme: 'light',
  themePreference: 'system',
  insecureTransport: false,
  isAdmin: false,
  upstreamReady: false,
  upstreamError: '',
  identityBusy: false,
  identityError: '',
  identityResetVersion: 0,
})

const emit = defineEmits<{
  close: []
  logout: []
  'select-profile': [profile: string]
  'save-identity': [input: ProfileIdentityInput]
  'set-theme': [theme: ThemePreference]
  'switch-mode': []
}>()

const dialog = ref<HTMLElement>()
const contentTitle = ref<HTMLElement>()
const settingsAgentTrigger = ref<HTMLButtonElement>()
const activePage = ref<SettingsPage>('agent-identity')
const profileMenuOpen = ref(false)
const mobileDetailOpen = ref(false)
const updateLocked = ref(false)
const accountCanSave = ref(false)
const dirtyPages = reactive<Partial<Record<SettingsPage, boolean>>>({})
const settingsQuery = ref('')

const agentItems = computed<NavigationItem[]>(() => !props.isAdmin ? [] : [
  { key: 'agent-identity', label: '身份与头像', icon: 'users' },
  ...(props.isAdmin ? [{ key: 'agent-models', label: '模型与 Provider', icon: 'model' } satisfies NavigationItem] : []),
])
const accountItems = computed<NavigationItem[]>(() => [
  { key: 'account-profile', label: '账号资料', icon: 'users' },
  { key: 'account-security', label: '登录与安全', icon: 'settings' },
  { key: 'appearance', label: '外观', icon: 'sun' },
  ...(props.isAdmin ? [{ key: 'account-mobile', label: '手机登录', icon: 'panel' } satisfies NavigationItem] : []),
])
const systemItems: NavigationItem[] = [
  { key: 'system-overview', label: '系统概览', icon: 'panel' },
  { key: 'system-connection', label: 'Hermes 连接', icon: 'link' },
  { key: 'system-users', label: '用户与权限', icon: 'users' },
  { key: 'system-nodes', label: '节点与设备', icon: 'panel' },
  { key: 'system-file-access', label: '文件访问', icon: 'panel' },
  { key: 'system-push', label: '消息推送', icon: 'bell' },
  { key: 'system-voice', label: '双流语音', icon: 'audio' },
  { key: 'system-update', label: '更新与回滚', icon: 'refresh' },
]
const matchesSearch = (item: NavigationItem) => item.label.toLocaleLowerCase().includes(settingsQuery.value.trim().toLocaleLowerCase())
const visibleAccounts = computed(() => accountItems.value.filter(matchesSearch))
const visibleSystems = computed(() => systemItems.filter(matchesSearch))
const visibleAgents = computed(() => agentItems.value.filter(matchesSearch))

const allAllowedPages = computed(() => new Set<SettingsPage>([
  ...agentItems.value.map(item => item.key),
  ...accountItems.value.map(item => item.key),
  ...(props.isAdmin ? systemItems.map(item => item.key) : []),
]))
const activeDirty = computed(() => Boolean(dirtyPages[activePage.value]))
const showFixedFooter = computed(() => activePage.value === 'agent-identity' || activePage.value === 'account-security')
const activeTitle = computed(() => ({
  'agent-identity': '身份与头像',
  'agent-models': '模型与 Provider',
  'account-profile': '账号资料',
  'account-security': '登录与安全',
  'account-mobile': '手机登录',
  appearance: '外观',
  'system-overview': '系统概览',
  'system-file-access': '文件访问',
  'system-users': '用户与权限',
  'system-connection': 'Hermes 连接',
  'system-push': '消息推送',
  'system-nodes': '节点与设备',
  'system-voice': '双流语音',
  'system-update': '更新与回滚',
})[activePage.value])
const accountName = computed(() => props.pairingUserName || props.userName || '当前账号')
const showAgentSelector = computed(() => activePage.value.startsWith('agent-'))
const activeScope = computed(() => {
  if (activePage.value.startsWith('agent-')) return `正在设置：${profileTitle(props.activeProfile)} / ${props.activeProfile?.name || '未选择'}`
  if (activePage.value === 'account-profile') return '管理你的账号头像与服务器名称。'
  if (activePage.value.startsWith('account-')) return `当前账号：${accountName.value}${props.isAdmin ? ' · 管理员' : ''}`
  if (activePage.value === 'appearance') return '选择当前浏览器的显示方式。'
  return '全局设置 · 仅管理员'
})

function profileTitle(profile?: Profile): string {
  return profile?.agentName || profile?.displayName || profile?.name || '未选择机器人'
}

function setDirty(page: SettingsPage, dirty: boolean) {
  dirtyPages[page] = dirty
}

function confirmDiscard(): boolean {
  return !activeDirty.value || window.confirm('放弃当前页面未保存的更改？')
}

function selectPage(page: SettingsPage) {
  if (page === activePage.value) {
    mobileDetailOpen.value = true
    void nextTick(() => {
      if (window.innerWidth < 768) contentTitle.value?.focus()
    })
    return
  }
  if (updateLocked.value || !allAllowedPages.value.has(page) || !confirmDiscard()) return
  dirtyPages[activePage.value] = false
  activePage.value = page
  accountCanSave.value = false
  mobileDetailOpen.value = true
  profileMenuOpen.value = false
  void nextTick(() => {
    if (window.innerWidth < 768) contentTitle.value?.focus()
  })
}

function requestClose() {
  if (updateLocked.value || !confirmDiscard()) return
  dirtyPages[activePage.value] = false
  emit('close')
}

function backToMenu() {
  if (updateLocked.value || !confirmDiscard()) return
  dirtyPages[activePage.value] = false
  mobileDetailOpen.value = false
  void nextTick(() => {
    dialog.value?.querySelector<HTMLButtonElement>('.settings-sidebar nav button[aria-current="page"]')?.focus()
  })
}

function selectProfile(profile: string) {
  if (updateLocked.value || !confirmDiscard()) return
  dirtyPages[activePage.value] = false
  profileMenuOpen.value = false
  emit('select-profile', profile)
  void nextTick(() => settingsAgentTrigger.value?.focus())
}

function toggleAgentMenu() {
  profileMenuOpen.value = !profileMenuOpen.value
  if (!profileMenuOpen.value) return
  void nextTick(() => {
    dialog.value?.querySelector<HTMLButtonElement>('.settings-agent-menu [role="option"][aria-selected="true"]')?.focus()
  })
}

function handleAgentMenuKeydown(event: KeyboardEvent) {
  const options = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="option"]')]
  if (!options.length) return
  const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
  let next: number | undefined
  if (event.key === 'ArrowDown') next = (current + 1) % options.length
  else if (event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = options.length - 1
  else if (event.key === 'Escape') {
    event.preventDefault()
    profileMenuOpen.value = false
    void nextTick(() => settingsAgentTrigger.value?.focus())
    return
  }
  if (next === undefined) return
  event.preventDefault()
  options[next]?.focus()
}

function handleEscape() {
  if (profileMenuOpen.value) {
    profileMenuOpen.value = false
    void nextTick(() => settingsAgentTrigger.value?.focus())
    return
  }
  if (window.innerWidth < 768 && mobileDetailOpen.value) { backToMenu(); return }
  requestClose()
}
function trapFocus(event: KeyboardEvent) {
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(el => el.tabIndex >= 0 && el.getClientRects().length)
  const first = items[0], last = items.at(-1)
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

watch(() => [props.open, props.initialPage] as const, ([open, initialPage]) => {
  if (!open) {
    profileMenuOpen.value = false
    updateLocked.value = false
    return
  }
  activePage.value = allAllowedPages.value.has(initialPage)
    ? initialPage
    : props.isAdmin && props.activeProfile ? 'agent-identity' : 'account-profile'
  settingsQuery.value = ''
  for (const key of Object.keys(dirtyPages) as SettingsPage[]) dirtyPages[key] = false
  profileMenuOpen.value = false
  mobileDetailOpen.value = false
  void nextTick(() => dialog.value?.focus())
}, { immediate: true })
function requestModeSwitch() {
  if (updateLocked.value || !confirmDiscard()) return
  emit('switch-mode')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="settings-center-fade">
      <div v-if="open" class="settings-center-layer" role="presentation" @mousedown.self="requestClose">
        <section
          ref="dialog"
          class="settings-center"
          :class="{ 'settings-center--mobile-detail': mobileDetailOpen }"
          role="dialog"
          aria-modal="true"
          aria-label="我的设置"
          tabindex="-1"
          @keydown.esc.capture.prevent.stop="handleEscape"
          @keydown.tab="trapFocus"
        >
          <header class="settings-center__topbar"><h2>我的设置</h2><button class="settings-center__close" type="button" aria-label="关闭我的设置" :disabled="updateLocked" @click="requestClose"><AppIcon name="close" :size="20"/></button></header>
          <div class="settings-center__body">
            <aside class="settings-sidebar" aria-label="设置分类">
              <header class="settings-sidebar__header">
                <h2 id="settings-center-title">我的设置</h2>
                <button class="settings-center__close" type="button" aria-label="关闭我的设置" :disabled="updateLocked" @click="requestClose"><AppIcon name="close" :size="18" /></button>
              </header>
              <div class="settings-sidebar__scroll">
                <label class="settings-search"><AppIcon name="search" :size="16"/><input v-model="settingsQuery" type="search" aria-label="搜索设置" placeholder="搜索设置" /></label>
                <div v-if="showAgentSelector" class="settings-agent-selector">
                  <button ref="settingsAgentTrigger" type="button" aria-haspopup="listbox" :aria-expanded="profileMenuOpen" @click="toggleAgentMenu">
                    <AgentAvatar :name="profileTitle(activeProfile)" :avatar="activeProfile?.agentAvatar || ''" :size="34" />
                    <span><strong>{{ profileTitle(activeProfile) }}</strong><small>{{ activeProfile?.name || '未选择机器人' }}</small></span>
                    <AppIcon name="chevron-down" :size="14" />
                  </button>
                  <div v-if="profileMenuOpen" class="settings-agent-menu" role="listbox" aria-label="切换正在设置的机器人" @keydown="handleAgentMenuKeydown">
                    <button v-for="profile in profiles" :key="profile.name" type="button" role="option" :aria-selected="profile.name === activeProfile?.name" @click="selectProfile(profile.name)">
                      <AgentAvatar :name="profileTitle(profile)" :avatar="profile.agentAvatar || ''" :size="24" />
                      <span><strong>{{ profileTitle(profile) }}</strong><small>{{ profile.name }}</small></span>
                      <AppIcon v-if="profile.name === activeProfile?.name" name="check" :size="14" />
                    </button>
                  </div>
                </div>
                <nav>
                  <section v-if="visibleAccounts.length">
                    <h3>个人</h3>
                    <button v-for="item in visibleAccounts" :key="item.key" type="button" :class="{ active: activePage === item.key }" :aria-current="activePage === item.key ? 'page' : undefined" @click="selectPage(item.key)"><AppIcon :name="item.icon" :size="18" /><span>{{ item.label }}</span></button>
                  </section>
                  <section v-if="isAdmin && visibleSystems.length">
                    <h3>管理</h3>
                    <button v-for="item in visibleSystems" :key="item.key" type="button" :class="{ active: activePage === item.key }" :aria-current="activePage === item.key ? 'page' : undefined" @click="selectPage(item.key)"><AppIcon :name="item.icon" :size="18" /><span>{{ item.label }}</span><em v-if="item.key === 'system-voice'">全局</em></button>
                  </section>
                  <section v-if="visibleAgents.length">
                    <h3>基础机器人</h3>
                    <button v-for="item in visibleAgents" :key="item.key" type="button" :class="{ active: activePage === item.key }" :aria-current="activePage === item.key ? 'page' : undefined" @click="selectPage(item.key)"><AppIcon :name="item.icon" :size="18" /><span>{{ item.label }}</span></button>
                  </section>
                  <section v-if="isAdmin && !settingsQuery"><button type="button" :disabled="updateLocked" @click="requestModeSwitch"><AppIcon :name="botMode ? 'chat' : 'users'" :size="18" /><span>{{ botMode ? '进入聊天模式' : '进入 Bot 模式' }}</span></button></section>
                  <p v-if="!visibleAccounts.length && (!isAdmin || !visibleSystems.length) && !visibleAgents.length" class="settings-search-empty">没有匹配的设置</p>
                </nav>
              </div>
            </aside>

            <main class="settings-content" :class="{ 'settings-content--with-footer': showFixedFooter }">
              <header class="settings-content__header">
                <button v-if="mobileDetailOpen" class="mobile-back" type="button" aria-label="返回设置分类" :disabled="updateLocked" @click="backToMenu"><AppIcon name="chevron-left" :size="20" /></button>
                <div class="settings-content__heading"><h3 ref="contentTitle" tabindex="-1">{{ activeTitle }}</h3><p>{{ activeScope }}</p></div>
                <button class="settings-center__close settings-detail-close" type="button" aria-label="关闭我的设置" :disabled="updateLocked" @click="requestClose"><AppIcon name="close" :size="18" /></button>
              </header>
              <div class="settings-content__scroll">
                <AgentIdentityPanel
                  v-if="activePage === 'agent-identity' && activeProfile"
                  :key="activeProfile.name"
                  :profile="activeProfile"
                  :busy="identityBusy"
                  :error="identityError"
                  :reset-version="identityResetVersion"
                  form-id="settings-agent-identity-form"
                  :show-actions="false"
                  @dirty-change="setDirty('agent-identity', $event)"
                  @save="emit('save-identity', $event)"
                />
                <p v-else-if="activePage === 'agent-identity'" class="settings-empty">尚未选择机器人。</p>
                <ModelServicesPanel v-else-if="activePage === 'agent-models' && activeProfile && isAdmin" :key="activeProfile.name" :profile="activeProfile.name" @dirty-change="setDirty('agent-models', $event)" />
                <AccountSecurityPanel
                  v-else-if="activePage === 'account-security' || activePage === 'account-profile'"
                  :key="activePage"
                  :section="activePage === 'account-profile' ? 'profile' : 'security'"
                  :active="true"
                  form-id="settings-account-security-form"
                  :show-actions="false"
                  @dirty-change="setDirty(activePage, $event)"
                  @can-save-change="accountCanSave = $event"
                  @saved="setDirty(activePage, false)"
                  @logout="emit('logout')"
                />
                <NodePairingPanel v-else-if="activePage === 'account-mobile'" mode="account" :active="true" :insecure-transport="insecureTransport" :user-name="accountName" />
                <section v-else-if="activePage === 'appearance'" class="appearance-panel" aria-label="外观">
                  <h4>界面主题</h4>
                  <div class="theme-options" role="radiogroup" aria-label="界面主题">
                    <button v-for="option in ([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const)" :key="option[0]" type="button" role="radio" :aria-checked="themePreference === option[0]" :class="{ active: themePreference === option[0] }" @click="emit('set-theme', option[0])">
                      <img :src="`/setting-previews/${option[0]}.png`" alt="" width="480" height="300"/>
                      <strong>{{ option[1] }}</strong>
                      <component :is="themePreference === option[0] ? CheckmarkCircle : EllipseOutline" class="theme-choice-mark" aria-hidden="true"/>
                    </button>
                  </div>
                  <p class="appearance-note"><AppIcon name="info" :size="16"/>更改仅影响当前浏览器。</p>
                </section>
                <SystemOverviewPanel v-else-if="activePage === 'system-overview' && isAdmin" :active="true" :upstream-ready="upstreamReady" :upstream-error="upstreamError" @navigate="selectPage" />
                <FileAccessPanel v-else-if="activePage === 'system-file-access' && isAdmin" :profile="activeProfile?.name" @dirty-change="setDirty('system-file-access', $event)" />
                <SystemManagementPanel v-else-if="activePage === 'system-users' && isAdmin" section="users" :profiles="profiles" :active="true" @dirty-change="setDirty('system-users', $event)" />
                <SystemManagementPanel v-else-if="activePage === 'system-connection' && isAdmin" section="connection" :active="true" :profiles="profiles" :upstream-ready="upstreamReady" :upstream-error="upstreamError" @dirty-change="setDirty('system-connection', $event)" />
                <SystemManagementPanel v-else-if="activePage === 'system-push' && isAdmin" section="push" :active="true" @dirty-change="setDirty('system-push', $event)" />
                <WorkspaceNodesPanel v-else-if="activePage === 'system-nodes' && isAdmin" />
                <section v-else-if="activePage === 'system-voice' && isAdmin"><DuplexVoicePanel @dirty-change="setDirty('system-voice', $event)" /><WorkspaceVoiceProviders /></section>
                <SystemUpdatePanel v-else-if="activePage === 'system-update' && isAdmin" :active="true" @lock-change="updateLocked = $event" />
              </div>
              <footer v-if="showFixedFooter" class="settings-content__footer">
                <button class="settings-footer__cancel" type="button" :disabled="identityBusy" @click="requestClose">取消</button>
                <button
                  v-if="activePage === 'agent-identity'"
                  class="settings-footer__save"
                  type="submit"
                  form="settings-agent-identity-form"
                  :disabled="identityBusy || !activeDirty"
                >{{ identityBusy ? '正在同步…' : '保存更改' }}</button>
                <button
                  v-else
                  class="settings-footer__save"
                  type="submit"
                  form="settings-account-security-form"
                  :disabled="!accountCanSave"
                >保存更改</button>
              </footer>
            </main>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-center-layer{position:fixed;z-index:300;inset:0;display:grid;place-items:center;padding:24px;background:var(--scrim);backdrop-filter:blur(3px)}
.settings-center{display:flex;flex-direction:column;width:min(900px,calc(100vw - 48px));height:min(650px,calc(100dvh - 64px));overflow:hidden;border:1px solid var(--line);border-radius:14px;outline:0;background:var(--surface);box-shadow:0 24px 72px #0003;color:var(--text-primary)}
.settings-center__topbar{height:60px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding:8px 16px 8px 20px;border-bottom:1px solid var(--line)}
.settings-center__topbar h2{margin:0;font-size:18px;font-weight:650;letter-spacing:-.02em}
.settings-center__close,.mobile-back{display:grid;width:44px;height:44px;place-items:center;flex-shrink:0;padding:0;border:0;border-radius:9px;background:transparent;color:var(--text-secondary);cursor:pointer}
.settings-center__close:hover,.mobile-back:hover{background:var(--surface-hover);color:var(--text-primary)}
.settings-center__close:disabled,.mobile-back:disabled{cursor:not-allowed;opacity:.45}
.settings-center button:focus-visible,.settings-center input:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mobile-back,.settings-detail-close{display:none}
.settings-center__body{display:grid;flex:1;min-height:0;grid-template-columns:208px minmax(0,1fr)}
.settings-sidebar{position:relative;min-height:0;overflow-y:auto;padding:16px 12px;border-right:1px solid var(--line);background:var(--settings-sidebar);overscroll-behavior:contain;scrollbar-width:thin}
.settings-sidebar__header{display:none}.settings-sidebar__header h2{margin:0;font-size:18px;font-weight:650}
.settings-sidebar__scroll{min-height:0}
.settings-search{display:flex;align-items:center;gap:8px;height:38px;padding:0 10px;margin-bottom:22px;border:1px solid var(--line);border-radius:8px;background:var(--settings-panel);color:var(--text-muted)}
.settings-search input{min-width:0;width:100%;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--text-primary);font:13px var(--font-ui)}
.settings-search:focus-within{outline:2px solid var(--accent);outline-offset:2px}
.settings-agent-selector{position:relative;margin:0 0 20px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.settings-agent-selector>button{display:grid;width:100%;min-height:44px;grid-template-columns:34px minmax(0,1fr) 16px;align-items:center;gap:8px;padding:2px 4px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);cursor:pointer;text-align:left}
.settings-agent-selector>button:hover{background:var(--surface-hover)}
.settings-agent-selector span,.settings-agent-menu span{display:grid;min-width:0;gap:2px}
.settings-agent-selector strong{overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.settings-agent-selector small,.settings-agent-menu small{overflow:hidden;color:var(--text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.settings-agent-menu{position:absolute;z-index:5;top:calc(100% - 8px);right:0;left:0;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:var(--shadow-float)}
.settings-agent-menu button{display:grid;width:100%;min-height:40px;grid-template-columns:24px minmax(0,1fr) 16px;align-items:center;gap:8px;padding:4px 6px;border:0;border-radius:8px;background:transparent;color:var(--text-primary);cursor:pointer;text-align:left}
.settings-agent-menu button:hover,.settings-agent-menu button[aria-selected=true]{background:var(--surface-hover)}.settings-agent-menu strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.settings-sidebar nav{display:grid;gap:22px}
.settings-sidebar nav section{display:grid;gap:3px}.settings-sidebar nav section+section{padding-top:20px;border-top:1px solid var(--line)}
.settings-sidebar h3{margin:0 10px 6px;color:var(--text-muted);font-size:12px;font-weight:500}
.settings-sidebar nav button{display:flex;width:100%;min-height:44px;align-items:center;gap:12px;padding:8px 12px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);cursor:pointer;text-align:left;font:500 14px var(--font-ui)}
.settings-sidebar nav button:hover{background:var(--surface-hover)}.settings-sidebar nav button.active{background:var(--settings-selected);font-weight:600}
.settings-sidebar nav button span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.settings-sidebar nav button em{color:var(--text-muted);font:normal 10px var(--font-ui)}
.settings-search-empty{margin:0 10px;font-size:13px;line-height:1.6;color:var(--text-secondary)}
.settings-content{display:grid;min-width:0;min-height:0;grid-template-rows:auto minmax(0,1fr);background:var(--surface)}
.settings-content--with-footer{grid-template-rows:auto minmax(0,1fr) 64px}
.settings-content__header{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:8px;padding:24px 24px 16px}
.settings-content__heading{min-width:0}.settings-content__header h3{margin:0;font-size:18px;font-weight:650;letter-spacing:-.01em}.settings-content__header p{margin:6px 0 0;color:var(--text-secondary);font-size:13px;line-height:1.6}
.settings-content__scroll{min-height:0;overflow-y:auto;padding:8px 24px 24px;overscroll-behavior:contain;scrollbar-width:thin}
.settings-content__footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 24px;border-top:1px solid var(--line);background:var(--surface)}
.settings-content__footer button{display:inline-flex;min-width:88px;min-height:40px;align-items:center;justify-content:center;padding:0 16px;border-radius:8px;cursor:pointer;font:550 13px var(--font-ui)}
.settings-footer__cancel{border:1px solid var(--line);background:var(--settings-panel);color:var(--text-primary)}.settings-footer__save{border:0;background:var(--accent);color:var(--text-on-solid)}.settings-content__footer button:disabled{cursor:not-allowed;opacity:.45}
.settings-empty{margin:0;padding:24px;border-radius:12px;background:var(--settings-panel);color:var(--text-muted);font-size:14px;text-align:center}
.appearance-panel{display:grid;gap:16px;padding:20px;background:var(--settings-panel);border-radius:12px}.appearance-panel h4{margin:0;font-size:15px;font-weight:600}
.theme-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.theme-options button{display:flex;flex-direction:column;align-items:center;gap:14px;min-width:0;padding:10px 10px 12px;border:2px solid transparent;border-radius:10px;background:var(--surface);color:var(--text-primary);cursor:pointer;font:inherit;box-shadow:0 0 0 1px var(--line)}
.theme-options button:hover{border-color:var(--line-strong)}.theme-options button.active{border-color:var(--accent);box-shadow:none}.theme-options img{display:block;width:100%;height:auto;aspect-ratio:8/5;object-fit:cover;border-radius:7px}.theme-options strong{font-size:13px;font-weight:550}.theme-choice-mark{width:20px;height:20px;color:var(--text-primary)}
.appearance-note{display:flex;align-items:flex-start;gap:8px;margin:2px 0 0;padding-top:16px;border-top:1px solid var(--line);color:var(--text-secondary);font-size:13px;line-height:1.6}
.settings-content__scroll :deep(.account-security-panel>.panel-heading){display:none}.settings-content__scroll :deep(.account-security-panel){gap:20px}.settings-content__scroll :deep(.account-avatar-card),.settings-content__scroll :deep(.security-form),.settings-content__scroll :deep(.server-identity){padding:20px;border:0;border-radius:12px;background:var(--settings-panel)}.settings-content__scroll :deep(.security-form){gap:16px}.settings-content__scroll :deep(.field input){background:var(--surface)}
.settings-center-fade-enter-active,.settings-center-fade-leave-active{transition:opacity 150ms ease}.settings-center-fade-enter-active .settings-center,.settings-center-fade-leave-active .settings-center{transition:transform 180ms var(--ease-out)}.settings-center-fade-enter-from,.settings-center-fade-leave-to{opacity:0}.settings-center-fade-enter-from .settings-center,.settings-center-fade-leave-to .settings-center{transform:translateY(6px) scale(.99)}
@media(max-width:767px){.settings-center-layer{padding:0}.settings-center{width:100vw;height:100dvh;border:0;border-radius:0}.settings-center__topbar{display:none}.settings-center__body{display:block;height:100%}.settings-sidebar{display:grid;width:100%;height:100%;box-sizing:border-box;grid-template-rows:60px minmax(0,1fr);overflow:hidden;padding:0;border-right:0}.settings-sidebar__header{display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 20px;border-bottom:1px solid var(--line)}.settings-sidebar__scroll{min-height:0;overflow-y:auto;padding:20px 16px max(24px,env(safe-area-inset-bottom))}.settings-center--mobile-detail .settings-sidebar{display:none}.settings-content{display:none;width:100%;height:100%}.settings-center--mobile-detail .settings-content{display:grid}.settings-content__header{min-height:60px;grid-template-columns:44px minmax(0,1fr) 44px;gap:4px;padding:8px 8px 8px 6px;border-bottom:1px solid var(--line)}.settings-content__header h3{font-size:17px}.settings-content__header p{display:none}.settings-center--mobile-detail .mobile-back,.settings-detail-close{display:grid}.settings-content__scroll{padding:20px 16px max(24px,env(safe-area-inset-bottom))}.settings-content--with-footer{grid-template-rows:auto minmax(0,1fr) calc(64px + env(safe-area-inset-bottom))}.settings-content__footer{padding:0 16px env(safe-area-inset-bottom)}.settings-content__footer button{flex:1}.appearance-panel{padding:14px;gap:14px}.theme-options{gap:8px}.theme-options button{padding:6px 6px 10px;gap:12px}.theme-options strong{font-size:12px}}
@media(prefers-reduced-motion:reduce){.settings-center-fade-enter-active,.settings-center-fade-leave-active,.settings-center-fade-enter-active .settings-center,.settings-center-fade-leave-active .settings-center{transition:none}}
</style>
