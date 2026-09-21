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

const DuplexVoicePanelStub = defineComponent({
  name: 'DuplexVoicePanel',
  emits: ['dirty-change'],
  template: '<div data-testid="duplex-voice"><button data-testid="dirty-voice" type="button" @click="$emit(\'dirty-change\', true)">dirty</button></div>',
})

const SystemUpdatePanelStub = defineComponent({
  name: 'SystemUpdatePanel',
  emits: ['lock-change'],
  template: `
    <div data-testid="system-update">
      <button data-testid="lock-update" type="button" @click="$emit('lock-change', true)">lock</button>
      <button data-testid="unlock-update" type="button" @click="$emit('lock-change', false)">unlock</button>
    </div>
  `,
})

const childStubs = {
  Teleport: true,
  AgentAvatar: true,
  AppIcon: true,
  AgentIdentityPanel: simpleStub('AgentIdentityPanel', 'agent-identity'),
  ModelServicesPanel: ModelServicesPanelStub,
  AccountSecurityPanel: simpleStub('AccountSecurityPanel', 'account-security'),
  NodePairingPanel: simpleStub('NodePairingPanel', 'node-pairing'),
  SystemOverviewPanel: simpleStub('SystemOverviewPanel', 'system-overview'),
  SystemManagementPanel: simpleStub('SystemManagementPanel', 'system-management'),
  DuplexVoicePanel: DuplexVoicePanelStub,
  SystemUpdatePanel: SystemUpdatePanelStub,
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
    await wrapper.get('input[aria-label="搜索设置"]').setValue('Hermes')
    expect(wrapper.findAll('.settings-sidebar nav button').map(button=>button.text())).toEqual(['Hermes 连接'])
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
  it('groups administrator pages and routes Agent, voice, and system content to the right scope', async () => {
    const wrapper = mountSettings()

    expect(wrapper.findAll('.settings-sidebar nav h3').map(heading => heading.text())).toEqual([
      '个人',
      '管理',
      '基础机器人',
    ])

    await navigationButton(wrapper, '模型与 Provider').trigger('click')
    expect(navigationButton(wrapper, '模型与 Provider').attributes('aria-current')).toBe('page')
    const modelPanel = wrapper.get('[data-testid="model-services"]')
    expect(modelPanel.attributes('data-profile')).toBe('ops:blue/team')
    expect(wrapper.get('.settings-content__header').text()).toContain('正在设置：运维机器人 / ops:blue/team')

    await navigationButton(wrapper, '登录与安全').trigger('click')
    expect(wrapper.find('.settings-agent-selector').exists()).toBe(false)
    expect(wrapper.get('.settings-content__header').text()).toContain('当前账号：owner')

    const voiceButton = navigationButton(wrapper, '双流语音')
    expect(voiceButton.text()).toContain('全局')
    expect(voiceButton.element.closest('section')?.textContent).toContain('管理')
    await voiceButton.trigger('click')
    expect(wrapper.find('[data-testid="duplex-voice"]').exists()).toBe(true)
    expect(wrapper.get('.settings-content__header').text()).toContain('全局设置 · 仅管理员')
  })

  it('hides model management and the complete system group from non-admin users', () => {
    const wrapper = mountSettings({ isAdmin: false, initialPage: 'system-update' })
    const navigation = wrapper.get('.settings-sidebar nav')

    expect(navigation.findAll('h3').map(heading => heading.text())).toEqual(['个人'])
    expect(navigation.text()).not.toContain('模型与 Provider')
    expect(navigation.text()).not.toContain('管理')
    expect(navigation.text()).not.toContain('系统概览')
    expect(navigation.text()).not.toContain('双流语音')
    expect(navigation.text()).not.toContain('更新与回滚')
    expect(wrapper.find('[data-testid="system-update"]').exists()).toBe(false)
    expect(wrapper.get('.settings-content__header').text()).toContain('账号资料')
  })

  it('blocks closing and page changes while the update panel reports a lock', async () => {
    const wrapper = mountSettings({ initialPage: 'system-update' })
    expect(wrapper.find('[data-testid="system-update"]').exists()).toBe(true)

    await wrapper.get('[data-testid="lock-update"]').trigger('click')
    expect(wrapper.get<HTMLButtonElement>('.settings-center__close').element.disabled).toBe(true)

    await navigationButton(wrapper, '登录与安全').trigger('click')
    await wrapper.get('.settings-center-layer').trigger('mousedown')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('.settings-content__header').text()).toContain('更新与回滚')
    expect(wrapper.find('[data-testid="account-security"]').exists()).toBe(false)

    await wrapper.get('[data-testid="unlock-update"]').trigger('click')
    await navigationButton(wrapper, '登录与安全').trigger('click')
    expect(wrapper.find('[data-testid="account-security"]').exists()).toBe(true)
  })

  it('asks before discarding an edited page and keeps the current page when declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const wrapper = mountSettings()
    wrapper.findComponent({ name: 'AgentIdentityPanel' }).vm.$emit('dirty-change', true)
    await wrapper.vm.$nextTick()

    await navigationButton(wrapper, '登录与安全').trigger('click')
    expect(confirm).toHaveBeenCalledWith('放弃当前页面未保存的更改？')
    expect(wrapper.get('.settings-content__header').text()).toContain('身份与头像')

    await navigationButton(wrapper, '登录与安全').trigger('click')
    expect(wrapper.find('[data-testid="account-security"]').exists()).toBe(true)
  })

  it('protects Provider and global voice drafts from silent navigation or close', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const modelWrapper = mountSettings({ initialPage: 'agent-models' })
    await modelWrapper.get('[data-testid="dirty-model"]').trigger('click')
    await navigationButton(modelWrapper, '登录与安全').trigger('click')
    expect(confirm).toHaveBeenCalledWith('放弃当前页面未保存的更改？')
    expect(modelWrapper.find('[data-testid="model-services"]').exists()).toBe(true)
    modelWrapper.unmount()

    confirm.mockClear()
    const voiceWrapper = mountSettings({ initialPage: 'system-voice' })
    await voiceWrapper.get('[data-testid="dirty-voice"]').trigger('click')
    await voiceWrapper.get('.settings-center__close').trigger('click')
    expect(confirm).toHaveBeenCalledWith('放弃当前页面未保存的更改？')
    expect(voiceWrapper.emitted('close')).toBeUndefined()
  })

  it('moves mobile focus into details and back to the active category', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const wrapper = mountSettings()
    const identity = navigationButton(wrapper, '身份与头像')
    await identity.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.settings-content__header h3').element)

    await wrapper.get('.mobile-back').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(identity.element)

    const security = navigationButton(wrapper, '登录与安全')
    await security.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('.settings-content__header h3').element)

    await wrapper.get('.mobile-back').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(security.element)
  })

  it('supports listbox keyboard navigation for the Agent selector', async () => {
    const wrapper = mountSettings()
    const trigger = wrapper.get('.settings-agent-selector > button')
    expect(trigger.attributes('aria-haspopup')).toBe('listbox')
    await trigger.trigger('click')
    await wrapper.vm.$nextTick()
    const menu = wrapper.get('.settings-agent-menu')
    const options = menu.findAll<HTMLButtonElement>('[role="option"]')
    expect(document.activeElement).toBe(options[0]!.element)

    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1]!.element)
  })
})
