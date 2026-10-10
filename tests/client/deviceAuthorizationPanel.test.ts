import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DeviceAuthorizationPanel from '../../src/client/components/app/DeviceAuthorizationPanel.vue'
import { apiRequest } from '../../src/client/api/client'

vi.mock('../../src/client/api/client', () => ({ apiRequest: vi.fn() }))
const permissions = { supported: true, authorized: false, screen: false, accessibility: false, ready: false, fullAuthorized: false }
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.mocked(apiRequest).mockResolvedValue({ hosts: [
    { id: 'local', name: '服务器', online: true, platform: 'darwin', local: permissions },
    { id: 'current', name: '我的电脑', online: true, platform: 'darwin', local: permissions },
    { id: 'other', name: '另一台电脑', online: true, platform: 'win32', local: { ...permissions, fullAuthorized: true } },
    { id: 'offline', name: '离线电脑', online: false, platform: '', local: permissions },
  ] })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; delete window.yaoyaoDesktop; vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['current', 'local'])('authorizes only the native current device %s while showing other devices read-only', async current => {
  const authorize = vi.fn().mockResolvedValue({ ok: true })
  window.yaoyaoDesktop = { deviceHost: async () => ({ deviceHost: current }), authorizeCurrentDevice: authorize } as any
  wrapper = mount(DeviceAuthorizationPanel)
  await flushPromises()
  const active = wrapper.get(`[data-host-id="${current}"]`)
  expect(active.text()).toContain('当前设备')
  expect(active.findAll('button')).toHaveLength(2)
  for (const id of ['local', 'current', 'other', 'offline'].filter(id => id !== current)) {
    expect(wrapper.get(`[data-host-id="${id}"]`).findAll('button')).toHaveLength(0)
  }
  expect(wrapper.get('[data-host-id="other"]').text()).toContain('已授权')
  expect(wrapper.get('[data-host-id="offline"]').text()).toContain('连接后更新授权状态')
  await active.findAll('button')[1].trigger('click'); await flushPromises()
  expect(authorize).toHaveBeenCalledExactlyOnceWith('full')
  expect(vi.mocked(apiRequest).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it.each([undefined, { deviceHost: async () => ({ deviceHost: 'current' }) }])('keeps browser and old client devices read-only', async desktop => {
  window.yaoyaoDesktop = desktop as any
  wrapper = mount(DeviceAuthorizationPanel); await flushPromises()
  expect(wrapper.findAll('article button')).toHaveLength(0)
  expect(wrapper.findAll('article')).toHaveLength(4)
})

it('keeps authorization failure visible for retry without claiming success', async () => {
  window.yaoyaoDesktop = { deviceHost: async () => ({ deviceHost: 'current' }), authorizeCurrentDevice: vi.fn().mockRejectedValue(new Error('本机控制授权已取消')) } as any
  wrapper = mount(DeviceAuthorizationPanel); await flushPromises()
  await wrapper.get('[data-host-id="current"] button').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('已取消')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(wrapper.get('[data-host-id="current"] button').attributes('disabled')).toBeUndefined()
})
