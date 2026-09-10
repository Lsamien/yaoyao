import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BotPluginsPanel from '@/components/workspace/BotPluginsPanel.vue'
import { apiRequest } from '@/api/client'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
let failInventory = false, canManage = true
const plugin = { id: 'plugin-1', name: '现有插件', transport: 'http', url: 'https://mcp.example.test', envKeys: [], headerKeys: ['Authorization'], agentIds: [], enabled: false, revision: 2, toolCount: 1, testedAt: 1 }
beforeEach(() => {
  failInventory = false; canManage = true
  vi.mocked(apiRequest).mockReset().mockImplementation(async (path, options) => {
    if (options?.method && options.method !== 'GET') return {} as never
    if (path.endsWith('/settings')) return { configured: true, revision: 1, canManageMcp: canManage } as never
    if (path.endsWith('/mcp')) return { plugins: [plugin], canManage } as never
    if (path.endsWith('/apps/catalog')) return { cards: [{ slug: 'gmail', name: 'Gmail', description: '邮件' }] } as never
    if (path.endsWith('/apps')) {
      if (failInventory) throw new Error('暂时无法读取连接状态')
      return { authoritative: true, connections: [{ slug: 'gmail', accounts: [{ id: 'account-1', alias: '工作账号', status: 'ACTIVE' }], agentIds: [], revision: 0 }] } as never
    }
    return { agents: [] } as never
  })
})
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
const render = (connectedOnly = false) => mount(BotPluginsPanel, { attachTo: document.body, props: { connectedOnly }, global: { stubs: { AppIcon: true } } })
function button(wrapper: ReturnType<typeof render>, text: string) { return wrapper.findAll('button').find(b => b.text() === text)! }

it('retains connected accounts on failed refresh instead of presenting them as disconnected', async () => {
  const wrapper = render(true); await flushPromises()
  expect(wrapper.text()).toContain('工作账号')
  failInventory = true
  await wrapper.get('[aria-label="刷新应用连接"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法读取连接状态')
  expect(wrapper.text()).toContain('工作账号')
  expect(button(wrapper, '添加账号').exists()).toBe(true)
  wrapper.unmount()
})
it('keeps secret placeholders and invalid form input without submitting a broken configuration', async () => {
  const wrapper = render(); await flushPromises()
  await button(wrapper, 'MCP 服务').trigger('click')
  await button(wrapper, '编辑').trigger('click')
  const headers = wrapper.get<HTMLTextAreaElement>('.plugin-editor textarea')
  expect(JSON.parse(headers.element.value)).toEqual({ Authorization: true })
  await headers.setValue('{bad json')
  await wrapper.get('form[aria-label="MCP 服务配置"]').trigger('submit'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('有效 JSON')
  expect(headers.element.value).toBe('{bad json')
  expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([true])
  wrapper.unmount()
})
it('disables host MCP management for non-admin accounts', async () => {
  canManage = false
  const wrapper = render(); await flushPromises()
  await button(wrapper, 'MCP 服务').trigger('click')
  expect(button(wrapper, '添加服务').attributes('disabled')).toBeDefined()
  expect(button(wrapper, '测试连接').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
