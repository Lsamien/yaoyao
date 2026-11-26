import {it,expect,vi,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import Settings from '../../src/client/components/app/LocalVmSettingsPanel.vue'
import Panel from '../../src/client/components/workspace/LocalVmChatPanel.vue'
import {apiRequest} from '../../src/client/api/client'
vi.mock('../../src/client/api/client',()=>({apiRequest:vi.fn()}))
const images=[{key:'standard',name:'标准桌面',description:'XFCE',ready:true,imageId:'sha256:a'},{key:'cursor',name:'Cursor Universal',description:'Debian',ready:true,imageId:'sha256:b'}]
const agent={id:'image-fixture',name:'镜像测试',computer:'vm',execution:'computer',nodeId:'local',profile:'default'} as any
const vm={supported:true,configured:true,runtime:'docker',daemonUp:true,image:true,mode:'shared',maxInstances:2,maxDesktops:4,busy:false,images}
it('does not offer a per-bot computer picker',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  if(path.endsWith('/host-tools'))return {denyServerTools:true,scriptMachine:true,serverComputer:true,vm:true,cloud:true} as any
  return {...vm,enabled:true,container:'missing',ready:false,inUse:false} as any
 })
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises()
  expect(wrapper.find('[aria-label="本地虚拟机执行方式"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="此机器人使用的电脑（可多选）"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="本机控制"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('设备授权状态在 Bot 设置中查看')
  expect(apiRequest).not.toHaveBeenCalledWith('/api/app/agents/image-fixture/computer-selection',expect.anything())
 }finally{wrapper.unmount()}
})
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
it('shows parallel toggles without a combined environment tab',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  return {...vm,enabled:true,container:'missing',ready:false,inUse:false} as any
 })
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises()
  expect(wrapper.find('[role="tab"][aria-label="本机 + 虚拟机"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="云端 · Grok Bot"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('设备授权状态在 Bot 设置中查看')
 }finally{wrapper.unmount()}
})
it('checks desktop alongside cloud and never shows the legacy host option',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:true,running:false} as any
  return {...vm,enabled:false,container:'missing',ready:false,inUse:false} as any
 })
 const cloudAgent={...agent,computer:'cloud',execution:'profile'}
 const wrapper=mount(Panel,{props:{agents:[cloudAgent],isAdmin:true,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises()
  expect(wrapper.find('[aria-label="云端 · Grok Bot"]').exists()).toBe(false)
  expect(wrapper.find('.host-environment-option').exists()).toBe(false)
  for(const computer of ['auto','off','local','browser']){
   await wrapper.setProps({agents:[{...cloudAgent,computer}]});await flushPromises()
   expect(wrapper.find('.host-environment-option').exists()).toBe(false)
  }
 }finally{wrapper.unmount()}
})
it('shows only a notice in a Docker deployment, which has no virtual machines',async()=>{
 vi.mocked(apiRequest).mockImplementation(async()=>({supported:false,configured:false,daemonUp:false,image:false,mode:'shared',maxInstances:0,busy:false,problem:'Docker 版不支持虚拟机。'}) as any)
 const settings=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 try{
  await flushPromises()
  expect(settings.text()).toContain('Docker 版不支持虚拟机')
  expect(settings.find('[aria-label="虚拟机空闲停止时间"]').exists()).toBe(false)
  expect(settings.findAll('button').some(b=>b.text().includes('准备所选镜像'))).toBe(false)
 }finally{settings.unmount()}
})
it('sets account computer and per-computer desktop limits without any sharing mode',async()=>{
 vi.mocked(apiRequest).mockImplementation(async()=>vm as any)
 const settings=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 try{
  await flushPromises()
  expect(settings.text()).not.toContain('每个机器人独立')
  await settings.find('[aria-label="每台虚拟机的机器人桌面"]').setValue('6');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/admin/local-vm/policy',expect.objectContaining({method:'PUT',body:expect.objectContaining({maxInstances:2,maxDesktops:6})}))
 }finally{settings.unmount()}
})
it('starts, opens and stops only this Bot desktop from the chat panel',async()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 let detail:any={...vm,enabled:true,container:'running',ready:false,computerReady:true,inUse:false,desktops:1,imageKey:'standard'}
 vi.mocked(apiRequest).mockImplementation(async path=>{
  if(path.endsWith('/desktop-environment'))return {selected:null,local:{supported:false},browser:{available:false}} as any
  if(path.endsWith('/cloud-computer'))return {configured:false} as any
  if(path.includes('/computer/frame'))return {data:'',width:1,height:1,id:'f',generation:1,capturedAt:1} as any
  if(path.endsWith('/settings/host-tools'))return {vm:true,cloud:false} as any
  return detail
 })
 const wrapper=mount(Panel,{props:{agents:[agent],isAdmin:false,active:true},global:{stubs:{AppIcon:true,GrokAuthPanel:true}}})
 try{
  await flushPromises()
  expect(wrapper.text()).toContain('这个机器人有自己的桌面和浏览器资料')
  await wrapper.findAll('button').find(b=>b.text()==='启动 镜像测试 的桌面')!.trigger('click');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/local-vm/start',{method:'POST',body:{}})
  detail={...detail,ready:true,desktop:{display:2,running:true}}
  await wrapper.setProps({active:false});await wrapper.setProps({active:true});await flushPromises()
  expect(wrapper.findAll('button').some(b=>b.text()==='打开桌面')).toBe(true)
  expect(wrapper.text()).toContain('已分配 1/4 个机器人桌面')
  await wrapper.findAll('button').find(b=>b.text()==='停止桌面')!.trigger('click');await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/agents/image-fixture/local-vm/stop',{method:'POST',body:{}})
  expect(wrapper.findAll('button').some(b=>b.text()==='停止虚拟机')).toBe(false)
 }finally{wrapper.unmount()}
})
it('prepares the selected image in Settings and explains that each account computer uses one image',async()=>{
 vi.mocked(apiRequest).mockImplementation(async path=>path==='/api/app/computers'?{computers:[]}:vm as any)
 const wrapper=mount(Settings,{global:{stubs:{AppIcon:true,RunnerSettingsPanel:true}}})
 try{
  await flushPromises()
  const select=wrapper.findAll('select').find(select=>select.text().includes('Cursor Universal'))!
  await select.setValue('cursor')
  await wrapper.findAll('button').find(b=>b.text()==='重新检查所选镜像')!.trigger('click')
  await flushPromises()
  expect(apiRequest).toHaveBeenCalledWith('/api/app/admin/local-vm/prepare',expect.objectContaining({body:expect.objectContaining({imageKey:'cursor'})}))
  expect(wrapper.text()).toContain('每个账号的虚拟机使用其中一个')
 }finally{wrapper.unmount()}
})
it('selects a prepared image for the account computer and locks it while the computer exists',async()=>{
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
  detail={...detail,container:'stopped'}
  await wrapper.setProps({active:false});await wrapper.setProps({active:true});await flushPromises()
  expect(select.attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('镜像属于本账号的虚拟机，对所有机器人生效')
 }finally{wrapper.unmount()}
})
