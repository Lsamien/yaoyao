import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { defaultAgentIdentity, encodeAgentAvatar } from '@shared/agentIdentity'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'

const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('AgentAvatar', () => {
  it.each(['mascot', 'image'] as const)('keeps %s identity and animates ribbons only during live work', async (mode) => {
    const identity = { ...defaultAgentIdentity('Bot'), shape: 'triangle' as const, color: '#1488ff',
      avatarMode: mode, ...(mode === 'image' ? { imageDataURL: transparentPng } : {}) }
    const wrapper = mount(AgentAvatar, { props: { name: 'Bot', avatar: encodeAgentAvatar(identity), state: 'working', fixedTime: 500 } })
    expect(wrapper.findAll('[data-part=trails] path')).toHaveLength(3)
    if (mode === 'image') {
      expect(wrapper.get('img').attributes('src')).toBe(transparentPng)
      expect((wrapper.get('[data-part=bodyGroup]').element as SVGElement).style.visibility).toBe('hidden')
    } else {
      expect(wrapper.get('[data-part=outline] path').attributes('fill')).toBe('#1488ff')
      expect(wrapper.get('[data-part=bodyContent]').attributes('transform')).toContain('scale(.72)')
    }
    await wrapper.setProps({ state: 'idle', avatar: encodeAgentAvatar({ ...identity, expression: 'working' }) })
    expect(wrapper.findAll('[data-part=trails] path')).toHaveLength(0)
    wrapper.unmount()
  })

  it('marks real images so caller backgrounds cannot show through transparent pixels', () => {
    const wrapper = mount(AgentAvatar, { props: { name: '丫头', avatar: transparentPng } })

    expect(wrapper.classes()).toContain('agent-avatar--image')
    expect(wrapper.find('img').attributes('src')).toBe(transparentPng)
    wrapper.unmount()
  })

  it('renders a stable animated mascot when no image is configured', () => {
    const wrapper = mount(AgentAvatar, { props: { name: '丫头', avatar: encodeAgentAvatar(defaultAgentIdentity('丫头')) } })

    expect(wrapper.classes()).not.toContain('agent-avatar--image')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('[data-part=outline] path').attributes('fill')).toBe('#00c875')
    expect(wrapper.attributes('data-animated')).toBe('false')
    expect(wrapper.findAll('[data-part=eye0], [data-part=eye1]')).toHaveLength(2)
    wrapper.unmount()
  })

  it.each(['', 'invalid-avatar'])('keeps a neutral placeholder until avatar metadata arrives (%s)', async (avatar) => {
    const wrapper = mount(AgentAvatar, { props: { name: '丫头', avatar, size: 56, state: 'working' } })
    expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.attributes('data-animated')).toBe('false')

    await wrapper.setProps({ avatar: encodeAgentAvatar({ ...defaultAgentIdentity('丫头'), color: '#1488ff' }) })
    expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(false)
    expect(wrapper.get('[data-part=outline] path').attributes('fill')).toBe('#1488ff')
    expect(wrapper.attributes('data-animated')).toBe('true')

    await wrapper.setProps({ avatar: '' })
    expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.attributes('data-animated')).toBe('false')

    await wrapper.setProps({ avatar: transparentPng })
    expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(false)
    expect(wrapper.get('img').attributes('src')).toBe(transparentPng)
    wrapper.unmount()
  })

  it('uses the compact triangle and exposes the notifying motion state', () => {
    const wrapper = mount(AgentAvatar, {
      props: {
        name: 'Scout',
        avatar: encodeAgentAvatar({...defaultAgentIdentity('Scout'),shape:'triangle',color:'#00b9ac',expression:'curious'}),
        state: 'notifying',
      },
    })

    expect(wrapper.classes()).toContain('agent-avatar--notifying')
    expect(wrapper.find('[data-part=outline] path[fill="#00b9ac"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps a group-message image transparent when MessageTimeline adds its fallback class', () => {
    const wrapper = mount(MessageTimeline, {
      attachTo: document.body,
      props: {
        messages: [{ id: 'assistant-1', role: 'assistant', profile: 'default', author: '丫头', content: '收到，测试正常。' }],
        agentAvatars: { default: transparentPng },
      },
    })
    const avatar = wrapper.get('.message__avatar')

    expect(avatar.classes()).toEqual(expect.arrayContaining(['agent-avatar--image', 'message__avatar']))
    expect(getComputedStyle(avatar.element).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    wrapper.unmount()
  })
})

it('parks animation frames for idle, hidden, background and reduced-motion avatars', async () => {
  let visible: ((entries: Array<{isIntersecting:boolean}>) => void) | undefined
  let motion: (() => void) | undefined
  let reduced=false, background=false
  const descriptor=Object.getOwnPropertyDescriptor(document,'visibilityState')
  const raf=vi.fn(()=>42), cancel=vi.fn()
  vi.stubGlobal('requestAnimationFrame',raf);vi.stubGlobal('cancelAnimationFrame',cancel)
  vi.stubGlobal('IntersectionObserver',class {constructor(callback:typeof visible){visible=callback} observe(){} disconnect(){}})
  vi.stubGlobal('matchMedia',()=>({get matches(){return reduced},addEventListener(_event:string,fn:()=>void){motion=fn},removeEventListener(){}}))
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>background?'hidden':'visible'})
  const wrapper=mount(AgentAvatar,{props:{name:'quiet',avatar:encodeAgentAvatar(defaultAgentIdentity('quiet')),size:32}})
  try {
    expect(raf).not.toHaveBeenCalled()
    await wrapper.setProps({state:'working'})
    expect(wrapper.attributes('data-animated')).toBe('true')
    expect(raf).toHaveBeenCalled()
    visible?.([{isIntersecting:false}]);await nextTick()
    expect(wrapper.attributes('data-animated')).toBe('false')
    expect(cancel).toHaveBeenCalled()
    visible?.([{isIntersecting:true}]);await nextTick()
    background=true;document.dispatchEvent(new Event('visibilitychange'));await nextTick()
    expect(wrapper.attributes('data-animated')).toBe('false')
    background=false;document.dispatchEvent(new Event('visibilitychange'));reduced=true;motion?.();await nextTick()
    expect(wrapper.attributes('data-animated')).toBe('false')
  } finally {wrapper.unmount();vi.unstubAllGlobals();if(descriptor)Object.defineProperty(document,'visibilityState',descriptor);else delete (document as any).visibilityState}
})

it('renders all picture crops from the same bytes and falls back cleanly on decode failure',async()=>{
  const identity={...defaultAgentIdentity('picture'),avatarMode:'image' as const,imageDataURL:transparentPng}
  const wrapper=mount(AgentAvatar,{props:{name:'picture',avatar:encodeAgentAvatar({...identity,imageCrop:'circle'})}})
  expect(wrapper.get('img').element.style.borderRadius).toBe('50%')
  await wrapper.setProps({avatar:encodeAgentAvatar({...identity,imageCrop:'square'})})
  expect(wrapper.get('img').element.style.borderRadius).toBe('0')
  expect(wrapper.get('img').attributes('src')).toBe(transparentPng)
  await wrapper.get('img').trigger('error');await nextTick()
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(true)
  expect(wrapper.find('svg').exists()).toBe(false)
  await wrapper.setProps({avatar:encodeAgentAvatar({...identity,imageCrop:'rounded'})})
  expect(wrapper.find('.agent-avatar__placeholder').exists()).toBe(false)
  expect(wrapper.get('img').attributes('src')).toBe(transparentPng)
  wrapper.unmount()
})
