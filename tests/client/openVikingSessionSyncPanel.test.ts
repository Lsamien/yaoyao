import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import OpenVikingSessionSyncPanel from '@/components/app/OpenVikingSessionSyncPanel.vue'
import { apiRequest } from '@/api/client'
vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
it('shows failures, retries them, and stops polling when closed', async () => {
  vi.useFakeTimers()
  vi.mocked(apiRequest).mockResolvedValue({ enabled: true, pending: 2, complete: 3, failed: 1, lastError: 'offline' })
  const wrapper = mount(OpenVikingSessionSyncPanel); await flushPromises()
  expect(wrapper.text()).toContain('待同步 2 · 已完成 3 · 失败 1')
  expect(wrapper.get('[role=alert]').text()).toBe('offline')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/admin/openviking/session-sync/retry', { method: 'POST', body: {} })
  wrapper.unmount(); const count = vi.mocked(apiRequest).mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(apiRequest).toHaveBeenCalledTimes(count)
})
