import {it,expect,vi,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import Settings from '../../src/client/components/app/LocalVmSettingsPanel.vue'
import Panel from '../../src/client/components/workspace/LocalVmChatPanel.vue'
import {apiRequest} from '../../src/client/api/client'
vi.mock('../../src/client/api/client',()=>({apiRequest:vi.fn()}))
const images=[{key:'standard',name:'标准桌面',description:'XFCE',ready:true,imageId:'sha256:a'},{key:'cursor',name:'Cursor Universal',description:'Debian',ready:true,imageId:'sha256:b'}]
const agent={id:'image-fixture',name:'镜像测试',computer:'vm',execution:'computer',nodeId:'local',profile:'default'} as any
const vm={configured:true,runtime:'docker',daemonUp:true,image:true,mode:'per-bot',maxInstances:2,busy:false,images}
afterEach(()=>{vi.clearAllMocks();vi.restoreAllMocks()})
it('saves never-stop and restores the selected value after refresh',async()=>{
 let idleStopMinutes=5
 vi.mocked(apiRequest).mockImplementation(async(path,options:any)=>{
  if(path.endsWith('/idle-policy'))idleStopMinutes=options.body.idleStopMinutes
  return path==='/api/app/computers'?{computers:[]}:{...vm,idleStopMinutes} as any
 })
 const wrapper=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 try{
  await flushPromises();await wrapper.get('[aria-label="虚拟机空闲停止时间"]').setValue('0');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/admin/local-vm/idle-policy',expect.objectContaining({body:expect.objectContaining({idleStopMinutes:0})}))
  expect((wrapper.get('select[aria-label="虚拟机空闲停止时间"]').element as HTMLSelectElement).value).toBe('0')
  expect(wrapper.text()).toContain('空闲时保持运行')
 }finally{wrapper.unmount()}
})
it('offers a host environment checkbox without a combined environment tab',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  return {...vm,enabled:true,container:'missing',ready:false,inUse:false} as any
 })
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises();expect(wrapper.find('[role="tab"][aria-label="本机 + 虚拟机"]').exists()).toBe(false);await wrapper.get('input[type="checkbox"]').setValue(true);await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/computer-selection',{method:'PUT',body:{computer:'vm',allowHostEnvironment:true}})
 }finally{wrapper.unmount()}
})
it('offers the checkbox for cloud selection and hides it for other environments',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:true,running:false} as any
  return {...vm,enabled:false,container:'missing',ready:false,inUse:false} as any
 })
 const cloudAgent={...agent,computer:'cloud',execution:'profile'}
 const wrapper=mount(Panel,{props:{agents:[cloudAgent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises();await wrapper.get('input[type="checkbox"]').setValue(true);await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/computer-selection',{method:'PUT',body:{computer:'cloud',allowHostEnvironment:true}})
  for(const computer of ['auto','off','local','browser']){
   await wrapper.setProps({agents:[{...cloudAgent,computer}]});await flushPromises()
   expect(wrapper.find('.host-environment-option').exists()).toBe(false)
  }
 }finally{wrapper.unmount()}
})
it('keeps Compose lifecycle controls hidden while enabling host tools for an already assigned desktop',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path==='/api/app/computers')return {computers:[]} as any
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  return {...vm,fixedCapacity:true,desktopId:'desktop',desktops:[{id:'desktop',name:'已有桌面',ready:true}],enabled:true,container:'running',ready:false,inUse:false} as any
 })
 const settings=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises();expect(settings.find('[aria-label="虚拟机空闲停止时间"]').exists()).toBe(false)
  expect(wrapper.findAll('button').some(b=>b.text()==='停止虚拟机')).toBe(false)
  await wrapper.get('input[type="checkbox"]').setValue(true);await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/computer-selection',{method:'PUT',body:{computer:'vm',allowHostEnvironment:true}})
 }finally{settings.unmount();wrapper.unmount()}
})
it('prepares the selected image in Settings and explains the shared image constraint',async()=>{
 vi.mocked(apiRequest).mockImplementation(async path=>path==='/api/app/computers'?{computers:[]}:vm as any)
 const wrapper=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 try{
  await flushPromises()
  const select=wrapper.findAll('select').find(select=>select.text().includes('Cursor Universal'))!
  await select.setValue('cursor')
  await wrapper.findAll('button').find(b=>b.text()==='重新检查所选镜像')!.trigger('click')
  await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/admin/local-vm/prepare',expect.objectContaining({body:expect.objectContaining({imageKey:'cursor'})}))
  expect(wrapper.text()).toContain('同一共享桌面的所有机器人使用一个镜像')
 }finally{wrapper.unmount()}
})
it('selects a prepared desktop image and locks the selection for an existing shared instance',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 let detail={...vm,enabled:true,container:'missing',ready:false,inUse:false,imageKey:'standard'}
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  return detail as any
 })
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises()
  const select=wrapper.findAll('select').find(s=>s.text().includes('Cursor Universal'))!
  await select.setValue('cursor');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/local-vm/image',{method:'PUT',body:{imageKey:'cursor'}})
  detail={...detail,mode:'shared',container:'stopped'}
  await wrapper.setProps({active:false});await wrapper.setProps({active:true});await flushPromises()
  expect(select.attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('同一共享桌面只能使用一个镜像')
 }finally{wrapper.unmount()}
})
