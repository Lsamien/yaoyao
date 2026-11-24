import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import type { Profile } from '@shared/types'
import SettingsCenterDialog from '@/components/app/SettingsCenterDialog.vue'

const profiles: Profile[] = [
  { name: 'ops:blue/team', agentName: '运维机器人', isDefault: false },
  { name: 'default', agentName: '丫头', isDefault: true },
]

function simpleStub(name: string, testId: string) {
  return defineComponent({ name, template: `<div data-testid="${testId}"></div>` })
}

const ModelServicesPanelStub = defineComponent({
  name: 'ModelServicesPanel',
  props: { profile: { type: String, required: true } },
  emits: ['dirty-change'],
  template: '<div data-testid="model-services" :data-profile="profile"><button data-testid="dirty-model" type="button" @click="$emit(\'dirty-change\', true)">dirty</button></div>',
})

const childStubs = {
  Teleport: true,
  AgentAvatar: true,
  AppIcon: true,
  AgentIdentityPanel: simpleStub('AgentIdentityPanel', 'agent-identity'),
  ModelServicesPanel: ModelServicesPanelStub,
  AccountSecurityPanel: defineComponent({
    name: 'AccountSecurityPanel',
    emits: ['dirty-change'],
    template: '<div data-testid="account-security"><button data-testid="dirty-account" type="button" @click="$emit(\'dirty-change\', true)">dirty</button></div>',
  }),
  CredentialVaultPanel: simpleStub('CredentialVaultPanel', 'credential-vault'),
  NodePairingPanel: simpleStub('NodePairingPanel', 'node-pairing'),
}

function mountSettings(overrides: Record<string, unknown> = {}) {
  return mount(SettingsCenterDialog, {
    attachTo: document.body,
    props: {
      open: true,
      activeProfile: profiles[0],
      profiles,
      userName: '管理员',
      pairingUserName: 'owner',
      isAdmin: true,
      ...overrides,
    } as never,
    global: { stubs: childStubs },
  })
}

function navigationButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll<HTMLButtonElement>('.settings-sidebar nav button')
    .find(candidate => candidate.text().includes(label))
  expect(button, `missing navigation button: ${label}`).toBeDefined()
  return button!
}

afterEach(() => {
  delete window.yaoyaoDesktop
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

describe('Settings center dialog', () => {
  it('describes vault management as belonging to the signed-in account', () => {
    const wrapper=mountSettings({botMode:true,initialPage:'credential-vault'})
    expect(wrapper.get('.settings-content__heading').text()).toContain('当前账号：owner')
    expect(wrapper.get('.settings-content__heading').text()).not.toContain('全局设置')
    expect(wrapper.find('[data-testid=credential-vault]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('keeps desktop runtime controls out of a browser', () => {
    const wrapper = mountSettings({ initialPage: 'desktop-mode' })
    expect(wrapper.findAll('.settings-sidebar nav button').map(button => button.text())).not.toContain('运行模式')
    expect(wrapper.find('[aria-label="服务器与客户端模式"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lets a signed-in member switch this desktop from client to server without logging out', async () => {
    let mode: 'client' | 'server' = 'client'
    const switchMode = vi.fn(async (next: 'client' | 'server') => { mode = next; return { ok: true } })
    Object.defineProperty(window, 'yaoyaoDesktop', { configurable: true, value: {
      modeState: vi.fn(async () => ({ mode, serverURL: 'http://fixture:15300', switching: false })),
      switchMode,
      openRemoteLogin: vi.fn(async () => {}),
    } })
    const wrapper = mountSettings({ isAdmin: false, botMode: true, initialPage: 'desktop-mode' })
    await flushPromises()
    expect(navigationButton(wrapper, '运行模式').attributes('aria-current')).toBe('page')
    expect(wrapper.text()).toContain('当前：客户端模式')
    await wrapper.get('input[value="server"]').setValue()
    expect(switchMode).not.toHaveBeenCalled()
    await wrapper.get('.mode-primary').trigger('click')
    await flushPromises()
    expect(switchMode).toHaveBeenCalledWith('server')
    expect(wrapper.text()).toContain('当前：服务器模式')
    expect(wrapper.emitted('logout')).toBeUndefined()
    wrapper.unmount()
  })

  it('preserves the current mode on a failed switch and can reopen server login', async () => {
    const openRemoteLogin = vi.fn(async () => {})
    Object.defineProperty(window, 'yaoyaoDesktop', { configurable: true, value: {
      modeState: vi.fn(async () => ({ mode: 'server', serverURL: 'http://127.0.0.1:15300', switching: false })),
      switchMode: vi.fn(async () => ({ ok: false, error: '连接失败，请重试。' })), openRemoteLogin,
    } })
    const wrapper = mountSettings({ initialPage: 'desktop-mode' })
    await flushPromises()
    await wrapper.get('input[value="client"]').setValue()
    await wrapper.get('.mode-primary').trigger('click'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('连接失败')
    expect(wrapper.text()).toContain('当前：服务器模式')
    await wrapper.findAll('.mode-actions button').find(button => button.text() === '更换服务器…')!.trigger('click')
    await flushPromises()
    expect(openRemoteLogin).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('弹出的窗口')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it.each(['agent-identity', 'agent-models'])('keeps %s and the Profile selector out of Bot-mode personal settings', initialPage => {
    const wrapper = mountSettings({ botMode: true, initialPage })
    expect(wrapper.findAll('.settings-sidebar nav h3').map(heading => heading.text())).toEqual(['个人', '管理'])
    expect(wrapper.find('.settings-agent-selector').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-identity"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-services"]').exists()).toBe(false)
    expect(wrapper.get('.settings-content__header').text()).toContain('账号资料')
    wrapper.unmount()
  })
  it('shows theme previews and filters settings without changing account scope', async () => {
    const wrapper = mountSettings({initialPage:'appearance',themePreference:'light'})
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('我的设置')
    expect(wrapper.findAll('.theme-options img')).toHaveLength(3)
    await wrapper.findAll('[role="radio"]').find(button=>button.text()==='深色')!.trigger('click')
    expect(wrapper.emitted('set-theme')).toEqual([['dark']])
    await wrapper.get('input[aria-label="搜索设置"]').setValue('模型')
    expect(wrapper.findAll('.settings-sidebar nav button').map(button=>button.text())).toEqual(['管理后台'])
    wrapper.unmount()
  })
  it.each([false, true])('keeps independent tools and About outside settings (Bot mode=%s)', botMode => {
    const wrapper = mountSettings({ botMode, initialPage: 'bot-plugins' })
    const labels = wrapper.findAll('.settings-sidebar nav button').map(button => button.text())
    for (const label of ['插件', '已连接应用', '自动化', '关于', '本地虚拟机']) expect(labels).not.toContain(label)
    expect(wrapper.find('[data-testid="bot-plugins"]').exists()).toBe(false)
    expect(wrapper.find('.bot-about').exists()).toBe(false)
    wrapper.unmount()
  })
  it('groups administrator pages and routes account, voice, and system content to the right scope', async () => {
    const wrapper = mountSettings()

    // Bot mode only: base Profile identity and models live in each Bot's profile.
    expect(wrapper.findAll('.settings-sidebar nav h3').map(heading => heading.text())).toEqual([
      '个人',
      '管理',
    ])
    expect(wrapper.get('.settings-sidebar nav').text()).not.toContain('模型与 Provider')
    expect(wrapper.get('.settings-sidebar nav').text()).not.toContain('身份与头像')

    await navigationButton(wrapper, '登录与安全').trigger('click')
    expect(wrapper.find('.settings-agent-selector').exists()).toBe(false)
    expect(wrapper.get('.settings-content__header').text()).toContain('当前账号：owner')

    // Management moved to the separate admin console; the Web only points there.
    const consoleButton = navigationButton(wrapper, '管理后台')
    expect(consoleButton.element.closest('section')?.textContent).toContain('管理')
    await consoleButton.trigger('click')
    expect(wrapper.get('.admin-console-notice').text()).toContain('系统设置已移到管理后台')
    expect(wrapper.get('.admin-console-notice').text()).toContain('127.0.0.1:15301')
    for (const label of ['系统概览', '模型服务', '用户与权限', '消息推送', '双流语音', '更新与回滚']) expect(wrapper.get('.settings-sidebar nav').text()).not.toContain(label)
  })

  it('hides the admin console pointer from non-admin users', () => {
    const wrapper = mountSettings({ isAdmin: false, initialPage: 'system-console' })
    const navigation = wrapper.get('.settings-sidebar nav')

    expect(navigation.findAll('h3').map(heading => heading.text())).toEqual(['个人'])
    expect(navigation.text()).not.toContain('模型与 Provider')
    expect(navigation.text()).not.toContain('系统概览')
    expect(navigation.text()).not.toContain('双流语音')
    expect(navigation.text()).not.toContain('管理后台')
    expect(wrapper.find('.admin-console-notice').exists()).toBe(false)
    expect(wrapper.get('.settings-content__header').text()).toContain('账号资料')
  })

  it('asks before discarding an edited page and keeps the current page when declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const wrapper = mountSettings({ initialPage: 'account-security' })
    await wrapper.get('[data-testid="dirty-account"]').trigger('click')

    await navigationButton(wrapper, '外观').trigger('click')
    expect(confirm).toHaveBeenCalledWith('放弃当前页面未保存的更改？')
    expect(wrapper.get('.settings-content__header').text()).toContain('登录与安全')

    await navigationButton(wrapper, '外观').trigger('click')
    expect(wrapper.find('.appearance-panel').exists()).toBe(true)
  })

  it('protects unsaved drafts from silent close', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const voiceWrapper = mountSettings({ initialPage: 'account-security' })
    await voiceWrapper.get('[data-testid="dirty-account"]').trigger('click')
    await voiceWrapper.get('.settings-center__close').trigger('click')
    expect(confirm).toHaveBeenCalledWith('放弃当前页面未保存的更改？')
    expect(voiceWrapper.emitted('close')).toBeUndefined()
  })

  it('moves mobile focus into details and back to the active category', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const wrapper = mountSettings()
    const profile = navigationButton(wrapper, '账号资料')
    await profile.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.settings-content__header h3').element)

    await wrapper.get('.mobile-back').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(profile.element)

    const security = navigationButton(wrapper, '登录与安全')
    await security.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.settings-content__header h3').element)

    await wrapper.get('.mobile-back').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(security.element)
  })

})
