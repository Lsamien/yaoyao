import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import HostToolsPanel from '@/components/app/HostToolsPanel.vue'
import { apiRequest } from '@/api/client'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
const request = vi.mocked(apiRequest)
const endpoint = '/api/app/admin/desktop-hosts'
const firstId = '1a111111-1111-4111-8111-111111111111'
const secondId = '2b222222-2222-4222-8222-222222222222'
let hosts: { id: string; name: string; displayName: string; enabled: boolean; online: boolean; createdAt: number }[]

beforeEach(() => {
  request.mockReset()
  hosts = [
    { id: firstId, name: '同名电脑', displayName: '', enabled: true, online: false, createdAt: 1_700_000_000_000 },
    { id: secondId, name: '同名电脑', displayName: '', enabled: true, online: true, createdAt: 1_710_000_000_000 },
    { id: 'disabled-host', name: '已停用电脑', displayName: '', enabled: false, online: false, createdAt: 1 },
  ]
  request.mockImplementation(async (path, options) => {
    if (path === endpoint) return { hosts: structuredClone(hosts), localName: '' } as never
    if (path === '/api/app/settings/host-tools') return { approvalPolicy: 'allow', scriptMachine: true, serverComputer: true, vm: true, cloud: true } as never
    const host = hosts.find(item => path === `${endpoint}/${item.id}/name` || path === `${endpoint}/${item.id}`)
    if (host && options?.method === 'PUT') host.displayName = (options.body as { name: string }).name
    else if (host && options?.method === 'DELETE') host.enabled = false
    else throw new Error(`Unexpected request: ${path}`)
    return { ok: true } as never
  })
})

it('edits the shared transfer limit and blocks invalid values with an inline error', async () => {
  const wrapper = mount(HostToolsPanel)
  await flushPromises()
  const input = wrapper.get<HTMLInputElement>('#file-transfer-limit')
  expect(input.element.value).toBe('25')
  for (const invalid of ['0', '101', '1.5', '']) {
    await input.setValue(invalid)
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#file-transfer-error').text()).toContain('1–100')
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
  }
  await input.setValue('100')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(request).toHaveBeenCalledWith('/api/app/settings/host-tools', { method: 'PUT', body: expect.objectContaining({ fileTransferMaxMiB: 100 }) })
  wrapper.unmount()
})

it('keeps managed browsing opt-in and saves it independently of virtual machines', async () => {
  const wrapper = mount(HostToolsPanel)
  try {
    await flushPromises()
    const browser = wrapper.findAll('label.toggle').find(label => label.text().includes('托管浏览器'))!.get<HTMLInputElement>('input')
    expect(browser.element.checked).toBe(false)
    const vm = wrapper.findAll('label.toggle').find(label => label.text().includes('虚拟环境'))!.get<HTMLInputElement>('input')
    await vm.setValue(false)
    await browser.setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/app/settings/host-tools', { method: 'PUT', body: expect.objectContaining({ managedBrowser: true, vm: false }) })
  } finally { wrapper.unmount() }
})

it('distinguishes same-name registrations by status, ID and pairing time without merging them', async () => {
  const wrapper = mount(HostToolsPanel)
  await flushPromises()
  expect(wrapper.findAll('.computer')).toHaveLength(3)
  const first = wrapper.get(`[data-host-id="${firstId}"]`)
  const second = wrapper.get(`[data-host-id="${secondId}"]`)
  expect(first.text()).toContain('未连接')
  expect(second.text()).toContain('已连接')
  expect(first.text()).toContain('编号 1a111111')
  expect(second.text()).toContain('编号 2b222222')
  expect(first.text()).toContain('配对于')
  expect(wrapper.text()).toContain('有同名的配对记录')
  expect(wrapper.text()).not.toContain('已停用电脑')
  expect(wrapper.get('[data-host-id="local"]').find('.remove-host').exists()).toBe(false)
  expect(request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  wrapper.unmount()
})

it('only disables the explicitly confirmed registration, even when names match', async () => {
  const wrapper = mount(HostToolsPanel)
  await flushPromises()
  const first = wrapper.get(`[data-host-id="${firstId}"]`)
  await first.get('.remove-host').trigger('click')
  expect(request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  await first.get('.remove-confirmation .remove-host').trigger('click')
  await flushPromises()
  expect(request).toHaveBeenCalledWith(`${endpoint}/${firstId}`, { method: 'DELETE' })
  expect(wrapper.find(`[data-host-id="${firstId}"]`).exists()).toBe(false)
  expect(wrapper.find(`[data-host-id="${secondId}"]`).exists()).toBe(true)
  expect(wrapper.text()).toContain('这条配对记录已停用')
  wrapper.unmount()
})

it('keeps the record and shows an error when disabling fails', async () => {
  const wrapper = mount(HostToolsPanel)
  await flushPromises()
  request.mockRejectedValueOnce(new Error('服务暂时不可用'))
  const first = wrapper.get(`[data-host-id="${firstId}"]`)
  await first.get('.remove-host').trigger('click')
  await first.get('.remove-confirmation .remove-host').trigger('click')
  await flushPromises()
  expect(wrapper.find(`[data-host-id="${firstId}"]`).exists()).toBe(true)
  expect(wrapper.get('[role="alert"]').text()).toContain('服务暂时不可用')
  wrapper.unmount()
})

it('renames by registration ID and preserves another computer’s unsaved name', async () => {
  const wrapper = mount(HostToolsPanel)
  await flushPromises()
  const first = wrapper.get(`[data-host-id="${firstId}"]`)
  const second = wrapper.get(`[data-host-id="${secondId}"]`)
  await first.get('input').setValue('旧电脑')
  await second.get('input').setValue('新电脑')
  await first.get('.name-editor button').trigger('click')
  await flushPromises()
  expect(request).toHaveBeenCalledWith(`${endpoint}/${firstId}/name`, { method: 'PUT', body: { name: '旧电脑' } })
  expect(second.get<HTMLInputElement>('input').element.value).toBe('新电脑')
  hosts[1]!.online = false
  await wrapper.get('.names-heading button').trigger('click')
  await flushPromises()
  expect(second.text()).toContain('未连接')
  expect(second.get<HTMLInputElement>('input').element.value).toBe('新电脑')
  wrapper.unmount()
})
