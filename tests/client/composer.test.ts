import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ComposerShell from '@/components/composer/ComposerShell.vue'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('composer availability', () => {
  it('opens delivery mode from the plus menu and closes the chip without losing the draft', async () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', deliveryAvailable: true } })
    const input = wrapper.get('textarea')
    await input.setValue('保留这份交付草稿')
    expect(wrapper.find('.composer-delivery-chip').exists()).toBe(false)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await wrapper.get('[aria-label="添加"]').trigger('click')
    const goal = wrapper.findAll('[role="menuitem"]').find(item => item.text().includes('交付目标'))!
    await goal.trigger('click')
    expect(wrapper.emitted('update:deliveryMode')?.[0]).toEqual([true])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await wrapper.setProps({ deliveryMode: true })
    expect(input.attributes('placeholder')).toContain('描述希望团队交付的结果')
    expect(wrapper.get('.composer-delivery-chip').text()).toBe('交付目标')
    await wrapper.get('.composer-delivery-chip').trigger('click')
    expect(wrapper.emitted('update:deliveryMode')?.[1]).toEqual([false])
    await wrapper.setProps({ deliveryMode: false })
    expect(wrapper.find('.composer-delivery-chip').exists()).toBe(false)
    expect(input.element.value).toBe('保留这份交付草稿')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')
    expect(wrapper.emitted('send')?.[0]).toEqual([{ text: '保留这份交付草稿', files: [], mentionIds: [] }])
    wrapper.unmount()
  })

  it('keeps unavailable goal actions disabled with an explanation', async () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', deliveryAvailable: true, deliveryDisabled: true, deliveryDisabledReason: '负责人不可用' } })
    await wrapper.get('[aria-label="添加"]').trigger('click')
    const goal = wrapper.findAll('[role="menuitem"]').find(item => item.text().includes('交付目标'))!
    expect(goal.text()).toContain('负责人不可用')
    expect(goal.attributes('disabled')).toBeDefined()
    await goal.trigger('click')
    expect(wrapper.emitted('update:deliveryMode')).toBeUndefined()
    wrapper.unmount()
  })

  it('opens mentions from the plus menu and inserts the selected member', async () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', mentionOptions: [{ id: 'bot', label: '小夭' }] } })
    await wrapper.get('[aria-label="添加"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]').find(item => item.text() === '提及成员')!.trigger('click')
    expect(wrapper.get('textarea').element.value).toBe('@')
    await wrapper.get('[role="option"]').trigger('mousedown')
    expect(wrapper.get('textarea').element.value).toBe('@小夭 ')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('supports menu keyboard navigation, Escape focus return, and outside dismissal', async () => {
    const wrapper = mount(ComposerShell, { attachTo: document.body, props: { mode: 'group', deliveryAvailable: true } })
    const trigger = wrapper.get('[aria-label="添加"]')
    await trigger.trigger('click')
    const items = wrapper.findAll('[role="menuitem"]')
    expect(document.activeElement).toBe(items[0]!.element)
    await items[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1]!.element)
    await items[1]!.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    await trigger.trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('retains attachments and hides goal controls in ordinary chat', async () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'chat' } })
    const pick = vi.spyOn(wrapper.get<HTMLInputElement>('input[type="file"]').element, 'click')
    await wrapper.get('[aria-label="添加附件"]').trigger('click')
    expect(pick).toHaveBeenCalledOnce()
    expect(wrapper.find('[aria-label="添加"]').exists()).toBe(false)
    expect(wrapper.find('.composer-delivery-chip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the group-chat send action available while an Agent is running', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', streaming: true } })
    expect(wrapper.find('[aria-label="发送消息"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="停止生成"]').exists()).toBe(false)
  })

  it('keeps the ordinary-chat interrupt action while its server run is active', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'chat', streaming: true } })
    expect(wrapper.find('[aria-label="停止生成"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="发送消息"]').exists()).toBe(false)
  })

  it('keeps an interrupt action available while a running session has a draft', async () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', streaming: true, stopWhileRunning: true } })
    await wrapper.get('textarea').setValue('等待环境时补充的内容')

    expect(wrapper.get('[aria-label="发送消息"]').attributes('disabled')).toBeUndefined()
    const stop = wrapper.get('[aria-label="停止生成"]')
    expect(stop.attributes('disabled')).toBeUndefined()
    await stop.trigger('click')

    expect(wrapper.emitted('stop')).toHaveLength(1)
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('places an accessible blue fast-mode toggle beside the model control', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'chat', modelLabel: 'gpt-5.6-terra', fastMode: true } })
    const model = wrapper.get('.composer-tool--model')
    const fast = wrapper.get('.composer-fast-mode')
    expect(model.element.nextElementSibling).toBe(fast.element)
    expect(fast.attributes('aria-pressed')).toBe('true')
    expect(fast.classes()).toContain('active')
    fast.trigger('click')
    expect(wrapper.emitted('fastModeToggle')?.[0]).toEqual([false])
  })

  it('keeps named group activity directly above the input after a reference', () => {
    const wrapper = mount(ComposerShell, {
      props: {
        mode: 'group',
        activityText: '夭夭正在输入…',
        reference: { id: 'message-1', author: '夭夭', content: '上一条消息' },
      },
    })
    const reference = wrapper.get('.composer-reference')
    const activity = wrapper.get('.composer-activity-slot')
    const shell = wrapper.get('.composer-shell')
    expect(reference.element.nextElementSibling).toBe(activity.element)
    expect(activity.element.nextElementSibling).toBe(shell.element)
    expect(activity.get('[role="status"]').text()).toBe('夭夭正在输入…')
  })

  it('adds attachments when randomUUID is unavailable in an HTTP browser', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })
    try {
      const wrapper = mount(ComposerShell)
      const input = wrapper.get<HTMLInputElement>('.composer-file-input')
      const file = new File(['兼容内容'], '兼容.txt', { type: 'text/plain', lastModified: 123 })
      Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })

      await input.trigger('change')

      expect(wrapper.get('.composer-attachment strong').text()).toBe('兼容.txt')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      wrapper.unmount()
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor)
      else Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
    }
  })
})

it('keeps a newer draft even when its text is edited back to the submitted value', async () => {
  const wrapper = mount(ComposerShell, { props: { mode: 'group', draftKey: 'receipt-draft' } })
  const input = wrapper.get('textarea')
  await input.setValue('原消息')
  const api = wrapper.vm as unknown as { submissionToken(): { key: string; revision: number }; clearAfterSend(token?: { key: string; revision: number }): boolean }
  const token = api.submissionToken()
  await input.setValue('新草稿'); await input.setValue('原消息')
  expect(api.clearAfterSend(token)).toBe(false)
  expect((input.element as HTMLTextAreaElement).value).toBe('原消息')
  api.clearAfterSend()
  await wrapper.vm.$nextTick()
  expect((input.element as HTMLTextAreaElement).value).toBe('')
  wrapper.unmount()
})

it('clears only the submitted stored draft after switching conversations', async () => {
  const wrapper = mount(ComposerShell, { props: { mode: 'group', draftKey: 'receipt-a' } })
  await wrapper.get('textarea').setValue('已发送 A')
  const api = wrapper.vm as unknown as { submissionToken(): { key: string; revision: number }; clearAfterSend(token: { key: string; revision: number }): boolean }
  const token = api.submissionToken()
  await wrapper.setProps({ draftKey: 'receipt-b' }); await wrapper.get('textarea').setValue('保留 B')
  expect(api.clearAfterSend(token)).toBe(false)
  expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('保留 B')
  expect(localStorage.getItem(token.key)).toBeNull()
  wrapper.unmount()
})
