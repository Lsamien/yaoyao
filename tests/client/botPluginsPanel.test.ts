import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BotPluginsPanel from '@/components/workspace/BotPluginsPanel.vue'
import { apiRequest } from '@/api/client'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
let failInventory = false, failAgents = false, canManage = true
let agentIds: string[] = []
const plugin = { id: 'plugin-1', name: '现有插件', transport: 'http', url: 'https://mcp.example.test', envKeys: [], headerKeys: ['Authorization'], agentIds: [], enabled: false, revision: 2, toolCount: 1, testedAt: 1 }
beforeEach(() => {
  failInventory = false; failAgents = false; canManage = true; agentIds = []
  vi.mocked(apiRequest).mockReset().mockImplementation(async (path, options) => {
    if (options?.method && options.method !== 'GET') return {} as never
    if (path.endsWith('/settings')) return { configured: true, revision: 1, canManageMcp: canManage } as never
    if (path.endsWith('/mcp')) return { plugins: [{ ...plugin, agentIds }], canManage } as never
    if (path.endsWith('/apps/catalog')) return { cards: [{ slug: 'gmail', name: 'Gmail', description: '邮件' }] } as never
    if (path.endsWith('/apps')) {
      if (failInventory) throw new Error('暂时无法读取连接状态')
      return { authoritative: true, connections: [{ slug: 'gmail', accounts: [{ id: 'account-1', alias: '工作账号', status: 'ACTIVE' }], agentIds: [], revision: 0 }] } as never
    }
    if (failAgents) throw new Error('暂时无法读取 Bot 列表')
    return { agents: [{ id: 'current-bot', name: '小夭', archived: false }] } as never
  })
})
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
const render = () => mount(BotPluginsPanel, { attachTo: document.body, global: { stubs: { AppIcon: true } } })
function button(wrapper: ReturnType<typeof render>, text: string) { return wrapper.findAll('button').find(b => b.text() === text)! }

it('retains connected accounts on failed refresh instead of presenting them as disconnected', async () => {
  const wrapper = render(); await flushPromises()
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
  expect(button(wrapper, '授权 Bot').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
it('rebinds stale MCP grants without resaving credentials or resetting the connection test', async () => {
  agentIds = ['deleted-bot']
  const wrapper = render(); await flushPromises()
  await button(wrapper, 'MCP 服务').trigger('click')
  expect(wrapper.text()).toContain('服务器')
  expect(wrapper.text()).toContain('授权已失效')
  await button(wrapper, '授权 Bot').trigger('click')
  const form = wrapper.get('form[aria-label="MCP Bot 授权"]')
  await form.get('input[type="checkbox"]').setValue(true)
  await form.trigger('submit'); await flushPromises()
  expect(vi.mocked(apiRequest)).toHaveBeenCalledWith('/api/app/bot-tools/mcp/plugin-1', {
    method: 'PATCH', body: { agentIds: ['current-bot'], revision: 2 },
  })
  expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([false])
  wrapper.unmount()
})
it('drops missing Bot ids when editing an old service while keeping its HTTP URL', async () => {
  agentIds = ['deleted-bot', 'current-bot']
  const wrapper = render(); await flushPromises()
  await button(wrapper, 'MCP 服务').trigger('click')
  await button(wrapper, '编辑').trigger('click')
  await wrapper.get('form[aria-label="MCP 服务配置"]').trigger('submit'); await flushPromises()
  const call = vi.mocked(apiRequest).mock.calls.find(([, options]) => options?.method === 'PUT')!
  expect(call[1]?.body).toMatchObject({ definition: { url: plugin.url, transport: 'http', agentIds: ['current-bot'], headers: { Authorization: true } } })
  wrapper.unmount()
})
it('does not treat a failed Bot inventory as deleted grants', async () => {
  agentIds = ['current-bot']; failAgents = true
  const wrapper = render(); await flushPromises()
  await button(wrapper, 'MCP 服务').trigger('click')
  expect(wrapper.text()).not.toContain('授权已失效')
  expect(button(wrapper, '授权 Bot').attributes('disabled')).toBeDefined()
  expect(button(wrapper, '编辑').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
