import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BotAutomationsView from '@/views/BotAutomationsView.vue'
import AboutDialog from '@/components/app/AboutDialog.vue'
import BotPluginsDialog from '@/components/workspace/BotPluginsDialog.vue'
import { apiRequest } from '@/api/client'
import appRouter from '@/router'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
const bots = [{ id: '11111111-1111-4111-8111-111111111111', name: '工作 Bot', avatar: '' }, { id: '22222222-2222-4222-8222-222222222222', name: '研究 Bot', avatar: '' }]
const edit = vi.fn()
const editorStub = defineComponent({ name: 'WorkspaceRoutinesPanel', props: ['agentId', 'editorOnly'], emits: ['changed', 'executed'], setup(_props, { expose }) { expose({ edit }); return {} }, template: '<div data-testid="routine-editor" :data-agent="agentId" />' })
const dialogStub = defineComponent({ name: 'StandaloneDialog', props: ['title', 'compact', 'beforeClose'], emits: ['close'], template: '<div role="dialog" :aria-label="title"><slot /></div>' })
const routine = () => ({ id: 'task-1', agentId: bots[0]!.id, name: '日常核对', prompt: '核对项目', enabled: true, schedule: { kind: 'daily', timezone: 'Asia/Shanghai', time: '09:00' }, nextAt: Date.now() + 3600000, createdAt: 1, updatedAt: 1 })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-11T00:00:00Z')); edit.mockReset()
  vi.mocked(apiRequest).mockReset().mockResolvedValue({ agents: bots, routines: [routine()], runs: [{ id: 'run-1', routineId: 'task-1', agentId: bots[0]!.id, status: 'complete', startedAt: Date.now(), scheduledAt: 0, conversationId: '33333333-3333-4333-8333-333333333333' }] })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '' })
async function automation() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/conversations/automations', component: { template: '<div />' } }, { path: '/conversations/:id?', component: { template: '<div />' } }] })
  await router.push('/conversations/automations?from=%2Fconversations'); await router.isReady()
  const wrapper = mount(BotAutomationsView, { global: { plugins: [router], stubs: { AppIcon: true, AgentAvatar: true, WorkspaceRoutinesPanel: editorStub } } })
  await flushPromises()
  return { wrapper, router }
}

it('resolves the independent automation URL before the conversation ID route', () => {
  const route = appRouter.resolve('/conversations/automations')
  expect(route.name).toBe('bot-automations'); expect(route.params.id).toBeUndefined()
})
it('renders automation as its own workspace with Bot filters, calendar, task list and logs', async () => {
  const { wrapper, router } = await automation()
  expect(wrapper.get('h1').text()).toBe('自动化')
  expect(wrapper.find('.settings-sidebar').exists()).toBe(false)
  expect(wrapper.findAll('.schedule-day')).toHaveLength(7)
  expect(wrapper.get('.schedule-event').text()).toContain('日常核对')
  const tab = (name: string) => wrapper.findAll('[role="tab"]').find(b => b.text() === name)!
  await tab('任务列表').trigger('click')
  expect(wrapper.findAll('.automation-card')).toHaveLength(1)
  await wrapper.get('.routine-description').trigger('click'); await flushPromises()
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', agentId: bots[0]!.id }))
  await tab('运行日志').trigger('click')
  expect(wrapper.get('.run-card').text()).toContain('已完成')
  expect(wrapper.get('.run-card a').attributes('href')).toBe('/conversations/33333333-3333-4333-8333-333333333333')
  await wrapper.get('[aria-label="返回聊天"]').trigger('click'); await flushPromises()
  expect(router.currentRoute.value.path).toBe('/conversations')
  wrapper.unmount()
})
it('chooses an explicit Bot when creating from the all-Bots automation view', async () => {
  const { wrapper } = await automation()
  await wrapper.get('.new-automation > button').trigger('click')
  await wrapper.findAll('.new-menu button')[1]!.trigger('click'); await flushPromises()
  expect(wrapper.get('[data-testid="routine-editor"]').attributes('data-agent')).toBe(bots[1]!.id)
  expect(edit).toHaveBeenCalledWith(undefined)
  wrapper.unmount()
})
it('shows product identity and help in an independent About dialog without settings navigation', () => {
  const wrapper = mount(AboutDialog, { global: { stubs: { StandaloneDialog: dialogStub, BrandMark: true } } })
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('关于夭夭 AI')
  expect(wrapper.text()).toContain('版本')
  expect(wrapper.find('.settings-sidebar').exists()).toBe(false)
  expect(wrapper.findAll('a').some(a => a.attributes('href') === 'https://yaoyao.samien.cn')).toBe(true)
  wrapper.unmount()
})
it('uses one connected-app dialog for apps and MCP, guarding unsaved edits on close', async () => {
  const panel = defineComponent({ name: 'BotPluginsPanel', emits: ['dirty-change'], template: '<button @click="$emit(\'dirty-change\', true)">未保存更改</button>' })
  const wrapper = mount(BotPluginsDialog, { global: { stubs: { StandaloneDialog: dialogStub, BotPluginsPanel: panel } } })
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('已连接应用')
  const canClose = wrapper.getComponent(dialogStub).props('beforeClose')
  expect(canClose()).toBe(true)
  await wrapper.get('button').trigger('click')
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  expect(canClose()).toBe(false)
  wrapper.unmount()
})
