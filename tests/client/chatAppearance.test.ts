import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import { mount } from '@vue/test-utils'
import { appearancePreset, bubbleColors, bubbleVariables, contrast, normalizeAppearance } from '@/utils/chatAppearance'
import { useChatAppearance, CHAT_APPEARANCE_KEY } from '@/stores/chatAppearance'
import ChatAppearancePanel from '@/components/app/ChatAppearancePanel.vue'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    clear: () => values.clear(),
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  HTMLElement.prototype.scrollTo = () => {}
  useChatAppearance().selectPreset('current')
})
afterEach(() => { vi.restoreAllMocks(); useChatAppearance().selectPreset('current') })
describe('chat bubble appearance', () => {
  it.each([MessageTimeline, WorkspaceMessageTimeline])('updates rendered bubbles when a preset changes without replacing messages', async (component) => {
    const store = useChatAppearance()
    const wrapper = mount(component as typeof MessageTimeline, {
      props: {identity: 'appearance', messages: [{id:'u',role:'user',content:'问题'}, {id:'a',role:'assistant',content:'长回复'}, {id:'s',role:'system',content:'系统信息'}]},
      global: {stubs: {AgentAvatar:true, AppIcon:true}},
    })
    store.selectPreset('codex'); await nextTick()
    expect(wrapper.findAll('.message__content .chat-bubble')).toHaveLength(2)
    expect(wrapper.get('.message--user .message__content').attributes('style')).toContain('#E4F3FC')
    store.selectPreset('grok'); await nextTick()
    expect(wrapper.get('.message--user .message__content').attributes('style')).toContain('#090909')
    expect(wrapper.find('.message--system .chat-bubble').exists()).toBe(false)
    wrapper.unmount()
  })
  it('keeps both sides filled in Codex and Grok Bot presets with readable text', () => {
    expect(appearancePreset('grok').user.light).toBe('#090909')
    expect(appearancePreset('codex').user.light).toBe('#E4F3FC')
    for (const id of ['current', 'grok', 'codex'] as const) for (const role of ['user', 'assistant'] as const) {
      const style = appearancePreset(id)[role]
      for (const dark of [false, true]) {
        const colors = bubbleColors(style, dark)
        expect(colors.background).not.toContain('transparent')
        expect(contrast(colors.background, colors.text)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('rejects corrupt persisted settings and clamps custom shapes', () => {
    for (const data of [null, {version: 2, preset: 'grok'}, {version: 1, preset: 'custom', user: {}}]) expect(normalizeAppearance(data)).toEqual(appearancePreset('current'))
    const custom = {...appearancePreset('codex'), preset: 'custom', user: {...appearancePreset('codex').user, radius: 300}}
    expect(normalizeAppearance(custom).user.radius).toBe(28)
  })
  it('protects text against extreme custom gradients', () => {
    const style = {...appearancePreset('codex').assistant, gradient: true, light: '#FFFFFF', lightEnd: '#000000'}
    expect(bubbleColors(style, false).background).toContain('rgba')
    expect(bubbleVariables({...style, tail:true}, 'assistant')['--bubble-radius']).toMatch(/4px$/)
  })
  it('persists preset selection and undo across store consumers', () => {
    const a = useChatAppearance(), b = useChatAppearance()
    a.selectPreset('grok'); a.selectPreset('codex')
    expect(b.appearance.value.preset).toBe('codex')
    expect(JSON.parse(window.localStorage.getItem(CHAT_APPEARANCE_KEY)! ).preset).toBe('codex')
    b.selectPreset('codex') // Selecting the active preset must preserve the undo target.
    b.undo()
    expect(a.appearance.value.preset).toBe('grok')
    expect(JSON.parse(window.localStorage.getItem(CHAT_APPEARANCE_KEY)!).preset).toBe('grok')
  })
  it('does not claim success when storage is unavailable', () => {
    const store = useChatAppearance()
    store.selectPreset('grok')
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {throw new Error('quota')})
    store.selectPreset('codex')
    expect(store.appearance.value.preset).toBe('grok')
    expect(store.saveError.value).toContain('无法保存')
  })
  it('edits the selected role and theme without changing the other role', async () => {
    const store = useChatAppearance(); store.selectPreset('codex')
    const wrapper = mount(ChatAppearancePanel, { global: {stubs: {AgentAvatar:true, AppIcon:true}} })
    await wrapper.get('[aria-label="调整哪一方"] button:nth-child(2)').trigger('click')
    await wrapper.get('[aria-label="预览深色气泡"]').trigger('click')
    await wrapper.get('[aria-label="颜色十六进制值"]').setValue('#090909')
    expect(store.appearance.value.assistant.dark).toBe('#090909')
    expect(store.appearance.value.assistant.light).toBe('#F1F1F1')
    expect(store.appearance.value.user.light).toBe('#E4F3FC')
    expect(store.appearance.value.preset).toBe('custom')
    await wrapper.get('[aria-label="颜色十六进制值"]').setValue('oops')
    expect(wrapper.get('[role="alert"]').text()).toContain('六位颜色')
    expect(store.appearance.value.assistant.dark).toBe('#090909')
    wrapper.unmount()
  })
})
