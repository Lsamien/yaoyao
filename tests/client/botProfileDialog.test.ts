import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import BotProfileDialog from '@/components/workspace/BotProfileDialog.vue'
import type { WorkspaceAgent } from '@shared/workspace'

const agent: WorkspaceAgent = { id: 'target-bot', name: '目标机器人', avatar: '', instructions: '检查边界条件', nodeId: 'local', profile: 'ops/team', execution: 'computer', canManageTeam: false, canCollaborate: true, memoryEnabled: true, archived: false, revision: 1, createdAt: 1, updatedAt: 1 }
let wrapper: VueWrapper | undefined
function open(overrides: Record<string, unknown> = {}) {
  wrapper = mount(BotProfileDialog, {
    props: {
      agent,
      draft: { ...agent, source: JSON.stringify(['local', 'ops/team']) },
      sources: [{ nodeId: 'local', profile: 'ops/team', name: '运维机器人' }, { nodeId: 'local', profile: 'default', name: '丫头' }],
      profiles: [{ name: 'default', agentName: '丫头', isDefault: true }],
      agents: [agent], conversations: [], conversationId: 'target-chat', isAdmin: true, knowledgeEnabled: true,
      ...overrides,
    } as never,
    global: { stubs: {
      StandaloneDialog: { props: ['title', 'beforeClose'], template: '<div role="dialog" :aria-label="title"><slot /></div>' },
      AppIcon: true, AgentAvatar: true, AgentIdentityPanel: true,
      ModelServicesPanel: true, WorkspaceKnowledgePanel: true,
    } },
  })
  return wrapper
}
function page(label: string) { return wrapper!.findAll('nav button').find(button => button.text() === label)! }
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })

it('shows the associated Profile identity instead of repeating its technical name', () => {
  const view = open({ sources: [{ nodeId: 'local', profile: 'ops/team', name: 'ops/team' }], profiles: [{ name: 'ops/team', agentName: '运维助手', isDefault: false }] })
  expect(view.get('.profile-source__identity').text()).toBe('运维助手ops/team')
})

it('keeps identity drafts on the right-clicked Bot while the account has another Profile', async () => {
  const view = open()
  expect(view.get('[role="dialog"]').attributes('aria-label')).toBe('编辑资料 · 目标机器人')
  expect(view.get<HTMLButtonElement>('.profile-save').element.disabled).toBe(true)
  await page('身份与头像').trigger('click')
  const identity = view.findComponent({ name: 'AgentIdentityPanel' })
  expect(identity.props('profile')).toMatchObject({ name: 'target-bot', agentName: '目标机器人' })
  expect(identity.props('showDefaultModel')).toBe(false)
  await view.get('input[maxlength="100"]').setValue('新的名称')
  await page('角色与规则').trigger('click')
  await view.get('.persona-advanced summary').trigger('click')
  await view.get('textarea[maxlength="24000"]').setValue('新的规则')
  await view.get('.profile-save').trigger('click')
  expect(view.emitted('save')?.[0]?.[0]).toMatchObject({ name: '新的名称', avatar: '', instructions: '新的规则', voice: '', actBias: '', source: '["local","ops/team"]', canManageTeam: false, canCollaborate: true, memoryEnabled: true, approvalPolicy: 'ask' })
  expect(agent.name).toBe('目标机器人')
})

it('uses the same selectable-card treatment for tone and action preference', async () => {
  const view = open()
  await page('角色与规则').trigger('click')
  const groups = view.findAll('.persona-choice-group')
  expect(groups).toHaveLength(2)
  expect(groups[0].findAll('.radio-row')).toHaveLength(5)
  expect(groups[1].findAll('.radio-row')).toHaveLength(4)
  expect(groups[0].get('.radio-row.selected').text()).toContain('未指定')
  expect(groups[1].get('.radio-row.selected').text()).toContain('未指定')

  await groups[0].find('input[value="rigorous"]').setValue(true)
  await groups[1].find('input[value="act_now"]').setValue(true)
  expect(groups[0].get('.radio-row.selected').text()).toContain('严谨细致')
  expect(groups[1].get('.radio-row.selected').text()).toContain('直接行动')
})

it('uses the saved target Profile for model services and blocks an unsaved source switch', async () => {
  const view = open()
  await page('模型与 Provider').trigger('click')
  expect(view.findComponent({ name: 'ModelServicesPanel' }).props('profile')).toBe('ops/team')
  await view.get('select[aria-label="基础机器人"]').setValue('["local","default"]')
  expect(view.findComponent({ name: 'ModelServicesPanel' }).exists()).toBe(false)
  expect(view.text()).toContain('请先保存基础机器人的变更')
})

it.each([false, true])('shows shared policy without a per-Bot override (remote=%s)', async remote => {
  const view = open({ agent: { ...agent, approvalPolicy:'deny', ...(remote ? { remoteAgentId: 'remote-bot' } : {}) } })
  await page('权限').trigger('click')
  expect(view.find('input[value="ask"]').exists()).toBe(false)
  expect(view.text()).toContain('所有 Bot')
  expect(view.text()).toContain('自动拒绝')
  expect(view.emitted('save')).toBeUndefined()
})

it.each([{ isAdmin: false }, { agent: { ...agent, nodeId: 'remote' } }, { agent: { ...agent, remoteAgentId: 'remote-bot' } }])('does not expose local model management outside the eligible Bot scope: %j', async overrides => {
  const view = open(overrides)
  if (page('模型与 Provider')) await page('模型与 Provider').trigger('click')
  expect(view.findComponent({ name: 'ModelServicesPanel' }).exists()).toBe(false)
})

it('pins memory to this Bot and protects unsaved memory and Provider edits', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const view = open()
  await page('身份与头像').trigger('click')
  await view.get('input[maxlength="100"]').setValue('改过的名称')
  await page('记忆').trigger('click')
  const memory = view.findComponent({ name: 'WorkspaceKnowledgePanel' })
  expect(memory.props()).toMatchObject({ selectedAgentId: 'target-bot', conversationId: 'target-chat', initialTab: 'agent', hideAgentControls: true })
  memory.vm.$emit('dirty-change', true)
  await view.vm.$nextTick()
  await page('模型与 Provider').trigger('click')
  expect(confirm).toHaveBeenCalledWith('放弃当前记忆未保存的更改？')
  expect(view.findComponent({ name: 'WorkspaceKnowledgePanel' }).exists()).toBe(true)
  memory.vm.$emit('dirty-change', false)
  await view.vm.$nextTick()
  await page('模型与 Provider').trigger('click')
  view.findComponent({ name: 'ModelServicesPanel' }).vm.$emit('dirty-change', true)
  await view.vm.$nextTick()
  expect(view.get<HTMLButtonElement>('.profile-save').element.disabled).toBe(true)
  await page('身份与头像').trigger('click')
  expect(confirm).toHaveBeenCalledWith('放弃当前模型服务未保存的更改？')
  expect(view.findComponent({ name: 'ModelServicesPanel' }).exists()).toBe(true)
})
