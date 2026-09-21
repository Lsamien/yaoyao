import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TaskPlan from '@/components/workspace/TaskPlan.vue'
import type { AgentAssignment, AgentGoal } from '@shared/agentTasks'

const goal: AgentGoal = { id:'goal',conversationId:'group',coordinatorId:'lead',authorityRevision:1,objective:'交付报告',acceptanceCriteria:['提供来源'],acceptanceRevision:1,status:'running',origin:{conversationId:'group',runId:'run',agentId:'lead'},artifactIds:[],revision:1,automaticWakes:0,createdAt:1,updatedAt:1 }
const assignment = (id: string, status: AgentAssignment['status']): AgentAssignment => ({ id,goalId:'goal',conversationId:'group',agentId:'writer',title:`步骤 ${id}`,brief:'完成步骤',acceptanceCriteria:[],dependsOn:[],status,attempt:1,artifactIds:[],createdAt:1,updatedAt:1 })

it('starts as a compact summary and reveals progress and results on request', async () => {
  const wrapper = mount(TaskPlan,{props:{goal:{...goal,result:'初稿已交付'},assignments:[assignment('一','complete'),assignment('二','running')],agents:[]}})
  expect(wrapper.get('header').text()).toContain('进行中')
  expect(wrapper.get('.task-plan__disclosure').attributes('aria-expanded')).toBe('false')
  expect(wrapper.find('[role=progressbar]').exists()).toBe(false)
  expect(wrapper.find('.result').exists()).toBe(false)
  await wrapper.get('.task-plan__disclosure').trigger('click')
  expect(wrapper.get('.task-plan__disclosure').attributes('aria-expanded')).toBe('true')
  expect(wrapper.get('details').attributes('open')).toBeUndefined()
  expect(wrapper.get('[role=progressbar]').attributes('aria-valuenow')).toBe('50')
  expect(wrapper.get('.task-plan__count').text()).toContain('1/2')
  expect(wrapper.get('.result').text()).toBe('初稿已交付')
  await wrapper.setProps({goal:{...goal,id:'goal-next',result:'下一项任务'}})
  expect(wrapper.get('.task-plan__disclosure').attributes('aria-expanded')).toBe('false')
  expect(wrapper.find('[role=progressbar]').exists()).toBe(false)
  wrapper.unmount()
})

it('preserves user edits across progress refreshes and reports stale-save errors without discarding the draft', async () => {
  const saveCriteria = vi.fn().mockRejectedValueOnce(new Error('验收要求已更新，请重新查看后修改'))
  const wrapper = mount(TaskPlan,{props:{goal,assignments:[],agents:[],saveCriteria}})
  await wrapper.get('.task-plan__disclosure').trigger('click')
  await wrapper.get('details').trigger('click')
  await wrapper.findAll('button').find(button=>button.text()==='调整验收要求')!.trigger('click')
  await wrapper.get('textarea').setValue('比较三种方案\n给出建议')
  await wrapper.setProps({goal:{...goal,revision:9,status:'review',acceptanceRevision:2,acceptanceCriteria:['另一条最新要求']}})
  expect(wrapper.get('textarea').element.value).toBe('比较三种方案\n给出建议')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(saveCriteria).toHaveBeenCalledWith('goal',1,['比较三种方案','给出建议'])
  expect(wrapper.get('[role=alert]').text()).toContain('已更新')
  expect(wrapper.get('textarea').element.value).toContain('比较三种方案')
  await wrapper.findAll('button').find(button=>button.text()==='取消')!.trigger('click')
  await wrapper.findAll('button').find(button=>button.text()==='调整验收要求')!.trigger('click')
  expect(wrapper.get('textarea').element.value).toBe('另一条最新要求')
  saveCriteria.mockResolvedValue(undefined)
  await wrapper.get('textarea').setValue('最新要求与来源')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(saveCriteria).toHaveBeenLastCalledWith('goal',2,['最新要求与来源'])
  expect(wrapper.find('textarea').exists()).toBe(false)
  wrapper.unmount()
})
