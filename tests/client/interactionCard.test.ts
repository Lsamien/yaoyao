import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractionCard from '@/components/messages/InteractionCard.vue'

it('submits a selected clarification option and exposes the selected state', async () => {
  const wrapper = mount(InteractionCard, { props: { interaction: {
    id: 'clarify-1', kind: 'clarification', prompt: '先创建草稿，还是继续调整？', options: ['先创建草稿', '继续调整'],
  } } })

  const inputs = wrapper.findAll('input[type="radio"]')
  await inputs[0]!.setValue(true)
  expect((inputs[0]!.element as HTMLInputElement).checked).toBe(true)
  expect(wrapper.findAll('.interaction-card__options label')[0]!.classes()).toContain('selected')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('clarify')).toEqual([['先创建草稿']])
})

it('prefers a custom clarification answer and resets the draft for the next question', async () => {
  const wrapper = mount(InteractionCard, { props: { interaction: {
    id: 'clarify-1', kind: 'clarification', prompt: '需要哪种格式？', options: ['文档'],
  } } })

  await wrapper.get('textarea').setValue('请同时提供 PDF')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('clarify')).toEqual([['请同时提供 PDF']])

  await wrapper.setProps({ interaction: { id: 'clarify-2', kind: 'clarification', prompt: '是否继续？' } })
  expect(wrapper.get('textarea').element.value).toBe('')
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
})
