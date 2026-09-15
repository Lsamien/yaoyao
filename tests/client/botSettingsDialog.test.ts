import {mount, flushPromises} from '@vue/test-utils'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import BotSettingsDialog from '@/components/workspace/BotSettingsDialog.vue'
import {apiRequest} from '@/api/client'

vi.mock('@/api/client', () => ({apiRequest:vi.fn()}))
const request = vi.mocked(apiRequest)
const project={id:'project-a',name:'项目示例',description:'项目说明',memberIds:['bot-a'],groupIds:[],revision:1,archived:false}
const mountDialog=(isAdmin=false, initialPage='projects')=>mount(BotSettingsDialog,{
  props:{isAdmin,initialPage} as never,
  global:{stubs:{
    StandaloneDialog:defineComponent({props:['title'],template:'<section role="dialog" :aria-label="title"><slot /></section>'}),
    AppIcon:true,
    LocalVmSettingsPanel:defineComponent({template:'<div data-testid="vm-settings">虚拟机管理</div>'}),
  }},
})
beforeEach(()=>{
  request.mockReset()
  request.mockImplementation(async(path)=>{
    if(path==='/api/app/capabilities')return {features:['bot-file-memory-v1']} as never
    if(path==='/api/app/agents')return {agents:[{id:'bot-a',name:'测试 Bot'}]} as never
    if(path==='/api/app/conversations')return {conversations:[]} as never
    if(path==='/api/app/workspace/projects')return {projects:[project]} as never
    if(String(path).includes('/memory-jobs'))return {jobs:[]} as never
    if(String(path).includes('/memories'))return {memories:[]} as never
    throw new Error(String(path))
  })
})
afterEach(()=>vi.restoreAllMocks())

it('reuses project and user-memory management inline without nesting dialogs',async()=>{
  const wrapper=mountDialog()
  await flushPromises()
  expect(wrapper.get('[aria-label="Bot 设置分类"]').text()).toContain('项目')
  expect(wrapper.text()).toContain('项目示例')
  expect(wrapper.find('dialog').exists()).toBe(false)
  await wrapper.findAll('button').find(b=>b.text()==='查看记忆')!.trigger('click')
  await flushPromises()
  expect(request).toHaveBeenCalledWith(expect.stringContaining('scope=project&projectId=project-a'))
  await wrapper.findAll('button').find(b=>b.text()==='返回项目')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('新建项目')
  await wrapper.get('nav').findAll('button').find(b=>b.text()==='用户记忆')!.trigger('click')
  await flushPromises()
  expect(request).toHaveBeenCalledWith(expect.stringContaining('scope=user'))
  expect(wrapper.text()).toContain('同一账号的 Bot 共享')
  wrapper.unmount()
})

it('keeps VM management admin-only, including a requested initial VM page',async()=>{
  const wrapper=mountDialog(false,'vm')
  await flushPromises()
  expect(wrapper.get('nav').text()).not.toContain('本地虚拟机')
  expect(wrapper.find('[data-testid="vm-settings"]').exists()).toBe(false)
  await wrapper.setProps({isAdmin:true})
  await wrapper.get('nav').findAll('button').find(b=>b.text()==='本地虚拟机')!.trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="vm-settings"]').exists()).toBe(true)
  await wrapper.setProps({isAdmin:false})
  await flushPromises()
  expect(wrapper.find('[data-testid="vm-settings"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('项目示例')
  wrapper.unmount()
})
