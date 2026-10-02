import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ToolTrace from '@/components/messages/ToolTrace.vue'
import { apiRequest } from '@/api/client'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
afterEach(() => vi.clearAllMocks())

it('fetches tool details only when expanded, reuses them, and loads a new revision without showing stale output', async () => {
  vi.mocked(apiRequest).mockResolvedValue({ input: 'input', output: 'complete output' })
  const tool = { id: 'tool', name: 'read', status: 'success' as const, detailsUrl: '/api/app/tool?revision=1' }
  const wrapper = mount(ToolTrace, { props: { tool } })
  expect(apiRequest).not.toHaveBeenCalled()
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(apiRequest).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).toContain('complete output')
  await wrapper.get('button').trigger('click'); await wrapper.get('button').trigger('click'); await flushPromises()
  expect(apiRequest).toHaveBeenCalledTimes(1)
  vi.mocked(apiRequest).mockResolvedValue({ output: 'new revision' })
  await wrapper.setProps({ tool: { ...tool, detailsUrl: '/api/app/tool?revision=2' } }); await flushPromises()
  expect(apiRequest).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain('new revision')
  expect(wrapper.text()).not.toContain('complete output')
  wrapper.unmount()
})
