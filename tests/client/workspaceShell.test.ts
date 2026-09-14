import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import type { Profile } from '@shared/types'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'

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

async function mountShell(start = '/chat') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: { template: '<div></div>' } },
      { path: '/history', component: { template: '<div></div>' } },
      { path: '/conversations/automations', component: { template: '<div></div>' } },
      { path: '/conversations', component: { template: '<div></div>' } },
      { path: '/groups', component: { template: '<div></div>' } },
      { path: '/kanban', component: { template: '<div></div>' } },
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
      plugins: [router],
      stubs: {
        SettingsCenterDialog: SettingsCenterDialogStub,
        BotPluginsDialog: defineComponent({emits:['close'],template:'<div data-testid="plugins-dialog"><button @click="$emit(\'close\')">关闭已连接应用</button></div>'}),
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
  delete window.yaoyaoDesktop
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Workspace shell account controls', () => {
  it('includes the Kanban workspace in desktop and mobile navigation', async () => {
    const wrapper = await mountShell()
    expect(wrapper.get('.desktop-sidebar').text()).toContain('看板')
    expect(wrapper.get('.desktop-sidebar').text()).toContain('历史记录')
    expect(wrapper.get('.mobile-drawer').text()).toContain('看板')
    await wrapper.get('.desktop-sidebar .sidebar-feature-nav button[title="看板"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('.sidebar-context__heading').text()).toContain('看板列表'))
    expect(wrapper.get('.desktop-sidebar').find('button[aria-label="搜索"]').exists()).toBe(false)
    expect(wrapper.get('.mobile-drawer').find('button[aria-label="搜索"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps Agent switching focused and opens settings from its independent button', async () => {
    const wrapper = await mountShell()
    const desktop = wrapper.get('.desktop-sidebar')

    const agentTrigger = desktop.get('.sidebar-account-switcher__main')
    expect(agentTrigger.attributes('aria-haspopup')).toBe('listbox')
    expect(agentTrigger.attributes('aria-expanded')).toBe('false')
    await agentTrigger.trigger('click')
    expect(agentTrigger.attributes('aria-expanded')).toBe('true')
    const menu = desktop.get('.profile-menu')
    expect(menu.attributes('role')).toBe('listbox')
    expect(menu.text()).toContain('切换机器人')
    expect(menu.text()).toContain('丫头')
    expect(menu.text()).toContain('运维机器人')
    expect(menu.text()).not.toContain('机器人设置')
    expect(menu.findAll('button')).toHaveLength(profiles.length)
    expect(menu.findAll('[role="option"]').map(option => option.attributes('aria-selected'))).toEqual(['true', 'false'])
    expect(menu.text()).not.toContain('账号安全')
    expect(menu.text()).not.toContain('系统管理')
    expect(menu.text()).not.toContain('系统更新')
    expect(menu.text()).not.toContain('退出登录')

    expect(document.activeElement).toBe(menu.find('[role="option"][aria-selected="true"]').element)
    await menu.trigger('keydown', { key: 'ArrowDown' })
    const targetProfile = menu.findAll<HTMLButtonElement>('button')
      .find(button => button.text().includes('运维机器人'))!
    expect(document.activeElement).toBe(targetProfile.element)
    await targetProfile.trigger('click')
    expect(wrapper.emitted('selectProfile')).toEqual([['ops:blue/team']])
    expect(desktop.find('.profile-menu').exists()).toBe(false)

    const settingsTrigger = desktop.get<HTMLButtonElement>('.sidebar-settings-trigger')
    expect(settingsTrigger.text()).toBe('')
    expect(settingsTrigger.attributes('aria-label')).toBe('设置与模式')
    await settingsTrigger.trigger('click')
    const actions = document.querySelectorAll<HTMLButtonElement>('.workspace-settings-menu [role="menuitem"]')
    expect([...actions].map(button => button.textContent?.trim())).toEqual(['设置', '关于', '检测更新', '帮助', '进入 Bot 模式'])
    actions[0]!.click()
    await wrapper.vm.$nextTick()
    const settings = wrapper.get('[data-testid="settings-center"]')
    expect(settings.attributes('data-page')).toBe('agent-identity')
    expect(desktop.find('.profile-menu').exists()).toBe(false)

    await wrapper.get('[data-testid="close-settings"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(settingsTrigger.element)

    const mobileNavigation = wrapper.get<HTMLButtonElement>('.mobile-header button[aria-label="打开导航"]')
    await mobileNavigation.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.mobile-header').attributes()).toHaveProperty('inert')
    expect(document.activeElement).toBe(wrapper.get('.mobile-drawer button[aria-label="关闭导航"]').element)
    await wrapper.get('.mobile-drawer .sidebar-settings-trigger').trigger('click')
    document.querySelector<HTMLButtonElement>('.workspace-settings-menu [role="menuitem"]')!.click()
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="close-settings"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(mobileNavigation.element)

    expect(desktop.findAll('.sidebar-feature-nav button').map(button => button.text())).not.toContain('聊天')
    await settingsTrigger.trigger('click')
    document.querySelectorAll<HTMLButtonElement>('.workspace-settings-menu [role="menuitem"]')[4]!.click()
    await vi.waitFor(() => expect(wrapper.classes()).toContain('workspace-shell--conversations'))
    expect(document.querySelector('.workspace-settings-menu')).toBeNull()
    wrapper.unmount()
  })
})

it('uses the reference Bot list header and keeps mode changes in settings', async () => {
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
  expect(accountItems.map(item => item.textContent?.trim())).toEqual(['设置', '关于', '检测更新', '帮助', '进入聊天模式'])
  expect(document.querySelector<HTMLAnchorElement>('.workspace-settings-menu a')?.href).toBe('https://yaoyao.samien.cn/')
  accountItems[0]!.click(); await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-testid="settings-center"]').attributes('data-page')).toBe('account-security')
  await wrapper.get('[data-testid="close-settings"]').trigger('click')
  await rail.get('.sidebar-create-trigger').trigger('click')
  const items = document.querySelectorAll<HTMLButtonElement>('.workspace-create-menu [role="menuitem"]')
  expect([...items].map(item => item.textContent?.trim())).toEqual(['新建 Bot', '添加远程机器人', '新建群聊'])
  items[0]?.click()
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('createAgent')).toHaveLength(1)
  await rail.get('.sidebar-create-trigger').trigger('click')
  document.querySelectorAll<HTMLButtonElement>('.workspace-create-menu [role="menuitem"]')[1]?.click()
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('createRemoteAgent')).toHaveLength(1)
  await rail.get('.sidebar-search-trigger').trigger('click')
  document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search-close'))
  await wrapper.vm.$nextTick()
  wrapper.unmount()
})

it('shows Bot tools only in Bot mode and restores keyboard focus after closing', async () => {
  const normal = await mountShell('/chat')
  expect(normal.find('.sidebar-tools-trigger').exists()).toBe(false)
  normal.unmount()
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .sidebar-tools-trigger')
  await trigger.trigger('click')
  const menu = document.querySelector<HTMLElement>('.workspace-tools-menu')!
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(items.map(b => b.textContent?.trim())).toEqual(['自动化', '已连接应用'])
  expect(document.activeElement).toBe(items[0])
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(items[1])
  items[1]!.click(); await wrapper.vm.$nextTick()
  await flushPromises()
  expect(wrapper.find('[data-testid="settings-center"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="plugins-dialog"]').exists()).toBe(true)
  await wrapper.get('[data-testid="plugins-dialog"] button').trigger('click'); await wrapper.vm.$nextTick()
  expect(document.activeElement).toBe(trigger.element)
  wrapper.unmount()
})


it.each(['/chat', '/history', '/conversations', '/kanban', '/files'])('opens an independent About dialog from the menu in %s', async path => {
  const wrapper = await mountShell(path)
  const trigger = wrapper.get<HTMLButtonElement>(path === '/conversations' ? '.desktop-sidebar .sidebar-account-switcher__main' : '.desktop-sidebar .sidebar-settings-trigger')
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


it('checks Web updates from the Bot account menu and preserves focus through update settings', async () => {
  const wrapper = await mountShell('/conversations')
  const trigger = wrapper.get<HTMLButtonElement>('.desktop-sidebar .sidebar-account-switcher__main')
  await trigger.trigger('click')
  ;[...document.querySelectorAll<HTMLButtonElement>('.workspace-settings-menu button')].find(b => b.textContent?.trim() === '检测更新')!.click()
  await flushPromises()
  expect(wrapper.find('[data-testid="update-dialog"]').exists()).toBe(true)
  await wrapper.get('[data-testid="update-dialog"] button:nth-child(2)').trigger('click')
  expect(wrapper.get('[data-testid="settings-center"]').attributes('data-page')).toBe('system-update')
  await wrapper.get('[data-testid="close-settings"]').trigger('click')
  await flushPromises()
  expect(document.activeElement).toBe(trigger.element)
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

it('does not expose server update controls to a non-admin browser account', async () => {
  const wrapper = await mountShell('/conversations')
  await wrapper.setProps({ isAdmin: false })
  await wrapper.get('.desktop-sidebar .sidebar-account-switcher__main').trigger('click')
  expect(document.querySelector('.workspace-settings-menu')?.textContent).not.toContain('检测更新')
  wrapper.unmount()
})
