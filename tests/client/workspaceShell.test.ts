import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { useUnreadStore } from '@/stores/unread'
import type { Profile } from '@shared/types'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import type { DesktopUpdateState } from '@shared/desktopUpdate'

const profiles: Profile[] = [
  { name: 'default', agentName: '丫头', isDefault: true },
  { name: 'ops:blue/team', agentName: '运维机器人', isDefault: false },
]

const SettingsCenterDialogStub = defineComponent({
  name: 'SettingsCenterDialog',
  emits: ['close'],
  props: {
    open: Boolean,
    initialPage: String,
  },
  template: '<div v-if="open" data-testid="settings-center" :data-page="initialPage"><button data-testid="close-settings" type="button" @click="$emit(\'close\')">close</button></div>',
})

async function mountShell(start = '/conversations') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: { template: '<div></div>' } },
      { path: '/history', component: { template: '<div></div>' } },
      { path: '/conversations/automations', component: { template: '<div></div>' } },
      { path: '/conversations', component: { template: '<div></div>' } },
      { path: '/groups', component: { template: '<div></div>' } },
      { path: '/files', component: { template: '<div></div>' } },
    ],
  })
  await router.push(start)
  await router.isReady()
  return mount(WorkspaceShell, {
    attachTo: document.body,
    props: {
      activeProfile: profiles[0],
      profiles,
      userName: 'owner',
      pairingUserName: 'owner',
      isAdmin: true,
      sidebarTitle: '历史记录',
    },
    global: {
      plugins: [router, createPinia()],
      stubs: {
        SettingsCenterDialog: SettingsCenterDialogStub,
        BotPluginsDialog: defineComponent({emits:['close'],template:'<div data-testid="plugins-dialog"><button @click="$emit(\'close\')">关闭已连接应用</button></div>'}),
        BotSettingsDialog: defineComponent({props:['initialPage','isAdmin'],emits:['close'],template:'<div data-testid="bot-settings-dialog" :data-page="initialPage"><button @click="$emit(\'close\')">关闭 Bot 设置</button></div>'}),
        UpdateCheckDialog: defineComponent({emits:['close', 'manage'],template:'<div data-testid="update-dialog"><button @click="$emit(\'close\')">关闭检测更新</button><button @click="$emit(\'manage\')">前往更新</button></div>'}),
        AboutDialog: defineComponent({emits:['close'],template:'<div data-testid="about-dialog"><button @click="$emit(\'close\')">关闭关于</button></div>'}),
        AgentAvatar: true,
        AppIcon: true,
        BrandMark: true,
        YaoYaoSidebarIcon: true,
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  useUnreadStore().reset()
  delete window.yaoyaoDesktop
})

afterEach(() => {
  document.body.innerHTML = ''
})


it('uses the reference Bot list header and offers no interface mode switch', async () => {
  const wrapper = await mountShell('/conversations')
  const rail = wrapper.get('.desktop-sidebar')
  expect(wrapper.find('.sidebar-settings-trigger').exists()).toBe(false)
  expect(rail.find('.sidebar-feature-nav').exists()).toBe(false)
  expect(rail.find('.sidebar-primary-action').exists()).toBe(false)
  expect(rail.find('.sidebar-footer').exists()).toBe(true)
  expect(rail.get('.sidebar-account-switcher__main').text()).toContain('owner')
  expect(rail.get('.account-initial-avatar').text()).toBe('O')
  expect(rail.find('.sidebar-account-switcher__main .agent-avatar').exists()).toBe(false)
  expect(rail.find('.bot-logo-trigger').exists()).toBe(true)
  expect(rail.find('.bot-account-trigger').exists()).toBe(false)
  expect(rail.find('.sidebar-collapse').exists()).toBe(false)
  expect(rail.find('.sidebar-context__heading').exists()).toBe(false)
  await rail.get('.sidebar-account-switcher__main').trigger('click')
  const accountItems = [...document.querySelectorAll<HTMLElement>('.workspace-settings-menu [role="menuitem"]')]
  // Web updates are applied from the admin console; the browser menu has no update check.
  expect(accountItems.map(item => item.textContent?.trim())).toEqual(['我的设置', '关于', '帮助'])
  expect(document.querySelector<HTMLAnchorElement>('.workspace-settings-menu a')?.href).toBe('https://yaoyao.samien.cn/')
  accountItems[0]!.click(); await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-testid="settings-center"]').attributes('data-page')).toBe('account-profile')
  await wrapper.get('[data-testid="close-settings"]').trigger('click')
  await rail.get('.sidebar-create-trigger').trigger('click')
  const items = document.querySelectorAll<HTMLButtonElement>('.workspace-create-menu [role="menuitem"]')
  expect([...items].map(item => item.textContent?.trim())).toEqual(['新建 Bot', '新建群聊'])
  items[0]?.click()
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('createAgent')).toHaveLength(1)
  await rail.get('.sidebar-create-trigger').trigger('click')
  document.querySelectorAll<HTMLButtonElement>('.workspace-create-menu [role="menuitem"]')[1]?.click()
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('createGroup')).toHaveLength(1)
  expect(wrapper.emitted('createRemoteAgent')).toBeUndefined()
  await rail.get('.sidebar-search-trigger').trigger('click')
  document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search-close'))
  await wrapper.vm.$nextTick()
  wrapper.unmount()
})

it('shows Bot tools and restores keyboard focus after closing', async () => {
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .sidebar-tools-trigger')
  await trigger.trigger('click')
  const menu = document.querySelector<HTMLElement>('.workspace-tools-menu')!
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(items.map(b => b.textContent?.trim())).toEqual(['Bot 设置', '自动化', '已连接应用'])
  expect(document.activeElement).toBe(items[0])
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(items[1])
  items[2]!.click(); await wrapper.vm.$nextTick()
  await flushPromises()
  expect(wrapper.find('[data-testid="settings-center"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="plugins-dialog"]').exists()).toBe(true)
  await wrapper.get('[data-testid="plugins-dialog"] button').trigger('click'); await wrapper.vm.$nextTick()
  expect(document.activeElement).toBe(trigger.element)
  wrapper.unmount()
})

it('opens dedicated Bot settings from tools and points the VM shortcut at the admin console', async () => {
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .sidebar-tools-trigger')
  await trigger.trigger('click')
  ;[...document.querySelectorAll<HTMLButtonElement>('.workspace-tools-menu button')].find(b => b.textContent?.trim() === 'Bot 设置')!.click()
  await flushPromises()
  expect(wrapper.get('[data-testid="bot-settings-dialog"]').attributes('data-page')).toBe('projects')
  expect(wrapper.find('[data-testid="settings-center"]').exists()).toBe(false)
  await wrapper.get('[data-testid="bot-settings-dialog"] button').trigger('click')
  expect(document.activeElement).toBe(trigger.element)
  window.dispatchEvent(new Event('yaoyao:local-vm-settings'))
  await flushPromises()
  expect(wrapper.find('[data-testid="bot-settings-dialog"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="settings-center"]').attributes('data-page')).toBe('system-console')
  wrapper.unmount()
})


it('opens an independent About dialog from the account menu', async () => {
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .sidebar-account-switcher__main')
  await trigger.trigger('click')
  const item = [...document.querySelectorAll<HTMLButtonElement>('.workspace-settings-menu button')].find(b => b.textContent?.trim() === '关于')!
  item.click(); await flushPromises()
  expect(wrapper.find('[data-testid="about-dialog"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="settings-center"]').exists()).toBe(false)
  await wrapper.get('[data-testid="about-dialog"] button').trigger('click'); await flushPromises()
  expect(document.activeElement).toBe(trigger.element)
  wrapper.unmount()
})

it('navigates to the independent automation route without opening settings', async () => {
  const wrapper = await mountShell('/conversations')
  await wrapper.get('.desktop-sidebar .sidebar-tools-trigger').trigger('click')
  const item = [...document.querySelectorAll<HTMLButtonElement>('.workspace-tools-menu button')].find(b => b.textContent?.trim() === '自动化')!
  item.click(); await flushPromises()
  expect(wrapper.vm.$router.currentRoute.value.path).toBe('/conversations/automations')
  expect(wrapper.find('[data-testid="settings-center"]').exists()).toBe(false)
  wrapper.unmount()
})


it('opens the native updater, prevents duplicate clicks and lets a failed opening retry', async () => {
  const openUpdates = vi.fn().mockRejectedValueOnce(new Error('窗口打开失败')).mockResolvedValueOnce(undefined)
  window.yaoyaoDesktop = { openUpdates, openComputer: vi.fn(), computerClosed: vi.fn(), onComputerClose: vi.fn() }
  const wrapper = await mountShell('/conversations')
  await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
  const item = [...document.querySelectorAll<HTMLButtonElement>('.workspace-settings-menu button')].find(b => b.textContent?.trim() === '检测更新')!
  item.click(); item.click()
  await flushPromises()
  expect(openUpdates).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('窗口打开失败')
  item.click(); await flushPromises()
  expect(openUpdates).toHaveBeenCalledTimes(2)
  expect(document.querySelector('.workspace-settings-menu')).toBeNull()
  expect(wrapper.find('[data-testid="update-dialog"]').exists()).toBe(false)
  wrapper.unmount()
})

it('keeps desktop downloads and restart beside the bell', async () => {
  vi.useFakeTimers()
  let state: DesktopUpdateState = { phase: 'checked', installMode: 'restart', currentVersion: '0.4.80', latestVersion: '0.4.81', available: true, received: 0, total: 100, message: '发现更新' }
  let finish!: (state: DesktopUpdateState) => void
  const openUpdates = vi.fn()
  const updateAction = vi.fn().mockImplementation(action => {
    if (action === 'download') {
      state = { ...state, phase: 'downloading', received: 42 }
      return new Promise<DesktopUpdateState>(resolve => { finish = resolve })
    }
    state = { ...state, phase: 'installing' }
    return Promise.resolve(state)
  })
  window.yaoyaoDesktop = { updateState: vi.fn(async () => state), updateAction, openUpdates, openComputer: vi.fn(), computerClosed: vi.fn(), onComputerClose: vi.fn() }
  const wrapper = await mountShell('/conversations')
  try {
    await wrapper.setProps({ isAdmin: false })
    await flushPromises()
    const entry = () => wrapper.get('.desktop-sidebar .desktop-update-entry')
    expect(entry().text()).toBe('可更新')
    expect(entry().element.previousElementSibling?.classList.contains('unread-entry')).toBe(true)
    expect(wrapper.find('.sidebar-footer .desktop-update-entry').exists()).toBe(false)
    await entry().get('button').trigger('click')
    await entry().get('button').trigger('click')
    await flushPromises()
    expect(updateAction).toHaveBeenCalledExactlyOnceWith('download')
    expect(entry().get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
    await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
    expect(document.querySelector('.workspace-settings-menu .desktop-update-entry')).toBeNull()
    expect(document.querySelector('.desktop-update-check')?.hasAttribute('disabled')).toBe(true)
    expect(entry().get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
    state = { ...state, phase: 'preparing', received: 100 }
    await vi.advanceTimersByTimeAsync(500)
    expect(entry().text()).toContain('正在准备…')
    expect(entry().get('button').attributes()).toHaveProperty('disabled')
    await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
    state = { ...state, phase: 'ready', available: false }
    finish(state); await flushPromises()
    expect(entry().text()).toBe('重新启动')
    expect(entry().classes()).toContain('desktop-update-entry--ready')
    expect(entry().get('button').attributes('title')).toContain('点击重新启动')
    expect(updateAction).toHaveBeenCalledTimes(1)
    await entry().get('button').trigger('click'); await flushPromises()
    expect(updateAction).toHaveBeenLastCalledWith('install')
    expect(openUpdates).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="update-dialog"]').exists()).toBe(false)
  } finally { wrapper.unmount(); vi.useRealTimers() }
})

it('hides the toolbar update icon when no update exists, including manual checks and errors', async () => {
  vi.useFakeTimers()
  const checked: DesktopUpdateState = { phase: 'checked', installMode: 'restart', currentVersion: '0.4.80', available: false, received: 0, total: 0, message: '已是最新版本' }
  let state: DesktopUpdateState = { ...checked, phase: 'idle' }
  let requested!: () => void
  const updateAction = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce(checked)
  window.yaoyaoDesktop = { updateState: vi.fn(async () => state), updateAction, onUpdateRequested: callback => { requested = callback; return () => {} }, openComputer: vi.fn(), computerClosed: vi.fn(), onComputerClose: vi.fn() }
  const wrapper = await mountShell('/conversations')
  try {
    await flushPromises()
    expect(wrapper.find('.desktop-update-entry').exists()).toBe(false)
    state = { ...checked, phase: 'checking' }; requested(); await flushPromises()
    expect(wrapper.find('.desktop-update-entry').exists()).toBe(false)
    state = checked; await vi.advanceTimersByTimeAsync(500)
    expect(wrapper.find('.desktop-update-entry').exists()).toBe(false)
    await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
    const button = () => document.querySelector<HTMLButtonElement>('.desktop-update-check')!
    button().click(); button().click(); await flushPromises()
    expect(updateAction).toHaveBeenCalledExactlyOnceWith('check')
    expect(document.querySelector('.workspace-settings-menu [role="alert"]')?.textContent).toBe('连接失败')
    expect(wrapper.find('.desktop-update-entry').exists()).toBe(false)
    button().click(); await flushPromises()
    expect(button().textContent).toContain('已是最新版本')
    expect(document.querySelector('.workspace-settings-menu')).not.toBeNull()
    expect(document.querySelector('.workspace-settings-menu [role="alert"]')).toBeNull()
    expect(wrapper.find('.desktop-update-entry').exists()).toBe(false)
  } finally { wrapper.unmount(); vi.useRealTimers() }
})

it('does not expose server update controls to a non-admin browser account', async () => {
  const wrapper = await mountShell('/conversations')
  await wrapper.setProps({ isAdmin: false })
  await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
  expect(document.querySelector('.workspace-settings-menu')?.textContent).not.toContain('检测更新')
  wrapper.unmount()
})

it('opens the unread center beside the sidebar and restores focus after Escape', async () => {
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .unread-entry')
  vi.spyOn(trigger.element, 'getBoundingClientRect').mockReturnValue({ top: 86 } as DOMRect)
  vi.spyOn(wrapper.get('.desktop-sidebar').element, 'getBoundingClientRect').mockReturnValue({ right: 360 } as DOMRect)
  await trigger.trigger('click')
  expect(trigger.attributes('aria-expanded')).toBe('true')
  expect(wrapper.attributes()).toHaveProperty('inert')
  const panel = document.querySelector<HTMLElement>('#unread-center')!
  expect(panel).not.toBeNull()
  expect(document.activeElement).toBe(panel)
  expect(panel.parentElement?.style.getPropertyValue('--unread-left')).toBe('372px')
  expect(panel.parentElement?.style.getPropertyValue('--unread-top')).toBe('86px')
  await new DOMWrapper(panel).trigger('keydown', { key: 'Escape' })
  await flushPromises()
  expect(document.querySelector('#unread-center')).toBeNull()
  expect(wrapper.attributes()).not.toHaveProperty('inert')
  expect(document.activeElement).toBe(trigger.element)
  wrapper.unmount()
})
