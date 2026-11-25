<script setup lang="ts">
import UnreadPanel from './UnreadPanel.vue'
import { useUnreadStore } from '@/stores/unread'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Profile } from '@shared/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AccountInitialAvatar from '@/components/common/AccountInitialAvatar.vue'
import type { ProfileIdentityInput } from '@/api/profiles'
import AppIcon from '@/components/common/AppIcon.vue'
import BrandMark from '@/components/common/BrandMark.vue'
import SettingsCenterDialog from '@/components/app/SettingsCenterDialog.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import DesktopUpdateEntry from './DesktopUpdateEntry.vue'
import { useDesktopUpdate } from '@/composables/useDesktopUpdate'
const AboutDialog = defineAsyncComponent(() => import('./AboutDialog.vue'))
const BotPluginsDialog = defineAsyncComponent(() => import('@/components/workspace/BotPluginsDialog.vue'))
const BotSettingsDialog = defineAsyncComponent(() => import('@/components/workspace/BotSettingsDialog.vue'))

type SettingsPage =
  | 'agent-identity'
  | 'agent-models'
  | 'account-profile'
  | 'account-security'
  | 'credential-vault'
  | 'account-mobile'
  | 'appearance'
  | 'desktop-mode'

const SIDEBAR_SEARCH_EVENT = 'hermes-yaoyao:sidebar-search'
const SIDEBAR_SEARCH_CLOSE_EVENT = 'hermes-yaoyao:sidebar-search-close'

const props = withDefaults(defineProps<{
  serverName?: string
  userName?: string
  userAvatar?: string
  pairingUserName?: string
  activeProfile?: Profile
  profiles?: Profile[]
  theme?: 'light' | 'dark'
  themePreference?: 'light' | 'dark' | 'system'
  insecureTransport?: boolean
  sidebarTitle?: string
  sidebarSubtitle?: string
  sidebarContextTitle?: string
  sidebarFocusMode?: boolean
  inspectorOpen?: boolean
  inspectorCloseLabel?: string
  upstreamReady?: boolean
  upstreamError?: string
  identityBusy?: boolean
  identityError?: string
  identityResetVersion?: number
}>(), {
  serverName: '',
  userName: '',
  userAvatar: '',
  pairingUserName: '',
  activeProfile: undefined,
  profiles: () => [],
  theme: 'light',
  themePreference: 'system',
  insecureTransport: false,
  sidebarTitle: '',
  sidebarSubtitle: '',
  sidebarContextTitle: '',
  sidebarFocusMode: false,
  inspectorOpen: false,
  inspectorCloseLabel: '关闭预览',
  upstreamReady: false,
  upstreamError: '',
  identityBusy: false,
  identityError: '',
  identityResetVersion: 0,
})

const emit = defineEmits<{
  logout: []
  toggleTheme: []
  setTheme: [theme: 'light' | 'dark' | 'system']
  selectProfile: [profile: string]
  saveIdentity: [input: ProfileIdentityInput]
  closeInspector: []
  createAgent: []
  createGroup: []
  botSettingsChanged: []
}>()

const unread = useUnreadStore(), unreadOpen = ref(false)
const unreadAnchor = ref({ left: 0, top: 0 })
let unreadTrigger: HTMLButtonElement | undefined

function openUnread(event: MouseEvent) {
  unreadTrigger = event.currentTarget as HTMLButtonElement
  const entry = unreadTrigger.getBoundingClientRect()
  const sidebar = unreadTrigger.closest('aside')!.getBoundingClientRect()
  unreadAnchor.value = { left: sidebar.right + 12, top: entry.top }
  createMenuOpen.value = false
  settingsMenuOpen.value = false
  toolsMenuOpen.value = false
  unreadOpen.value = true
}

function closeUnread() {
  unreadOpen.value = false
  void nextTick(() => { if (unreadTrigger?.isConnected) unreadTrigger.focus() })
}
const route = useRoute()
const router = useRouter()
const mobileDrawerOpen = ref(false)
const settingsOpen = ref(false)
const standalone = ref<'plugins' | 'about' | 'update' | 'bot-settings' | null>(null)
const botSettingsPage = ref<'projects'>('projects')
const standaloneReturnFocus = ref<HTMLElement>()
const settingsPage = ref<SettingsPage>('agent-identity')
const settingsReturnFocus = ref<HTMLButtonElement>()
const mobileNavigationTrigger = ref<HTMLButtonElement>()
const mobileDrawerClose = ref<HTMLButtonElement>()
const sidebarSearchOpen = ref(false)
const createMenuOpen = ref(false)
const createMenu = ref<HTMLElement | null>(null)
let createTrigger: HTMLElement | null = null
const createPosition = ref({ left: '8px', top: '58px' })
const settingsMenuOpen = ref(false)
const desktopUpdate = useDesktopUpdate()
const { state: desktopUpdateState, error: desktopUpdateError, pending: desktopUpdatePending, visible: desktopUpdateVisible } = desktopUpdate
// Web updates are applied from the admin console; here only the desktop App checks for its own updates.
const canCheckUpdates = computed(() => desktopUpdate.supported || Boolean(window.yaoyaoDesktop?.openUpdates))
const desktopUpdateBusy = computed(() => desktopUpdatePending.value || ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(desktopUpdateState.value?.phase ?? ''))
const desktopUpdateCheckLabel = computed(() => desktopUpdateState.value?.phase === 'checking' ? '正在检测…'
  : desktopUpdateState.value?.phase === 'checked' && !desktopUpdateState.value.available ? '已是最新版本' : '检测更新')
const openingUpdate = ref(false)
const updateError = ref('')
const settingsMenu = ref<HTMLElement | null>(null)
let settingsTrigger: HTMLButtonElement | null = null
const settingsMenuPosition = ref({ left: '8px', top: '8px' })
const toolsMenuOpen = ref(false), toolsMenu = ref<HTMLElement | null>(null)
const toolsPosition = ref({ left: '8px', top: '8px' })
let toolsTrigger: HTMLButtonElement | null = null
const desktopSidebarContext = ref<HTMLElement | null>(null)
const mobileSidebarContext = ref<HTMLElement | null>(null)

async function navigate(path: string) {
  mobileDrawerOpen.value = false
  await router.push(path)
}

function openMobileDrawer() {
  mobileDrawerOpen.value = true
  void nextTick(() => mobileDrawerClose.value?.focus())
}

function closeMobileDrawer() {
  mobileDrawerOpen.value = false
  void nextTick(() => mobileNavigationTrigger.value?.focus())
}

function closeMenus(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.workspace-create-menu, .sidebar-create-trigger')) createMenuOpen.value = false
  if (!target.closest('.workspace-settings-menu, .sidebar-settings-trigger')) settingsMenuOpen.value = false
  if (!target.closest('.workspace-tools-menu, .sidebar-tools-trigger')) toolsMenuOpen.value = false
}
function closeCreateMenu() {
  createMenuOpen.value = false
  void nextTick(() => { if (createTrigger?.isConnected) createTrigger.focus() })
}
async function openCreateMenu(event: Event) {
  if (createMenuOpen.value) { closeCreateMenu(); return }
  createTrigger = event.currentTarget as HTMLElement
  const rect = createTrigger.getBoundingClientRect()
  createPosition.value = { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 192))}px`, top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 96))}px` }
  createMenuOpen.value = true
  await nextTick()
  createMenu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
}
function chooseCreate(kind: 'agent' | 'group') {
  closeCreateMenu()
  mobileDrawerOpen.value = false
  if (kind === 'agent') emit('createAgent')
  else emit('createGroup')
}
function actionMenuKeydown(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement as HTMLElement)
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus()
}

function closeSettingsMenu() {
  settingsMenuOpen.value = false
  void nextTick(() => { if (settingsTrigger?.isConnected) settingsTrigger.focus() })
}
async function openSettingsMenu(event: MouseEvent) {
  if (settingsMenuOpen.value) { closeSettingsMenu(); return }
  settingsTrigger = event.currentTarget as HTMLButtonElement
  const rect = settingsTrigger.getBoundingClientRect()
  const height = (3 + Number(canCheckUpdates.value)) * (window.innerWidth < 768 ? 44 : 36) + 18
  settingsMenuPosition.value = { left: `${Math.max(8, Math.min(rect.right - 180, window.innerWidth - 188))}px`, top: `${Math.max(8, rect.top - height)}px` }
  createMenuOpen.value = false
  toolsMenuOpen.value = false
  updateError.value = ''
  void desktopUpdate.refresh()
  settingsMenuOpen.value = true
  await nextTick()
  settingsMenu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
}
async function checkForUpdates() {
  if (openingUpdate.value || !canCheckUpdates.value) return
  updateError.value = ''
  if (desktopUpdate.supported) { await desktopUpdate.run('check'); return }
  if (window.yaoyaoDesktop?.openUpdates) {
    openingUpdate.value = true
    try {
      await window.yaoyaoDesktop.openUpdates()
      closeSettingsMenu()
    } catch (cause) {
      updateError.value = cause instanceof Error ? cause.message : '无法打开更新窗口，请重试'
    } finally { openingUpdate.value = false }
    return
  }
  standaloneReturnFocus.value = settingsTrigger?.closest('.mobile-drawer')
    ? mobileNavigationTrigger.value : settingsTrigger ?? undefined
  settingsMenuOpen.value = false
  mobileDrawerOpen.value = false
  standalone.value = 'update'
}
function chooseSettingsAction(action: 'settings' | 'about') {
  settingsMenuOpen.value = false
  settingsReturnFocus.value = settingsTrigger?.closest('.mobile-drawer')
    ? mobileNavigationTrigger.value : settingsTrigger ?? undefined
  if (action === 'about') {
    standaloneReturnFocus.value = settingsReturnFocus.value
    mobileDrawerOpen.value = false
    standalone.value = 'about'
    return
  }
  openSettings('account-profile')
}
function closeStandalone() { standalone.value = null; void nextTick(() => standaloneReturnFocus.value?.isConnected && standaloneReturnFocus.value.focus()) }
function closeToolsMenu() { toolsMenuOpen.value = false; void nextTick(() => toolsTrigger?.isConnected && toolsTrigger.focus()) }
async function openToolsMenu(event: MouseEvent) {
  if (toolsMenuOpen.value) { closeToolsMenu(); return }
  toolsTrigger = event.currentTarget as HTMLButtonElement
  const rect = toolsTrigger.getBoundingClientRect()
  const height = 3 * (window.innerWidth < 768 ? 44 : 36) + 18
  toolsPosition.value = { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 208))}px`, top: `${Math.max(8, rect.top - height)}px` }
  settingsMenuOpen.value = false; createMenuOpen.value = false; toolsMenuOpen.value = true
  await nextTick(); toolsMenu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
}
function chooseTool(page: 'apps' | 'automations' | 'bot-settings') {
  toolsMenuOpen.value = false
  if (page === 'automations') { void navigate('/conversations/automations?from=' + encodeURIComponent(route.fullPath)); return }
  standaloneReturnFocus.value = toolsTrigger?.closest('.mobile-drawer') ? mobileNavigationTrigger.value : toolsTrigger ?? undefined
  mobileDrawerOpen.value = false
  botSettingsPage.value = 'projects'
  standalone.value = page === 'bot-settings' ? 'bot-settings' : 'plugins'
}
function workspaceKeydown(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || settingsOpen.value || document.querySelector('dialog[open]')) return
  event.preventDefault()
  if (sidebarSearchOpen.value) document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
  else void openSidebarSearch(null)
}

function openSettings(page: SettingsPage = 'account-profile', event?: MouseEvent) {
  const trigger = event?.currentTarget
  if (trigger instanceof HTMLButtonElement) {
    settingsReturnFocus.value = trigger.closest('.mobile-drawer')
      ? mobileNavigationTrigger.value
      : trigger
  }
  toolsMenuOpen.value = false
  settingsMenuOpen.value = false
  mobileDrawerOpen.value = false
  settingsPage.value = page
  settingsOpen.value = true
}

function closeSettings() {
  settingsOpen.value = false
  void nextTick(() => settingsReturnFocus.value?.focus())
}

async function openSidebarSearch(_host: HTMLElement | null) {
  createMenuOpen.value = false
  sidebarSearchOpen.value = true
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_EVENT, { detail: { section: 'groups' } }))
}

async function closeSidebarSearch(host: HTMLElement | null, clear = false, restoreFocus = false) {
  const input = host?.querySelector<HTMLInputElement>('input[type="search"]')
  if (clear && input?.value) {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  sidebarSearchOpen.value = false
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
  input?.blur()
  if (restoreFocus) {
    await nextTick()
    host?.closest('aside')?.querySelector<HTMLButtonElement>('.sidebar-search-trigger')?.focus()
  }
}

function handleSidebarInput(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.matches('input[type="search"]') && !input.value) void closeSidebarSearch(input.closest('.sidebar-context'))
}

function handleSidebarFocusout(event: FocusEvent) {
  const input = event.target as HTMLInputElement
  if (input.matches('input[type="search"]') && !input.value) void closeSidebarSearch(input.closest('.sidebar-context'))
}

function handleSidebarSearchClosed() { sidebarSearchOpen.value = false }

watch(() => route.fullPath, () => { mobileDrawerOpen.value = false; createMenuOpen.value = false; settingsMenuOpen.value = false; toolsMenuOpen.value = false; standalone.value = null })

/** Desktop menu「用配对码注册这台电脑」: the pairing field lives on the run-mode page. */
function showComputerPairing(){
  settingsMenuOpen.value = false; toolsMenuOpen.value = false; mobileDrawerOpen.value = false
  openSettings('desktop-mode')
}
onMounted(() => {
  window.addEventListener('yaoyao:computer-pairing',showComputerPairing)
  document.addEventListener('mousedown', closeMenus)
  document.addEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSidebarSearchClosed)
  document.addEventListener('keydown', workspaceKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('yaoyao:computer-pairing',showComputerPairing)
  document.removeEventListener('mousedown', closeMenus)
  document.removeEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSidebarSearchClosed)
  document.removeEventListener('keydown', workspaceKeydown)
})
</script>

<template>
  <div class="workspace-shell" :data-desktop-update-inline="desktopUpdate.supported ? '' : undefined" :class="{ 'workspace-shell--sidebar-focused': sidebarFocusMode, 'workspace-shell--conversations': true, 'workspace-shell--conversation-open': !!route.params.id }" :inert="(unreadOpen || settingsOpen || !!standalone || sidebarSearchOpen) ? true : undefined">
    <header class="mobile-header" :inert="mobileDrawerOpen">
      <button ref="mobileNavigationTrigger" class="icon-button" type="button" aria-label="打开导航" @click="openMobileDrawer">
        <AppIcon name="menu" :size="20" />
      </button>
      <button class="mobile-brand" type="button" aria-label="返回聊天" @click="navigate('/conversations')">
        <BrandMark :size="28" compact />
      </button>
      <button class="icon-button" type="button" :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="emit('toggleTheme')">
        <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
      </button>
    </header>

    <aside
      class="desktop-sidebar rail"
      aria-label="主导航"
      :inert="mobileDrawerOpen"
    >
      <div class="bot-list-header">
        <button class="bot-logo-trigger sidebar-brand" type="button" aria-label="返回 Bot 列表" title="夭夭 AI" @click="navigate('/conversations')"><BrandMark :size="32" :label="false" compact bare /></button>
        <span class="bot-list-header__spacer" />
        <button class="bot-list-toolbar-button unread-entry" type="button" :aria-label="`未读消息，${unread.total} 条`" aria-haspopup="dialog" aria-controls="unread-center" :aria-expanded="unreadOpen" title="未读消息" @click="openUnread">
          <AppIcon name="bell" :size="20" />
          <b v-if="unread.total" class="unread-entry__count" aria-hidden="true">{{ unread.total > 99 ? '99+' : unread.total }}</b>
        </button>
        <DesktopUpdateEntry v-if="desktopUpdate.supported && desktopUpdateVisible" :state="desktopUpdateState" :pending="desktopUpdatePending" :error="desktopUpdateError" @activate="desktopUpdate.run()" />
        <button class="bot-list-toolbar-button sidebar-search-trigger" type="button" aria-label="搜索" :aria-expanded="sidebarSearchOpen" @click="openSidebarSearch(desktopSidebarContext)"><AppIcon name="search" :size="21" /></button>
        <button class="bot-list-toolbar-button sidebar-create-trigger" type="button" aria-label="新建" aria-haspopup="menu" :aria-expanded="createMenuOpen" @click="openCreateMenu"><AppIcon name="plus" :size="23" /></button>
      </div>





      <section
        ref="desktopSidebarContext"
        class="sidebar-context"
        :class="{ 'sidebar-context--searching': sidebarSearchOpen }"
        @keydown.esc.capture="closeSidebarSearch(desktopSidebarContext, true, true)"
        @input.capture="handleSidebarInput"
        @focusout.capture="handleSidebarFocusout"
      >
        <slot name="sidebar-before-heading" />
        <div class="sidebar-context__body">
          <slot name="sidebar" />
        </div>
      </section>

      <div class="sidebar-footer">
        <button class="sidebar-tools-trigger" type="button" aria-haspopup="menu" :aria-expanded="toolsMenuOpen" @click="openToolsMenu"><YaoYaoSidebarIcon name="tools" :size="18" /><span>工具</span><AppIcon name="chevron-down" :size="15" /></button>
        <div class="sidebar-account-switcher">
          <button class="sidebar-account-switcher__main" type="button" :title="'当前账号'" aria-haspopup="menu" :aria-expanded="settingsMenuOpen" @click="openSettingsMenu($event)">
            <AccountInitialAvatar :name="userName" :image-url="userAvatar" :size="30" />
            <span class="account-copy">
              <strong>{{ userName }}</strong>
              <span>{{ serverName || '当前账号' }}</span>
            </span>
          </button>
        </div>
      </div>
    </aside>

    <Transition name="drawer-fade">
      <button v-if="mobileDrawerOpen" class="drawer-scrim" type="button" aria-label="关闭导航" @click="closeMobileDrawer" />
    </Transition>
    <aside
      class="mobile-drawer"
      :class="{ 'mobile-drawer--open': mobileDrawerOpen, 'mobile-drawer--focused': sidebarFocusMode }"
      aria-label="移动导航"
      :aria-hidden="!mobileDrawerOpen"
      :inert="!mobileDrawerOpen"
    >
      <div class="mobile-drawer__header">
        <button class="sidebar-brand" type="button" aria-label="返回聊天" @click="navigate('/conversations')">
          <BrandMark :size="32" compact />
        </button>
        <div class="mobile-drawer__actions"><DesktopUpdateEntry v-if="desktopUpdate.supported && desktopUpdateVisible" :state="desktopUpdateState" :pending="desktopUpdatePending" :error="desktopUpdateError" @activate="desktopUpdate.run()" /><button ref="mobileDrawerClose" class="icon-button" type="button" aria-label="关闭导航" @click="closeMobileDrawer">
          <AppIcon name="close" />
        </button><button class="sidebar-create-trigger" type="button" aria-label="新建" title="新建" aria-haspopup="menu" :aria-expanded="createMenuOpen" @click="openCreateMenu"><AppIcon name="plus" :size="19" /></button></div>
      </div>




      <section
        ref="mobileSidebarContext"
        class="sidebar-context mobile-drawer__context"
        :class="{ 'sidebar-context--searching': sidebarSearchOpen }"
        @keydown.esc.capture="closeSidebarSearch(mobileSidebarContext, true, true)"
        @input.capture="handleSidebarInput"
        @focusout.capture="handleSidebarFocusout"
      >
        <slot name="sidebar-before-heading" />
        <div class="sidebar-context__body">
          <slot name="mobile-sidebar" />
        </div>
      </section>

      <div class="sidebar-footer mobile-drawer__footer">
        <button class="sidebar-tools-trigger" type="button" aria-haspopup="menu" :aria-expanded="toolsMenuOpen" @click="openToolsMenu"><YaoYaoSidebarIcon name="tools" :size="18" /><span>工具</span><AppIcon name="chevron-down" :size="15" /></button>
        <div class="sidebar-account-switcher">
          <button class="sidebar-account-switcher__main" type="button" :title="'当前账号'" aria-haspopup="menu" :aria-expanded="settingsMenuOpen" @click="openSettingsMenu($event)">
            <AccountInitialAvatar :name="userName" :image-url="userAvatar" :size="30" />
            <span class="account-copy">
              <strong>{{ userName }}</strong>
              <span>{{ serverName || '当前账号' }}</span>
            </span>
          </button>
        </div>
      </div>
    </aside>

    <main class="workspace-main" :inert="mobileDrawerOpen">
      <slot />
    </main>

    <Transition name="inspector-slide">
      <aside v-if="inspectorOpen" class="workspace-inspector">
        <div class="workspace-inspector__close">
          <button class="icon-button" type="button" :aria-label="inspectorCloseLabel" :title="inspectorCloseLabel" @click="emit('closeInspector')">
            <AppIcon name="close" />
          </button>
        </div>
        <slot name="inspector" />
      </aside>
    </Transition>

    <AboutDialog v-if="standalone === 'about'" @close="closeStandalone" />
    <BotPluginsDialog v-if="standalone === 'plugins'" @close="closeStandalone" />
    <BotSettingsDialog v-if="standalone === 'bot-settings'" :initial-page="botSettingsPage" @close="closeStandalone" @changed="emit('botSettingsChanged')" />
    <SettingsCenterDialog
      :open="settingsOpen"
      :bot-mode="true"
      :initial-page="settingsPage"
      :user-name="userName"
      :user-avatar="userAvatar"
      :pairing-user-name="pairingUserName"
      :active-profile="activeProfile"
      :profiles="profiles"
      :theme="theme"
      :theme-preference="themePreference"
      :insecure-transport="insecureTransport"
     
      :upstream-ready="upstreamReady"
      :upstream-error="upstreamError"
      :identity-busy="identityBusy"
      :identity-error="identityError"
      :identity-reset-version="identityResetVersion"
      @close="closeSettings"
      @logout="emit('logout')"
      @select-profile="emit('selectProfile', $event)"
      @save-identity="emit('saveIdentity', $event)"
      @set-theme="emit('setTheme', $event)"
    />
    <Teleport to="body">
      <div v-if="settingsMenuOpen" class="workspace-create-dismiss" @pointerdown.self="closeSettingsMenu" @keydown.esc.prevent.stop="closeSettingsMenu">
        <div ref="settingsMenu" class="workspace-create-menu workspace-settings-menu" :style="settingsMenuPosition" role="menu" aria-label="账号菜单" @keydown="actionMenuKeydown">
          <button type="button" role="menuitem" @click="chooseSettingsAction('settings')"><AppIcon name="settings" :size="17" />我的设置</button>
          <button type="button" role="menuitem" @click="chooseSettingsAction('about')"><AppIcon name="info" :size="17" />关于</button>
          <button v-if="desktopUpdate.supported" class="desktop-update-check" type="button" role="menuitem" :disabled="desktopUpdateBusy || desktopUpdateState?.phase === 'ready'" :aria-busy="desktopUpdateBusy" @click="checkForUpdates"><AppIcon name="refresh" :size="17" />{{ desktopUpdateCheckLabel }}</button>
          <button v-else-if="canCheckUpdates" type="button" role="menuitem" :disabled="openingUpdate" :aria-busy="openingUpdate" @click="checkForUpdates"><AppIcon name="refresh" :size="17" />{{ openingUpdate ? '正在打开…' : '检测更新' }}</button>
          <p v-if="updateError" class="update-menu-error" role="alert">{{ updateError }}</p>
          <p v-if="desktopUpdate.supported && (desktopUpdateError || desktopUpdateState?.error)" class="update-menu-error" role="alert">{{ desktopUpdateError || desktopUpdateState?.error }}</p>
          <a role="menuitem" href="https://yaoyao.samien.cn" target="_blank" rel="noopener noreferrer" @click="closeSettingsMenu"><AppIcon name="external" :size="17" />帮助</a>
        </div>
      </div>
      <div v-if="toolsMenuOpen" class="workspace-create-dismiss" @pointerdown.self="closeToolsMenu" @keydown.esc.prevent.stop="closeToolsMenu"><div ref="toolsMenu" class="workspace-create-menu workspace-tools-menu" :style="toolsPosition" role="menu" aria-label="工具" @keydown="actionMenuKeydown"><button type="button" role="menuitem" @click="chooseTool('bot-settings')"><AppIcon name="settings" :size="17" />Bot 设置</button><button type="button" role="menuitem" @click="chooseTool('automations')"><AppIcon name="clock" :size="17" />自动化</button><button type="button" role="menuitem" @click="chooseTool('apps')"><AppIcon name="link" :size="17" />已连接应用</button></div></div>
      <div v-if="createMenuOpen" class="workspace-create-dismiss" @pointerdown.self="closeCreateMenu" @keydown.esc.prevent.stop="closeCreateMenu">
        <div ref="createMenu" class="workspace-create-menu" :style="createPosition" role="menu" aria-label="新建聊天" @keydown="actionMenuKeydown">
          <button type="button" role="menuitem" @click="chooseCreate('agent')"><AppIcon name="users" :size="17" />新建 Bot</button>
          <button type="button" role="menuitem" @click="chooseCreate('group')"><AppIcon name="groups" :size="17" />新建群聊</button>
        </div>
      </div>
    </Teleport>
    <UnreadPanel v-if="unreadOpen" :anchor="unreadAnchor" @close="closeUnread" />
  </div>
</template>

<style scoped>
.update-menu-error{margin:4px 10px;color:var(--danger);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.workspace-settings-menu button:disabled{opacity:.6;cursor:wait}
.sidebar-tools-trigger{display:flex;width:100%;min-height:44px;align-items:center;gap:10px;padding:8px 12px;margin:0 0 8px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);font:500 13px var(--font-ui);cursor:pointer}.sidebar-tools-trigger span{flex:1;text-align:left}.sidebar-tools-trigger:hover,.sidebar-tools-trigger[aria-expanded=true]{background:var(--surface-hover)}.sidebar-tools-trigger:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.workspace-settings-menu a{display:flex;align-items:center;gap:8px;min-height:36px;padding:8px 10px;box-sizing:border-box;border-radius:7px;color:var(--text-primary);text-decoration:none;font-size:13px}.workspace-settings-menu a:hover{background:var(--surface-hover)}.workspace-settings-menu a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.workspace-shell {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--canvas);
  transition: grid-template-columns 180ms var(--ease-out);
}

.workspace-shell--conversations { grid-template-columns: 360px minmax(0, 1fr) auto; }
.workspace-shell--collapsed { grid-template-columns: 68px minmax(0, 1fr) auto; }
.mobile-header, .mobile-drawer, .drawer-scrim { display: none; }

.desktop-sidebar {
  --sidebar-search-top: 58px;
  position: relative;
  z-index: 20;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-primary);
}

.sidebar-brand-row { display: flex; min-height: 58px; align-items: center; padding: 9px 20px 7px; }
.sidebar-brand { display: flex; min-width: 0; align-items: center; padding: 0; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
.sidebar-brand:hover { background: transparent; }
.sidebar-collapse {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.sidebar-collapse:hover { background: var(--surface-hover); color: var(--text-primary); }
.sidebar-collapse { position: absolute; top: 12px; right: 11px; transition: transform 180ms var(--ease-out), color 140ms ease, background-color 140ms ease; }
.sidebar-collapse--collapsed { transform: rotate(180deg); }

.sidebar-search-trigger,
.sidebar-feature-nav button {
  display: flex;
  width: calc(100% - 20px);
  min-height: 36px;
  align-items: center;
  gap: 11px;
  margin-inline: 10px;
  padding: 0 11px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  font-size: 14px;
  font-weight: 650;
}
.sidebar-search-trigger:hover,
.sidebar-search-trigger[aria-expanded="true"],
.sidebar-feature-nav button:hover,
.sidebar-feature-nav button.active { background: var(--surface-soft); }
.sidebar-search-trigger[aria-expanded="true"] { box-shadow: 0 0 0 3px var(--focus-ring); }
.sidebar-search-trigger--searching { visibility: hidden; pointer-events: none; }

.desktop-sidebar .sidebar-context--searching :deep(.sidebar-search),
.desktop-sidebar .sidebar-context--searching :deep(.library-search),
.mobile-drawer .sidebar-context--searching :deep(.sidebar-search),
.mobile-drawer .sidebar-context--searching :deep(.library-search) {
  position: absolute;
  z-index: 40;
  top: var(--sidebar-search-top);
  left: 10px;
  width: calc(100% - 20px);
  min-height: 36px;
  margin: 0;
  background: var(--surface);
}


.sidebar-primary-action { margin: 3px 10px; }
.sidebar-primary-action :deep(button) {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  justify-content: flex-start;
  gap: 11px;
  padding: 0 11px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  font-weight: 650;
}
.sidebar-primary-action :deep(button:hover),
.sidebar-primary-action :deep(button:focus-visible) { background: var(--surface-soft); }
.sidebar-primary-action :deep(button:focus-visible) { outline: 0; box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action :deep(button:active) { background: var(--surface-hover); }
.sidebar-primary-action :deep(button > span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sidebar-feature-nav { display: flex; flex-direction: column; gap: 1px; padding: 0 0 9px; }
.sidebar-feature-nav button { margin-block: 0; font-weight: 680; }
.sidebar-feature-nav button.active { font-weight: 740; }

.sidebar-context { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.sidebar-context__heading { display: flex; min-height: 35px; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 20px 5px 21px; }
.sidebar-context__heading strong { font-size: 13px; font-weight: 680; }
.sidebar-context__heading span { overflow: hidden; color: var(--text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-context__body { min-height: 0; flex: 1; overflow: hidden; }
.sidebar-context:not(.sidebar-context--searching) :deep(.library-search) { display: none; }
.sidebar-context__body :deep(.library-search) { margin-bottom: 10px; }
.sidebar-context__body :deep(.sidebar-list) { padding-inline: 10px; }
.sidebar-context__body :deep(.sidebar-item) { min-height: 42px; padding: 5px 9px; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--single-line) { min-height: 31px; padding: 1px 7px; }
.sidebar-context__body :deep(.sidebar-item--single-line .sidebar-item__row strong) { font-size: 14px; font-weight: 400; }
.sidebar-context__body :deep(.sidebar-item__icon) { width: 25px; height: 25px; flex-basis: 25px; border: 0; border-radius: 7px; background: transparent; }
.sidebar-context__body :deep(.sidebar-item__icon--avatar) { background: transparent; color: var(--text-secondary); }
.sidebar-context__body :deep(.sidebar-item__row strong) { font-size: 13px; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--topic .sidebar-item__row strong) { font-size: 14px; font-weight: 450; }
.sidebar-context__body :deep(.library-sidebar) { padding-top: 1px; }
.sidebar-context__body :deep(.library-sidebar section) { margin-top: 2px; }

.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-search-trigger,
.workspace-shell--sidebar-focused .desktop-sidebar > .sidebar-primary-action,
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-feature-nav,
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-footer { display: none; }
.workspace-shell--sidebar-focused { grid-template-columns: 264px minmax(0, 1fr) auto; }
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-context,
.workspace-shell--sidebar-focused .desktop-sidebar--collapsed .sidebar-context { display: flex; flex: 1; }

.sidebar-footer { flex: 0 0 auto; padding: 7px 10px 10px; background: var(--surface); }
.sidebar-account-switcher { position: relative; z-index: 30; display: flex; min-height: 46px; align-items: center; gap: 6px; padding: 4px 2px; border-top: 1px solid var(--line); }
.sidebar-account-switcher__main { display: flex; min-width: 0; min-height: 38px; flex: 1; align-items: center; gap: 9px; padding: 4px 1px; border: 0; border-radius: 8px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.sidebar-account-switcher__main:hover { background: var(--surface-soft); }
.sidebar-settings-trigger { display: grid; width: 38px; min-width: 38px; height: 38px; flex: 0 0 38px; place-items: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; }
.sidebar-settings-trigger:hover { background: var(--surface-soft); color: var(--text-primary); }
.sidebar-settings-trigger:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 3px var(--focus-ring); }
.sidebar-account__avatar { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 50%; background: transparent; color: var(--text-secondary); font-size: 13px; font-weight: 700; }
.sidebar-account-switcher__chevron { flex: 0 0 auto; color: var(--text-muted); }
.profile-menu { position: absolute; right: 0; bottom: calc(100% + 6px); left: 0; padding: 5px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
.profile-menu__heading { display: block; padding: 8px 8px 5px; color: var(--text-muted); font-size: 11px; font-weight: 650; }
.profile-menu button { display: flex; width: 100%; min-height: 38px; align-items: center; gap: 9px; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: left; }
.profile-menu button:hover, .profile-menu button.active { background: var(--surface-hover); }
.profile-menu button > span:not(.agent-avatar) { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 8px; background: var(--surface-soft); color: var(--text-secondary); font-size: 11px; }
.profile-menu button strong { flex: 1; overflow: hidden; font-size: 13px; text-overflow: ellipsis; }
.account-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.account-copy strong, .account-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-copy strong { font-size: 13px; font-weight: 650; }
.account-copy span { color: var(--text-muted); font-size: 11px; }

.desktop-sidebar--collapsed .sidebar-brand-row { padding-inline: 21px; }
.desktop-sidebar--collapsed .sidebar-brand { width: 26px; flex: 0 0 26px; overflow: hidden; }
.desktop-sidebar--collapsed .sidebar-collapse { position: static; width: 28px; height: 28px; flex: 0 0 28px; order: 1; align-self: center; margin-top: auto; margin-bottom: 5px; }
.desktop-sidebar--collapsed .sidebar-context { display: none; }
.desktop-sidebar--collapsed .sidebar-search-trigger { width: 42px; justify-content: center; margin-inline: auto; padding: 0; }
.desktop-sidebar--collapsed .sidebar-search-trigger span { display: none; }
.desktop-sidebar--collapsed .sidebar-primary-action { width: 42px; margin-inline: auto; }
.desktop-sidebar--collapsed .sidebar-primary-action :deep(button) { width: 42px; justify-content: center; padding: 0; }
.desktop-sidebar--collapsed .sidebar-primary-action :deep(button > span) { display: none; }
.desktop-sidebar--collapsed .sidebar-feature-nav { align-items: center; padding: 8px 0; }
.desktop-sidebar--collapsed .sidebar-feature-nav button { width: 42px; justify-content: center; margin-inline: 0; padding: 0; }
.desktop-sidebar--collapsed .sidebar-feature-nav button span,
.desktop-sidebar--collapsed .sidebar-account-switcher__chevron,
.desktop-sidebar--collapsed .account-copy { display: none; }
.desktop-sidebar--collapsed .sidebar-footer { display: flex; order: 2; margin-top: 0; flex-direction: column; align-items: center; padding: 0 8px 8px; }
.desktop-sidebar--collapsed .sidebar-account-switcher { width: 42px; flex-direction: column; gap: 3px; padding: 0; border-top: 0; }
.desktop-sidebar--collapsed .sidebar-account-switcher__main { width: 42px; min-height: 42px; flex: 0 0 42px; justify-content: center; padding: 0; }
.desktop-sidebar--collapsed .sidebar-settings-trigger { width: 42px; min-width: 42px; height: 42px; padding: 0; }
.desktop-sidebar--collapsed .profile-menu { right: auto; bottom: 0; left: calc(100% + 8px); width: 220px; }

.workspace-main { position: relative; display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: var(--canvas); }
.workspace-inspector { position: relative; width: min(390px, 34vw); min-width: 310px; min-height: 0; overflow: hidden; border-left: 1px solid var(--line); background: var(--surface); }
.workspace-inspector__close { position: absolute; z-index: 5; top: 10px; right: 10px; }

.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity 120ms ease, transform 120ms var(--ease-out); }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; transform: translateY(4px); }
.inspector-slide-enter-active, .inspector-slide-leave-active { overflow: hidden; transition: width 180ms var(--ease-out), opacity 150ms ease; }
.inspector-slide-enter-from, .inspector-slide-leave-to { width: 0; min-width: 0; opacity: 0; }

@media (max-width: 900px) {
  .workspace-shell, .workspace-shell--collapsed { grid-template-columns: minmax(0, 1fr); grid-template-rows: 52px minmax(0, 1fr); }
  .mobile-header { display: flex; z-index: 24; grid-row: 1; align-items: center; justify-content: space-between; padding: max(5px, env(safe-area-inset-top)) 10px 5px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(18px); }
  .mobile-brand { padding: 0; border: 0; background: transparent; cursor: pointer; }
  .desktop-sidebar { display: none; }
  .workspace-main { grid-row: 2; }
  .drawer-scrim { display: block; position: fixed; z-index: 50; inset: 0; padding: 0; border: 0; background: var(--scrim); backdrop-filter: blur(2px); }
  .mobile-drawer { --sidebar-search-top: calc(max(9px, env(safe-area-inset-top)) + 49px); display: flex; position: fixed; z-index: 51; inset: 0 auto 0 0; width: min(304px, 88vw); min-height: 0; flex-direction: column; overflow: hidden; padding: max(9px, env(safe-area-inset-top)) 0 max(9px, env(safe-area-inset-bottom)); background: var(--surface); box-shadow: var(--shadow-float); transform: translateX(-102%); transition: transform 190ms var(--ease-out); }
  .mobile-drawer--open { transform: translateX(0); }
  .mobile-drawer__header { display: flex; min-height: 49px; align-items: center; justify-content: space-between; padding: 0 14px 5px 12px; }
  .mobile-drawer__context { margin-top: 2px; }
  .mobile-drawer--focused { padding-block: max(9px, env(safe-area-inset-top)) max(9px, env(safe-area-inset-bottom)); }
  .mobile-drawer--focused > .sidebar-search-trigger,
  .mobile-drawer--focused > .sidebar-primary-action,
  .mobile-drawer--focused > .sidebar-feature-nav,
  .mobile-drawer--focused > .sidebar-footer { display: none; }
  .mobile-drawer--focused .mobile-drawer__context { margin-top: 0; flex: 1; }
  .mobile-drawer__context .sidebar-context__body :deep(.resource-sidebar) { min-height: 0; flex: 1; }
  .mobile-drawer__footer { padding-inline: 10px; }
  .workspace-inspector { position: fixed; z-index: 45; inset: 52px 0 0 auto; width: min(440px, 100vw); min-width: 0; box-shadow: var(--shadow-float); }
  .inspector-slide-enter-from, .inspector-slide-leave-to { width: min(440px, 100vw); transform: translateX(100%); }
}

.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity 160ms ease; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.sidebar-create-trigger{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;padding:0;border:0;border-radius:9px;background:transparent;color:var(--text-muted);cursor:pointer}
.sidebar-create-trigger:hover,.sidebar-create-trigger[aria-expanded="true"]{background:var(--surface-hover);color:var(--text-primary)}
.workspace-shell--conversations .desktop-sidebar:not(.desktop-sidebar--collapsed) .sidebar-collapse{right:49px}
.desktop-sidebar > .sidebar-create-trigger{position:absolute;top:12px;right:11px}
.desktop-sidebar--collapsed > .sidebar-create-trigger{position:static;width:42px;height:36px;flex-basis:36px;align-self:center;margin:0 auto 4px}
.mobile-drawer__actions{display:flex;align-items:center;gap:4px}
.workspace-create-dismiss{position:fixed;inset:0;z-index:80}
.workspace-create-menu{position:absolute;width:180px;padding:5px;border:1px solid var(--line);border-radius:11px;background:var(--surface-raised);box-shadow:var(--shadow-float)}
.workspace-create-menu button{display:flex;width:100%;min-height:36px;align-items:center;gap:9px;padding:7px 10px;border:0;border-radius:7px;background:transparent;color:var(--text-primary);font:13px var(--font-ui);text-align:left;cursor:pointer}
.workspace-create-menu button:hover,.workspace-create-menu button:focus-visible{outline:0;background:var(--surface-hover)}
@media(max-width:767px){.workspace-tools-menu button,.workspace-settings-menu button,.workspace-settings-menu a{min-height:44px}}

.bot-list-header{display:flex;align-items:center;gap:10px;padding:20px 20px 12px;min-height:74px}
.bot-list-header__spacer{flex:1}
.bot-logo-trigger{display:grid;place-items:center;padding:0;border:0;background:transparent;cursor:pointer;border-radius:50%}
.bot-list-header .bot-list-toolbar-button{position:static;display:grid;place-items:center;width:42px;height:42px;min-height:42px;flex:0 0 42px;margin:0;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--text-primary)}
.workspace-shell--conversations .sidebar-context{margin-top:0}
@media(max-width:900px){
 .workspace-shell--conversations{grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(0,1fr)}
 .workspace-shell--conversations>.mobile-header,.workspace-shell--conversations>.mobile-drawer{display:none}
 .workspace-shell--conversations>.desktop-sidebar{display:flex;grid-row:1;border:0;padding-top:env(safe-area-inset-top)}
 .workspace-shell--conversations>.workspace-main{display:none;grid-row:1}
 .workspace-shell--conversation-open>.desktop-sidebar{display:none}
 .workspace-shell--conversation-open>.workspace-main{display:flex}
}
</style>

<style scoped>
.unread-entry {
  position: relative;
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.sidebar-status-actions { position: absolute; top: 9px; right: 49px; display: flex; align-items: center; gap: 4px; }
.bot-list-header .desktop-update-entry { width: 42px; height: 42px; }
.bot-list-header .desktop-update-entry :deep(button) { border-color: var(--line); background: var(--surface); }
.bot-list-header .desktop-update-entry--ready :deep(button) { background: rgba(var(--accent-rgb), .10); }
.bot-list-header .unread-entry { position: relative; color: var(--text-secondary); }
.unread-entry:hover, .unread-entry[aria-expanded="true"], .bot-list-header .unread-entry:hover, .bot-list-header .unread-entry[aria-expanded="true"] { background: var(--surface-hover); color: var(--text-primary); }
.unread-entry:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.unread-entry__count { position: absolute; top: -3px; right: -3px; display: grid; min-width: 18px; height: 18px; place-items: center; padding: 0 4px; border: 2px solid var(--surface); border-radius: 20px; background: var(--accent); color: var(--text-on-solid); font-size: 10px; font-weight: 600; line-height: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.desktop-sidebar--collapsed .sidebar-brand-row { flex-direction: column; gap: 8px; padding: 9px 13px; }
.desktop-sidebar--collapsed .sidebar-status-actions { position: static; flex-direction: column; }
.desktop-sidebar--collapsed .unread-entry { position: relative; top: auto; right: auto; }
@media (max-width: 767px) { .sidebar-status-actions, .unread-entry, .bot-list-header .unread-entry { display: none; } }
</style>
