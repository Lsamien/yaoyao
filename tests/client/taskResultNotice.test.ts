import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TaskResultNotice from '@/components/workspace/TaskResultNotice.vue'

it('turns a delivered team result into a clear task entry point', () => {
  const wrapper = mount(TaskResultNotice, { props: {
    content: '「公众号文案团队」的任务「完成 Jev 公众号文章」已有执行结果，等待管理员复核。\n[打开任务](/conversations/team?taskId=task)',
    taskReference: { conversationId: 'team', taskId: 'task' },
  } })

  expect(wrapper.get('a').text()).toBe('任务已有新结果')
  expect(wrapper.get('a').attributes('aria-label')).toContain('公众号文案团队 · 完成 Jev 公众号文章')
  expect(wrapper.get('a').attributes('aria-label')).toContain('等待管理员复核后继续')
  expect(wrapper.get('a').attributes('href')).toBe('/conversations/team?taskId=task')
})
