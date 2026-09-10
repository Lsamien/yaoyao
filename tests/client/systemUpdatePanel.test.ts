import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SystemUpdatePanel from '@/components/app/SystemUpdatePanel.vue'

const api = vi.hoisted(() => ({
  applySystemUpdate: vi.fn(),
  checkSystemUpdate: vi.fn(),
  rollbackSystemUpdate: vi.fn(),
  systemUpdateJob: vi.fn(),
  systemUpdateStatus: vi.fn(),
}))

vi.mock('@/api/systemUpdate', () => api)

const manifest = {
  schemaVersion: 1 as const,
  releaseVersion: '0.2.17',
  webVersion: '0.2.17',
  pluginVersion: '1.7.3',
  gitTag: 'v0.2.17',
}

const activeJob = {
  id: 'job-1',
  operation: 'update' as const,
  state: 'verifying' as const,
  message: '正在验证',
  createdAt: '2026-08-29T00:00:00Z',
  updatedAt: '2026-08-29T00:00:01Z',
}
const doneJob = { ...activeJob, state: 'succeeded' as const, message: '更新完成' }
const readyStatus = {
  current: manifest,
  installedPluginVersion: '1.7.3',
  versionsMatch: true,
  installationMode: 'release' as const,
  latest: manifest,
  updateAvailable: false,
  supported: true,
  canRollback: true,
}

beforeEach(() => {
  vi.useFakeTimers()
  api.systemUpdateStatus.mockReset()
  api.checkSystemUpdate.mockReset()
  api.systemUpdateJob.mockReset()
  api.applySystemUpdate.mockReset()
  api.rollbackSystemUpdate.mockReset()
  api.systemUpdateStatus.mockResolvedValue(readyStatus)
  api.checkSystemUpdate.mockResolvedValue(readyStatus)
  api.systemUpdateJob.mockResolvedValue(doneJob)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SystemUpdatePanel', () => {
  it('hides a previous successful update that does not match the running Web version', async () => {
    const old = { ...doneJob, target: { ...manifest, webVersion: '0.1.0', releaseVersion: '0.1.0' }, message: '已升级 Web 0.1.0' }
    api.systemUpdateStatus.mockResolvedValue({ ...readyStatus, job: old })
    api.checkSystemUpdate.mockResolvedValue({ ...readyStatus, job: old })
    const wrapper = mount(SystemUpdatePanel, { global: { stubs: { AppIcon: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain(manifest.webVersion)
    expect(wrapper.text()).not.toContain('已升级 Web 0.1.0')
    expect(wrapper.text()).toContain('回滚上一版本')
    wrapper.unmount()
  })
  it('clears a finished job when refreshed status no longer includes it', async () => {
    api.systemUpdateStatus.mockResolvedValue({ ...readyStatus, job: { ...doneJob, target: manifest } })
    const wrapper = mount(SystemUpdatePanel, { global: { stubs: { AppIcon: true } } })
    await flushPromises()
    expect(wrapper.find('.update-progress').exists()).toBe(false)
    wrapper.unmount()
  })
  it('shows GitHub failures without claiming the installed version is latest', async () => {
    api.systemUpdateStatus.mockResolvedValue({ ...readyStatus, releaseSource: 'https://github.com/Lsamien/yaoyao.git', releasePageUrl: 'https://github.com/Lsamien/yaoyao/releases' })
    api.checkSystemUpdate.mockRejectedValue(new Error('GitHub 请求受限，请稍后重试'))
    const wrapper = mount(SystemUpdatePanel, { global: { stubs: { AppIcon: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('GitHub 请求受限')
    expect(wrapper.text()).not.toContain('已是最新版本')
    expect(wrapper.get('.solid-button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('a').attributes('href')).toBe('https://github.com/Lsamien/yaoyao/releases')
    wrapper.unmount()
  })
  it('allows Web updates with unknown plugin state and explains the offline boundary', async () => {
    const offlineStatus = { ...readyStatus, installedPluginVersion: undefined, versionsMatch: false, updateAvailable: true,
      latest: { ...manifest, releaseVersion: '0.3.0', webVersion: '0.3.0', gitTag: 'v0.3.0' } }
    api.systemUpdateStatus.mockResolvedValue(offlineStatus)
    api.checkSystemUpdate.mockResolvedValue(offlineStatus)
    api.applySystemUpdate.mockResolvedValue(doneJob)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(SystemUpdatePanel, { global: { stubs: { AppIcon: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('查看 Web 版本、检查更新或回滚到上一个版本')
    expect(wrapper.text()).not.toContain('当前插件')
    expect(wrapper.find('.version-warning').exists()).toBe(false)
    const apply = wrapper.find<HTMLButtonElement>('.solid-button')
    expect(apply.element.disabled).toBe(false)
    await apply.trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledWith('将 Web 升级到 0.3.0？')
    expect(api.applySystemUpdate).toHaveBeenCalledWith('0.3.0')
    expect(wrapper.text()).toContain('更新完成')
    wrapper.unmount()
  })

  it('resumes polling an existing non-terminal job and releases the settings lock', async () => {
    api.systemUpdateStatus
      .mockResolvedValueOnce({ ...readyStatus, job: activeJob })
      .mockResolvedValueOnce({ ...readyStatus, job: doneJob })
    const wrapper = mount(SystemUpdatePanel, {
      props: { active: true },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()
    expect(wrapper.emitted('lock-change')?.some(event => event[0] === true)).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(api.systemUpdateJob).toHaveBeenCalledWith('job-1')
    expect(wrapper.text()).toContain('更新完成')
    expect(wrapper.emitted('lock-change')?.at(-1)).toEqual([false])
    expect(api.checkSystemUpdate).not.toHaveBeenCalled()
  })

  it('locks while an update mutation is starting and ignores a stale response after deactivation', async () => {
    const updateAvailable = {
      ...readyStatus,
      latest: { ...manifest, releaseVersion: '0.2.18', webVersion: '0.2.18', gitTag: 'v0.2.18' },
      updateAvailable: true,
    }
    api.systemUpdateStatus.mockResolvedValue(updateAvailable)
    api.checkSystemUpdate.mockResolvedValue(updateAvailable)
    let resolveApply: ((job: typeof activeJob) => void) | undefined
    api.applySystemUpdate.mockReturnValue(new Promise(resolve => { resolveApply = resolve }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(SystemUpdatePanel, {
      props: { active: true },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()

    const apply = wrapper.findAll<HTMLButtonElement>('button').find(button => button.text().includes('升级 Web'))!
    await apply.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('lock-change')?.at(-1)).toEqual([true])
    const check = wrapper.findAll<HTMLButtonElement>('button').find(button => button.text().includes('检查更新'))!
    expect(check.element.disabled).toBe(true)

    await wrapper.setProps({ active: false })
    resolveApply?.(activeJob)
    await flushPromises()
    expect(api.systemUpdateJob).not.toHaveBeenCalled()
    expect(wrapper.emitted('lock-change')?.at(-1)).toEqual([false])
  })
})
