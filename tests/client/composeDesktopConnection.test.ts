import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import Panel from '../../src/client/components/workspace/LocalVmChatPanel.vue'
import {apiRequest} from '../../src/client/api/client'

vi.mock('../../src/client/api/client',()=>({apiRequest:vi.fn()}))
const agent={id:'bot',name:'小民',nodeId:'local',profile:'default',execution:'profile',computer:'auto'} as any
const desktop={id:'cursor',name:'Cursor 开发桌面',online:true,ready:true,available:true}
let state:any,problem:string
const mountPanel=()=>mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
beforeEach(()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 problem=''
 state={fixedCapacity:true,enabled:false,desktops:[{...desktop}]}
 vi.mocked(apiRequest).mockImplementation(async(path,options:any)=>{
  if(path.endsWith('/host-tools'))return {vm:true,cloud:false,serverComputer:false,scriptMachine:false} as any
  if(path.endsWith('/desktop-environment'))return {hosts:[]} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  if(path.includes('/computer/frame?backend=vm'))return {data:'fixture',width:100,height:80} as any
  if(options?.method==='PUT'){
   if(problem)throw new Error(problem)
   state={...state,desktopId:options.body.desktopId,enabled:true,container:'running',ready:true,image:true,mode:'shared'}
   return {agent:{...agent,computerEnvironmentId:state.desktopId}} as any
  }
  return state
 })
})
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks()})

it('connects an unassigned bot to an existing Compose desktop and opens the VM viewer',async()=>{
 const wrapper=mountPanel()
 try{
  await flushPromises()
  expect(wrapper.get('[aria-label="共享桌面"]').element).toHaveProperty('value','cursor')
  expect(vi.mocked(apiRequest).mock.calls.some(([,o])=>o?.method==='PUT')).toBe(false)
  await wrapper.get('[data-testid="connect-compose-desktop"]').trigger('click');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/bot/local-vm',{method:'PUT',body:{enabled:true,desktopId:'cursor'}})
  expect(wrapper.emitted('changed')).toHaveLength(1)
  expect(wrapper.get('.preview img').attributes('src')).toContain('base64,fixture')
  expect(wrapper.findAll('button').some(b=>b.text()==='设置本地虚拟机')).toBe(false)
  await wrapper.findAll('button').find(b=>b.text()==='打开桌面')!.trigger('click')
  expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'vm',undefined])
 }finally{wrapper.unmount()}
})

it.each([
 {online:false}, {ready:false}, {available:false},
])('does not connect an unavailable desktop: %j',async unavailable=>{
 state.desktops=[{...desktop,...unavailable}]
 const wrapper=mountPanel()
 try{
  await flushPromises()
  expect(wrapper.get('[aria-label="共享桌面"] option[value="cursor"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('[data-testid="connect-compose-desktop"]').attributes('disabled')).toBeDefined()
 }finally{wrapper.unmount()}
})

it('requires an explicit choice with several desktops and preserves it across refreshes',async()=>{
 state.desktops.push({...desktop,id:'standard',name:'标准桌面'})
 const wrapper=mountPanel()
 try{
  await flushPromises()
  expect(wrapper.get('[data-testid="connect-compose-desktop"]').attributes('disabled')).toBeDefined()
  await wrapper.get('[aria-label="共享桌面"]').setValue('standard')
  await wrapper.setProps({active:false});await wrapper.setProps({active:true});await flushPromises()
  expect(wrapper.get('[aria-label="共享桌面"]').element).toHaveProperty('value','standard')
  await wrapper.get('[data-testid="connect-compose-desktop"]').trigger('click');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/bot/local-vm',{method:'PUT',body:{enabled:true,desktopId:'standard'}})
 }finally{wrapper.unmount()}
})

it('keeps a rejected binding visible and does not claim the desktop is connected',async()=>{
 problem='请连接启用 Compose 桌面模式的执行节点'
 const wrapper=mountPanel()
 try{
  await flushPromises();await wrapper.get('[data-testid="connect-compose-desktop"]').trigger('click');await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe(problem)
  expect(wrapper.emitted('changed')).toBeUndefined()
  expect(wrapper.findAll('button').some(b=>b.text()==='打开桌面')).toBe(false)
 }finally{wrapper.unmount()}
})

it('keeps the existing assignment and blocks changes while the desktop is in use',async()=>{
 state={...state,enabled:true,desktopId:'cursor',container:'running',ready:true,image:true,inUse:true}
 const wrapper=mountPanel()
 try{
  await flushPromises()
  expect(wrapper.get('[aria-label="共享桌面"]').element).toHaveProperty('value','cursor')
  expect(wrapper.get('[aria-label="共享桌面"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('[data-testid="connect-compose-desktop"]').text()).toBe('已连接')
  expect(wrapper.get('[data-testid="connect-compose-desktop"]').attributes('disabled')).toBeDefined()
 }finally{wrapper.unmount()}
})

it('does not reuse another bot selection or bind a desktop that became unavailable',async()=>{
 state.desktops.push({...desktop,id:'standard',name:'标准桌面'})
 const wrapper=mountPanel()
 try{
  await flushPromises();await wrapper.get('[aria-label="共享桌面"]').setValue('standard')
  await wrapper.setProps({agents:[{...agent,id:'other'}]});await flushPromises()
  expect(wrapper.get('[aria-label="共享桌面"]').element).toHaveProperty('value','')
  await wrapper.get('[aria-label="共享桌面"]').setValue('standard')
  state={...state,desktops:state.desktops.map((d:any)=>({...d,online:false}))}
  await wrapper.setProps({active:false});await wrapper.setProps({active:true});await flushPromises()
  expect(wrapper.get('[data-testid="connect-compose-desktop"]').attributes('disabled')).toBeDefined()
  expect(vi.mocked(apiRequest).mock.calls.some(([,o])=>o?.method==='PUT')).toBe(false)
 }finally{wrapper.unmount()}
})
