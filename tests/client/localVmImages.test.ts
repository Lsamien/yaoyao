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
