import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import SystemManagementDialog from '@/components/app/SystemManagementDialog.vue'
import { getUpstreamConnectionStatus, listUsers } from '@/api/admin'
import { getPushSystemStatus, saveFCMPushSystemConfig, savePushSystemConfig, type PushSystemStatus } from '@/api/push'

vi.mock('@/api/admin', () => ({
  createUser: vi.fn(async () => undefined),
  deleteUser: vi.fn(async () => undefined),
  getAllowedHostsSettings: vi.fn(async () => ({
    source: 'none', hosts: [], editableHosts: [], environmentHosts: [],
  })),
  getUpstreamConnectionStatus: vi.fn(async () => ({
    endpoint: 'http://127.0.0.1:9119', authMode: 'loopback-token', networkScope: 'local',
    webNetworkScope: 'network', ready: true, lastVerifiedAt: 1_788_273_600_000,
  })),
  listUsers: vi.fn(async () => []),
  saveAllowedHostsSettings: vi.fn(async (hosts: string[]) => ({
    source: 'file', hosts, editableHosts: hosts, environmentHosts: [],
  })),
  setUpstreamCredentials: vi.fn(async () => undefined),
  updateUser: vi.fn(async () => undefined),
}))

vi.mock('@/api/push', () => ({
  getPushSystemStatus: vi.fn(),
  saveFCMPushSystemConfig: vi.fn(),
  savePushSystemConfig: vi.fn(),
}))

function pushStatus(overrides: Partial<PushSystemStatus> = {}): PushSystemStatus {
  return {
    configured: false,
    healthy: false,
    topic: 'cn.samien.yaoyao.hermes',
    registrationCount: 0,
    pendingCount: 0,
    source: 'none',
    editable: true,
    managementAvailable: true,
    environments: ['development', 'production'],
    warnings: [],
    ...overrides,
  }
}

async function mountOpen(): Promise<VueWrapper> {
  const wrapper = mount(SystemManagementDialog, {
    attachTo: document.body,
    props: { open: false },
    global: { stubs: { AppIcon: true, HermesBridgePanel: true } },
  })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

function input(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
}

function enter(name: string, value: string) {
  const element = input(name)
  element.value = value
  element.dispatchEvent(new Event('input'))
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(label))
}

beforeEach(() => {
  vi.mocked(listUsers).mockResolvedValue([])
  vi.mocked(getPushSystemStatus).mockResolvedValue(pushStatus())
  vi.mocked(savePushSystemConfig).mockResolvedValue(pushStatus({ configured: true, healthy: true, source: 'file' }))
  vi.mocked(saveFCMPushSystemConfig).mockResolvedValue(pushStatus())
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('System management APNs configuration', () => {
  it('shows automatic loopback authentication and separate 15300/9119 network boundaries', async () => {
    const wrapper = await mountOpen()

    expect(document.body.textContent).toContain('本机 Session Token（自动）')
    expect(document.body.textContent).toContain('http://127.0.0.1:9119')
    expect(document.body.textContent).toContain('局域网可访问')
    expect(document.body.textContent).toContain('9119 网络范围')
    expect(document.body.textContent).toContain('仅本机')
    expect(input('upstream-username')).toBeNull()
    expect(document.body.textContent).toContain('Token 不会在设置中显示')
    wrapper.unmount()
  })

  it('shows credential controls when 9119 requires password authentication', async () => {
    vi.mocked(getUpstreamConnectionStatus).mockResolvedValueOnce({
      endpoint: 'https://hermes.example.test', authMode: 'password', networkScope: 'network',
      webNetworkScope: 'network', ready: false, error: '9119 服务账号验证失败',
    })
    const wrapper = await mountOpen()

    expect(document.body.textContent).toContain('用户名和密码')
    expect(document.body.textContent).toContain('9119 服务账号验证失败')
    expect(input('upstream-username')).not.toBeNull()
    expect(input('upstream-password')).not.toBeNull()
    expect(button('验证并保存')).not.toBeUndefined()
    wrapper.unmount()
  })

  it('includes the target username in every row action accessible name', async () => {
    vi.mocked(listUsers).mockResolvedValueOnce([{
      id: 'user-1',
      username: 'member',
      role: 'user',
      enabled: true,
      mustChangePassword: false,
      createdAt: 1,
      updatedAt: 1,
    }])
    const wrapper = await mountOpen()

    expect(document.querySelector('[aria-label="为用户 member 重置密码"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="禁用用户 member"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="删除用户 member"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('validates and saves an FCM service-account path without exposing secret contents', async () => {
    const fcm = {
      configured: false,
      healthy: false,
      registrationCount: 0,
      pendingCount: 0,
      source: 'none' as const,
      editable: true,
      managementAvailable: true,
      packageName: 'cn.samien.yaoyao.hermes',
      warnings: [],
    }
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({ providers: { fcm } }))
    vi.mocked(saveFCMPushSystemConfig).mockResolvedValueOnce(pushStatus({
      providers: { fcm: { ...fcm, configured: true, healthy: true, source: 'file' } },
    }))
    const wrapper = await mountOpen()

    enter('fcm-service-account-file', '  /srv/secrets/firebase-service-account.json  ')
    enter('fcm-project-id', ' yaoyao-test-project ')
    enter('fcm-package-name', ' cn.samien.yaoyao.hermes ')
    await nextTick()
    const form = input('fcm-service-account-file').closest('form')!
    form.dispatchEvent(new Event('submit'))
    await flushPromises()

    expect(saveFCMPushSystemConfig).toHaveBeenCalledWith({
      serviceAccountFile: '/srv/secrets/firebase-service-account.json',
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    })
    expect(document.body.textContent).toContain('Firebase 权限与项目验证通过，FCM 已启用')
    expect(document.body.textContent).toContain('FCM 推送服务正常')
    wrapper.unmount()
  })

  it('sends a server-local path and both environments through validation and enablement', async () => {
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({ environments: [] }))
    vi.mocked(savePushSystemConfig).mockResolvedValueOnce(pushStatus({
      configured: true,
      healthy: true,
      source: 'file',
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      warnings: [{
        code: 'apns_key_permissions',
        message: 'APNs 已启用，但密钥文件权限为 0644；建议调整为 0600，此提示不会影响当前推送。',
        actualMode: '0644',
        recommendedMode: '0600',
      }],
    }))
    const wrapper = await mountOpen()

    enter('push-key-file', '  /srv/secrets/AuthKey_TEST.p8  ')
    enter('push-key-id', ' KEY123 ')
    enter('push-team-id', ' TEAM123 ')
    enter('push-topic', ' cn.samien.yaoyao.hermes ')
    await nextTick()
    const save = button('验证并启用')!
    expect(save.disabled).toBe(false)
    save.click()
    await flushPromises()

    expect(savePushSystemConfig).toHaveBeenCalledWith({
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      topic: 'cn.samien.yaoyao.hermes',
      environments: ['development', 'production'],
    })
    expect(document.body.textContent).toContain('Sandbox 与 Production 验证通过，APNs 已启用')
    expect(document.querySelector('.push-warning')?.textContent).toContain('权限为 0644')
    expect(button('验证并启用')?.disabled).toBe(false)
    wrapper.unmount()
  })

  it('shows environment-managed configuration as read-only', async () => {
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({
      configured: true,
      healthy: true,
      source: 'environment',
      editable: false,
      keyFile: '/Users/test/.hermes/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
    }))
    const wrapper = await mountOpen()

    expect(document.body.textContent).toContain('由服务环境变量管理，Web 仅可查看')
    expect(input('push-key-file').readOnly).toBe(true)
    expect(document.querySelector<HTMLFieldSetElement>('.push-config-form fieldset')?.disabled).toBe(true)
    expect(button('验证并启用')).toBeUndefined()
    document.querySelector<HTMLFormElement>('.push-config-form')!.dispatchEvent(new Event('submit'))
    await nextTick()
    expect(savePushSystemConfig).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('surfaces an invalid startup configuration instead of calling it unconfigured', async () => {
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({
      configured: false,
      healthy: false,
      source: 'environment',
      editable: false,
      lastError: 'APNs key file must contain an ES256 private key',
    }))
    const wrapper = await mountOpen()

    expect(document.body.textContent).toContain('APNs 配置无效：APNs key file must contain an ES256 private key')
    wrapper.unmount()
  })

  it('keeps an old status-only response safe and does not expose editing controls', async () => {
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({
      configured: true,
      healthy: true,
      managementAvailable: false,
      editable: false,
    }))
    const wrapper = await mountOpen()

    expect(document.body.textContent).toContain('APNs 推送服务正常')
    expect(document.body.textContent).toContain('当前服务版本只提供推送状态')
    expect(document.querySelector('.push-config-form')).toBeNull()
    expect(savePushSystemConfig).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rejects an empty environment set locally and preserves input after a server error', async () => {
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({
      source: 'file',
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      environments: ['development'],
    }))
    const wrapper = await mountOpen()
    const development = document.querySelector<HTMLInputElement>('input[type="checkbox"][value="development"]')!
    development.checked = false
    development.dispatchEvent(new Event('change'))
    await nextTick()
    document.querySelector<HTMLFormElement>('.push-config-form')!.dispatchEvent(new Event('submit'))
    await nextTick()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('至少选择 Sandbox 或 Production')
    expect(savePushSystemConfig).not.toHaveBeenCalled()

    development.checked = true
    development.dispatchEvent(new Event('change'))
    await nextTick()
    vi.mocked(savePushSystemConfig).mockRejectedValueOnce(new Error('15300 无法读取该密钥文件，请检查路径和服务账户权限'))
    button('验证并启用')!.click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('15300 无法读取该密钥文件')
    expect(input('push-key-file').value).toBe('/srv/secrets/AuthKey_TEST.p8')
    wrapper.unmount()
  })

  it('preserves an unsaved FCM draft while APNs is saved and locks the sibling form during the request', async () => {
    const fcm = {
      configured: true,
      healthy: true,
      registrationCount: 0,
      pendingCount: 0,
      source: 'file' as const,
      editable: true,
      managementAvailable: true,
      serviceAccountFile: '/srv/secrets/firebase.json',
      projectId: 'server-project',
      packageName: 'cn.samien.yaoyao.hermes',
      warnings: [],
    }
    vi.mocked(getPushSystemStatus).mockResolvedValueOnce(pushStatus({
      source: 'file',
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      providers: { fcm },
    }))
    let resolveSave: ((status: PushSystemStatus) => void) | undefined
    vi.mocked(savePushSystemConfig).mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve }))
    const wrapper = await mountOpen()
    enter('fcm-project-id', 'local-unsaved-project')
    await nextTick()

    button('验证并启用')!.click()
    await nextTick()
    expect(input('fcm-project-id').readOnly).toBe(true)
    resolveSave?.(pushStatus({
      configured: true,
      healthy: true,
      source: 'file',
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      providers: { fcm: { ...fcm, projectId: 'server-response-project' } },
    }))
    await flushPromises()

    expect(input('fcm-project-id').value).toBe('local-unsaved-project')
    expect(input('fcm-project-id').readOnly).toBe(false)
    wrapper.unmount()
  })
})
