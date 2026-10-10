import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import Preview from '../../src/client/components/workspace/LocalVmChatPanel.vue'
import ComputerPanel from '../../src/client/components/workspace/ComputerPanel.vue'
import Viewer from '../../src/client/views/ComputerViewerView.vue'
import {apiRequest} from '../../src/client/api/client'

vi.mock('../../src/client/api/client',()=>({apiRequest:vi.fn()}))
const route={params:{agentId:'bot'},query:{} as Record<string,unknown>}
vi.mock('vue-router',()=>({useRoute:()=>route}))
const agent={id:'bot',name:'竹儿',profile:'default',nodeId:'local'} as any
const permission={supported:true,authorized:true,screen:true,accessibility:true,ready:true,fullAuthorized:true}
let hosts:any[],readFrame:(key:string)=>unknown,vmProblem:string
const screenshot=(key:string)=>({id:key,data:key,width:100,height:80,generation:1})
const stubs={AppIcon:true,GrokAuthPanel:true,BrowserToolbar:true}
beforeEach(()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 route.query={}
 hosts=[{id:'local',name:'服务器',online:true,local:permission},{id:'client-mac',name:'Mac Studio',online:true,local:permission}]
 readFrame=screenshot
 vmProblem=''
 vi.mocked(apiRequest).mockImplementation(async(path,options:any)=>{
  const url=new URL(path,'http://fixture'),key=url.searchParams.get('host')||url.searchParams.get('backend')||'unspecified'
  if(url.pathname==='/api/app/agents')return {agents:[agent]} as any
  if(url.pathname.endsWith('/host-tools'))return {serverComputer:true,scriptMachine:true,cloud:true,vm:true} as any
  if(url.pathname.endsWith('/desktop-environment'))return {hosts:hosts.map(h=>({...h}))} as any
  if(url.pathname.endsWith('/cloud-computer'))return {configured:true,running:true,connected:true} as any
  if(url.pathname.endsWith('/cloud-computer/open'))return {} as any
  if(url.pathname.endsWith('/local-vm'))return {enabled:true,image:!vmProblem,container:vmProblem?'missing':'running',ready:!vmProblem,problem:vmProblem} as any
  if(url.pathname.endsWith('/frame'))return await readFrame(key) as any
  return {mode:options?.method==='POST'?'human':'idle',backend:key==='cloud'?'grok':key==='vm'?'docker':'local',generation:1,hostName:key,controlId:'control',token:'fixture-token'} as any
 })
})
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks()})

it('scopes an unavailable VM to its own settings while the cloud preview remains usable',async()=>{
 vmProblem='本地虚拟机执行节点尚未启用，请在本地虚拟机设置中完成配置'
 const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
 try{
  await flushPromises()
  expect(wrapper.get('[aria-label="显示的桌面"] option:checked').text()).toBe('自动 · 云虚拟机')
  expect(wrapper.get('.preview img').attributes('src')).toContain('base64,cloud')
  expect(wrapper.find('.panel-body > .problem').exists()).toBe(false)
  expect(wrapper.get('.computer-options [aria-label="本地虚拟机状态"]').text()).toBe(vmProblem)
  await wrapper.get('.preview').trigger('click');await flushPromises()
  expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'cloud',undefined])
  await wrapper.get('[aria-label="显示的桌面"]').setValue('vm');await flushPromises()
  expect(wrapper.get('.preview').text()).toContain(vmProblem)
  expect(wrapper.find('.preview img').exists()).toBe(false)
  expect(wrapper.get('.preview').attributes('disabled')).toBeDefined()
 }finally{wrapper.unmount()}
})

it('refreshes the selected preview immediately and never replaces it with a late frame from another computer',async()=>{
 const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
 try{
  await flushPromises()
  expect(wrapper.get('[aria-label="显示的桌面"] option:checked').text()).toBe('自动 · 本地虚拟机')
  expect(wrapper.get('.preview img').attributes('src')).toContain('base64,vm')
  let resolveClient!:(value:unknown)=>void
  readFrame=key=>key==='cloud'?new Promise(resolve=>{resolveClient=resolve}):screenshot(key)
  await wrapper.get('[aria-label="显示的桌面"]').setValue('cloud')
  await flushPromises()
  expect(wrapper.find('.preview img').exists()).toBe(false)
  expect(wrapper.get('.preview').attributes('disabled')).toBeDefined()
  await wrapper.get('[aria-label="显示的桌面"]').setValue('vm');await flushPromises()
  expect(wrapper.get('.preview img').attributes('src')).toContain('base64,vm')
  resolveClient(screenshot('stale-cloud'));await flushPromises()
  expect(wrapper.get('.preview img').attributes('src')).toContain('base64,vm')
  await wrapper.get('.preview').trigger('click');await flushPromises()
  expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'vm',undefined])
 }finally{wrapper.unmount()}
})

it('never exposes physical desktops or authorization in the computer panel',async()=>{
 const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
 try{
  await flushPromises()
  expect(wrapper.findAll('option').some(option=>option.attributes('value')?.startsWith('desktop:'))).toBe(false)
  expect(wrapper.find('.host-permission').exists()).toBe(false)
  expect(wrapper.findAll('button').some(button=>button.text().includes('授权'))).toBe(false)
  expect(vi.mocked(apiRequest).mock.calls.some(([path])=>path.endsWith('/desktop-environment'))).toBe(false)
 }finally{wrapper.unmount()}
})

it.each([
 ['cloud',undefined],['vm',undefined],
] as const)('opens and controls exactly the requested %s/%s target',async(backend,host)=>{
 const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend,host,standalone:true,autoTake:true},global:{stubs}})
 try{
  await flushPromises()
  const call=vi.mocked(apiRequest).mock.calls.find(([path])=>path.includes('/computer/take'))!
  const url=new URL(call[0],'http://fixture')
  expect(url.searchParams.get('backend')).toBe(backend)
  expect(url.searchParams.get('host')).toBe(host??null)
  expect(wrapper.get('.computer-screen img').attributes('src')).toContain('base64,'+(host||backend))
 }finally{wrapper.unmount()}
})

it.each(['local','client-mac','missing-host'])('rejects the physical desktop %s without falling back',async(host)=>{
 const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'desktop',host,standalone:true,autoTake:true},global:{stubs}})
 try{
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('所选电脑不可用')
  expect(vi.mocked(apiRequest).mock.calls.some(([path])=>path.includes('/computer/take'))).toBe(false)
  expect(wrapper.find('.computer-screen img').exists()).toBe(false)
 }finally{wrapper.unmount()}
})

it('passes the native window URL target into the viewer and rejects malformed targets',async()=>{
 route.query={backend:'cloud'}
 const wrapper=mount(Viewer,{global:{stubs:{ComputerPanel:true}}})
 try{
  await flushPromises()
  expect(wrapper.getComponent(ComputerPanel).props()).toMatchObject({backend:'cloud',host:undefined,autoTake:true})
 }finally{wrapper.unmount()}
 route.query={backend:'vm',host:'client-mac'}
 const invalid=mount(Viewer,{global:{stubs:{ComputerPanel:true}}})
 try{
  await flushPromises();expect(invalid.text()).toContain('所选电脑无效')
  expect(invalid.findComponent(ComputerPanel).exists()).toBe(false)
 }finally{invalid.unmount()}
})
