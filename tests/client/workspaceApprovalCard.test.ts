import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import WorkspaceApprovalCard from '@/components/workspace/WorkspaceApprovalCard.vue'

it('sends one-time choices and directs persistent policy to global settings', async () => {
  const view = mount(WorkspaceApprovalCard, { props: { prompt: '调用图片生成工具', agentName: '瑶儿' } })
  expect(view.text()).toContain('瑶儿： 调用图片生成工具')
  expect(view.text()).toContain('所有 Bot 的审批策略')
  const buttons = view.findAll('button')
  expect(buttons.map(button => button.text())).toEqual(['允许', '拒绝'])
  for (const button of buttons) await button.trigger('click')
  expect(view.emitted('choose')).toEqual([['once'], ['deny']])
  await view.setProps({ busy: true, error: '本次答复未确认' })
  expect(view.get('[role="status"]').text()).toBe('正在处理…')
  expect(view.get('[role="alert"]').text()).toBe('本次答复未确认')
  expect(buttons.every(button => button.attributes('disabled') !== undefined)).toBe(true)
  await buttons[0]!.trigger('click')
  expect(view.emitted('choose')).toHaveLength(2)
  view.unmount()
})
