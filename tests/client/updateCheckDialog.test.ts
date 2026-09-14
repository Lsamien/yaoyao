import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import UpdateCheckDialog from '@/components/app/UpdateCheckDialog.vue'
import { checkSystemUpdate, systemUpdateStatus, type SystemUpdateStatus } from '@/api/systemUpdate'

vi.mock('@/api/systemUpdate', () => ({ checkSystemUpdate: vi.fn(), systemUpdateStatus: vi.fn() }))
const current = { schemaVersion: 1 as const, webVersion: '0.4.17', releaseVersion: '0.4.17', gitTag: 'v0.4.17' }
const status: SystemUpdateStatus = { current, latest: current, updateAvailable: false, installationMode: 'source', supported: true, canRollback: false }
const render = () => mount(UpdateCheckDialog, { global: { stubs: { StandaloneDialog: { template: '<div><slot /></div>' }, AppIcon: true } } })
beforeEach(() => { vi.mocked(systemUpdateStatus).mockResolvedValue(status); vi.mocked(checkSystemUpdate).mockResolvedValue(status) })
afterEach(() => vi.resetAllMocks())

it('checks immediately, keeps the installed version visible and disables repeat checks until finished', async () => {
  let finish!: (value: SystemUpdateStatus) => void
  vi.mocked(checkSystemUpdate).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const wrapper = render()
  await flushPromises()
  expect(wrapper.text()).toContain('正在检测更新')
  expect(wrapper.text()).toContain('0.4.17')
  expect(wrapper.get('button').attributes()).toHaveProperty('disabled')
  finish(status); await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe('当前已是最新版本')
  expect(checkSystemUpdate).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('shows a new version and opens update management only on request', async () => {
  vi.mocked(checkSystemUpdate).mockResolvedValue({ ...status, latest: { ...current, webVersion: '0.4.18' }, updateAvailable: true, releasePageUrl: 'https://github.com/Lsamien/yaoyao/releases/tag/v0.4.18' })
  const wrapper = render(); await flushPromises()
  expect(wrapper.text()).toContain('发现新版本 0.4.18')
  expect(wrapper.get('a').attributes('href')).toContain('/releases/tag/v0.4.18')
  expect(wrapper.emitted('manage')).toBeUndefined()
  await wrapper.findAll('button')[1]!.trigger('click')
  expect(wrapper.emitted('manage')).toHaveLength(1)
  wrapper.unmount()
})

it('reports failed checks without claiming the cached version is latest and supports retry', async () => {
  vi.mocked(checkSystemUpdate).mockRejectedValueOnce(new Error('无法连接 GitHub'))
  const wrapper = render(); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('无法连接 GitHub')
  expect(wrapper.text()).not.toContain('已是最新')
  expect(wrapper.text()).toContain('未获取')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('当前已是最新版本')
  wrapper.unmount()
})

it('explains externally managed installations without offering an unsupported update', async () => {
  vi.mocked(checkSystemUpdate).mockResolvedValue({ ...status, latest: { ...current, webVersion: '0.4.18' }, updateAvailable: true, supported: false, unsupportedReason: '请使用 Docker Compose 更新', releasePageUrl: 'javascript:alert(1)' })
  const wrapper = render(); await flushPromises()
  expect(wrapper.text()).toContain('请使用 Docker Compose 更新')
  expect(wrapper.text()).not.toContain('前往更新')
  expect(wrapper.find('a').exists()).toBe(false)
  wrapper.unmount()
})
