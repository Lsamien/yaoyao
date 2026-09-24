import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import ComputerPanel from '@/components/workspace/ComputerPanel.vue'
import Preview from '@/components/workspace/LocalVmChatPanel.vue'
import Viewer from '@/views/ComputerViewerView.vue'
import BrowserToolbar from '@/components/workspace/BrowserToolbar.vue'
import {apiRequest} from '@/api/client'
import type {ManagedBrowserState} from '@shared/managedBrowser'

vi.mock('@/api/client',()=>({apiRequest:vi.fn()}))
const route={params:{agentId:'bot'},query:{} as Record<string,unknown>}
vi.mock('vue-router',()=>({useRoute:()=>route}))
const request=vi.mocked(apiRequest)
const agent={id:'bot',name:'竹儿',profile:'default',nodeId:'local'} as any
const permission={supported:true,authorized:true,screen:true,accessibility:true,ready:true,fullAuthorized:true}
const stubs={AppIcon:true,GrokAuthPanel:true}
let enabled:boolean|undefined,state:ManagedBrowserState,controlled:boolean,canResume:boolean
beforeEach(()=>{
  vi.spyOn(document,'hidden','get').mockReturnValue(false)
  route.query={};enabled=true;controlled=false;canResume=false
  state={enabled:true,available:true,supportsRetention:true,open:false,generation:4,profile:'temporary',tabs:[],downloads:[]}
  request.mockReset()
  request.mockImplementation(async(path,options)=>{
    const url=new URL(path,'http://fixture'),backend=url.searchParams.get('backend')
    if(url.pathname==='/api/app/agents')return {agents:[agent]} as any
    if(url.pathname.endsWith('/host-tools'))return {scriptMachine:true,serverComputer:true,cloud:true,vm:true,managedBrowser:enabled} as any
    if(url.pathname.endsWith('/desktop-environment'))return {hosts:[{id:'local',name:'服务器',online:true,local:permission}]} as any
    if(url.pathname.endsWith('/cloud-computer'))return {configured:true,running:true,connected:true} as any
    if(url.pathname.endsWith('/local-vm'))return {enabled:true,image:true,container:'running',ready:true} as any
    if(url.pathname.endsWith('/managed-browser'))return structuredClone(state) as any
    if(url.pathname.endsWith('/managed-browser/close')){controlled=false;state.open=false;state.tabs=[];return {mode:'off',backend:'managed-browser',generation:4} as any}
    if(url.pathname.endsWith('/managed-browser/action'))return {ok:true} as any
    if(url.pathname.endsWith('/frame'))return {id:'frame',data:backend,width:100,height:80,generation:4} as any
    if(url.pathname.includes('/computer')){
      if(options?.method==='POST'&&url.pathname.endsWith('/take')){
        controlled=true;if(!state.open)state.tabs=[{id:'tab',title:'示例页面',url:'https://example.com',active:true}];state.open=true
      }
      if(options?.method==='POST'&&url.pathname.endsWith('/giveback'))controlled=false
      return {mode:controlled?'human':backend==='managed-browser'&&!state.open?'off':'idle',backend:backend==='managed-browser'?'managed-browser':'local',hostName:'托管浏览器',generation:4,canResume,controlId:controlled?'control':undefined,token:'fixture-token'} as any
    }
    throw new Error(`Unexpected request ${path}`)
  })
})
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks()})

it.each([false,undefined])('keeps managed browsing absent with an off or older settings response (%s)',async(value)=>{
  enabled=value
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],standalone:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.find('option[value="managed-browser"]').exists()).toBe(false)
    expect(request.mock.calls.some(([path])=>path.includes('/managed-browser'))).toBe(false)
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
  }finally{wrapper.unmount()}
})

it('shows the independent browser beside existing environments without opening it during preview',async()=>{
  const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
  try{
    await flushPromises()
    for(const key of ['desktop:local','cloud','vm','managed-browser'])expect(wrapper.find(`option[value="${key}"]`).exists()).toBe(true)
    await wrapper.get('[aria-label="显示的桌面"]').setValue('managed-browser');await flushPromises()
    expect(wrapper.get('.preview').text()).toContain('浏览器尚未打开')
    expect(wrapper.find('.preview img').exists()).toBe(false)
    expect(request.mock.calls.some(([path,options])=>path.includes('managed-browser')&&options?.method==='POST')).toBe(false)
    const section=wrapper.get('[aria-label="托管浏览器"]')
    await section.get('button').trigger('click')
    expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'managed-browser',undefined])
    expect(request.mock.calls.some(([path])=>path.includes('/computer/take'))).toBe(false)
  }finally{wrapper.unmount()}
})

it('requires takeover before navigation and routes browser actions and Linux shortcuts to the managed target',async()=>{
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.text()).toContain('浏览器尚未打开')
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
    expect(wrapper.get('[aria-label="浏览器地址"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').find(button=>button.text()==='打开并控制')!.trigger('click');await flushPromises()
    expect(wrapper.get('.computer-screen img').attributes('src')).toContain('base64,managed-browser')
    expect(request.mock.calls.find(([path])=>path.includes('/computer/take'))?.[0]).toContain('backend=managed-browser')
    await wrapper.get('[aria-label="浏览器地址"]').setValue('https://example.org/')
    await wrapper.get('.browser-toolbar form').trigger('submit');await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/app/agents/bot/managed-browser/action',{method:'POST',body:expect.objectContaining({controlId:'control',token:'fixture-token',requestId:expect.any(String),generation:4,action:{kind:'navigate',url:'https://example.org/'}})})
    expect(request.mock.calls.some(([path])=>path.includes('/computer/browser')||path.endsWith('/browser'))).toBe(false)
    const action=request.mock.calls.find(([path])=>path.endsWith('/managed-browser/action'))?.[1]?.body
    expect(action).not.toHaveProperty('frameId')
    await wrapper.findAll('button').find(button=>button.text()==='键盘与操作')!.trigger('click')
    await wrapper.findAll('button').find(button=>button.text()==='全选')!.trigger('click');await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/app/agents/bot/computer/input?backend=managed-browser',{method:'POST',body:expect.objectContaining({generation:4,frameId:'frame',action:{kind:'key',key:'a',modifiers:['ctrl']}})})
    await wrapper.get('.computer-screen img').trigger('keydown',{key:'c',metaKey:true});await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/app/agents/bot/computer/input?backend=managed-browser',{method:'POST',body:expect.objectContaining({action:{kind:'key',key:'c',modifiers:['ctrl']}})})
    await wrapper.findAll('button').find(button=>button.text()==='结束接管')!.trigger('click');await flushPromises()
    expect(request.mock.calls.find(([path])=>path.includes('/giveback'))?.[0]).toContain('backend=managed-browser')
  }finally{wrapper.unmount()}
})

it('returns control and hides its viewer while keeping the same browser page open',async()=>{
  state.open=true;state.tabs=[{id:'retained',title:'跨任务保留的页面',url:'https://example.com/retained',active:true}]
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    await wrapper.get('.return-control').trigger('click');await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(request.mock.calls.filter(([path])=>path.includes('/giveback'))).toHaveLength(1)
    expect(request.mock.calls.some(([path])=>path.endsWith('/managed-browser/close'))).toBe(false)
    expect(state).toMatchObject({open:true,tabs:[{id:'retained'}]})
  }finally{wrapper.unmount()}
  const reopened=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(reopened.get('[aria-label="浏览器标签页"]').text()).toContain('跨任务保留的页面')
    expect(state.tabs[0]?.id).toBe('retained')
  }finally{reopened.unmount()}
})

it('explicitly closes only the managed browser using the current control receipt',async()=>{
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.find('.browser-session-actions').exists()).toBe(false)
    await wrapper.findAll('button').find(button=>button.text()==='打开并控制')!.trigger('click');await flushPromises()
    expect(wrapper.get('.return-control').text()).toBe('交还并收起')
    await wrapper.get('.browser-session-actions button').trigger('click');await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/app/agents/bot/managed-browser/close',{method:'POST',body:{controlId:'control',token:'fixture-token'}})
    expect(wrapper.find('.browser-session-actions').exists()).toBe(false)
    expect(wrapper.find('.computer-screen img').exists()).toBe(false)
    expect(wrapper.get('.return-control').text()).toBe('收起窗口')
    expect(wrapper.text()).toContain('浏览器尚未打开')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(request.mock.calls.some(([path,options])=>options?.method==='POST'&&(/local-vm|giveback/.test(path)))).toBe(false)
    expect(wrapper.emitted('changed')).toHaveLength(1)
  }finally{wrapper.unmount()}
})

it('does not allow closing the browser while a bot task can resume',async()=>{
  canResume=true
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.text()).toContain('人工控制中')
    expect(wrapper.find('.browser-session-actions').exists()).toBe(false)
    expect(request.mock.calls.some(([path])=>path.endsWith('/managed-browser/close'))).toBe(false)
  }finally{wrapper.unmount()}
})

it.each([
  [true,'交还或收起只会释放操作权，页面会保留'],
  [false,'此节点需更新后才能跨任务保留页面；任务结束后浏览器会关闭'],
  [undefined,'交还或收起会结束当前接管'],
] as const)('describes retention only when the node reports support (%s)',async(supportsRetention,description)=>{
  state.supportsRetention=supportsRetention
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    await wrapper.findAll('button').find(button=>button.text()==='键盘与操作')!.trigger('click')
    expect(wrapper.get('footer').text()).toContain(description)
    if(supportsRetention!==true)expect(wrapper.get('footer').text()).not.toContain('页面会保留')
    expect(request.mock.calls.some(([path])=>path.endsWith('/managed-browser/close'))).toBe(false)
  }finally{wrapper.unmount()}
})

it.each(['desktop','cloud','vm'] as const)('does not expose managed browser close for a %s target',async(backend)=>{
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend,standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.text()).toContain('人工控制中')
    expect(wrapper.find('.browser-session-actions').exists()).toBe(false)
    await wrapper.get('.return-control').trigger('click');await flushPromises()
    expect(request.mock.calls.some(([path])=>path.endsWith('/managed-browser/close'))).toBe(false)
  }finally{wrapper.unmount()}
})

it('retains control when explicit browser close fails so the user can retry or return it',async()=>{
  const original=request.getMockImplementation()!
  request.mockImplementation((path,options)=>path.endsWith('/managed-browser/close')?Promise.reject(new Error('浏览器仍被任务使用，请先交还')):original(path,options))
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    await wrapper.get('.browser-session-actions button').trigger('click');await flushPromises()
    expect(wrapper.text()).toContain('人工控制中')
    expect(wrapper.get('.browser-session-actions button').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('.return-control').text()).toBe('交还并收起')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(state.open).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toBe('浏览器仍被任务使用，请先交还')
  }finally{wrapper.unmount()}
})

it('never switches an unavailable requested browser to another computer',async()=>{
  state.available=false;state.reason='执行节点离线'
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.get('.browser-availability [role="status"]').text()).toBe('执行节点离线')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(request.mock.calls.some(([path])=>path.includes('/computer/take'))).toBe(false)
    expect(wrapper.find('.computer-screen img').exists()).toBe(false)
  }finally{wrapper.unmount()}
})

it('ignores browser metadata that arrives after a target switch',async()=>{
  state.open=true;state.tabs=[{id:'tab',title:'原页面',url:'https://example.com',active:true}]
  let release!:(value:unknown)=>void,count=0
  const original=request.getMockImplementation()!
  request.mockImplementation((path,options)=>path.endsWith('/managed-browser')&&++count===2?new Promise(resolve=>{release=resolve}):original(path,options))
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true},global:{stubs}})
  try{
    await flushPromises()
    await wrapper.get('[aria-label="切换电脑环境"]').setValue('desktop:local');await flushPromises()
    release({...state,tabs:[{id:'late',title:'延迟旧页面',url:'https://old.example',active:true}]});await flushPromises()
    expect(wrapper.findComponent(BrowserToolbar).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('延迟旧页面')
  }finally{wrapper.unmount()}
})

it('accepts managed browser native viewer links but rejects a host mixed into them',async()=>{
  route.query={backend:'managed-browser'}
  const wrapper=mount(Viewer,{global:{stubs:{ComputerPanel:true}}})
  try{await flushPromises();expect(wrapper.getComponent(ComputerPanel).props()).toMatchObject({backend:'managed-browser',autoTake:true})}finally{wrapper.unmount()}
  route.query={backend:'managed-browser',host:'local'}
  const invalid=mount(Viewer,{global:{stubs:{ComputerPanel:true}}})
  try{await flushPromises();expect(invalid.text()).toContain('所选电脑无效');expect(invalid.findComponent(ComputerPanel).exists()).toBe(false)}finally{invalid.unmount()}
})

it('keeps a missing browser selectable and prepares it once before automatic takeover',async()=>{
  vi.useFakeTimers()
  state.available=false;state.installation={status:'missing',message:'首次使用会自动准备 Chromium',updatedAt:1}
  const original=request.getMockImplementation()!
  request.mockImplementation(async(path,options)=>{
    if(path.endsWith('/managed-browser/prepare')){state.installation={status:'installing',message:'正在下载 Chromium 45%',progress:45,updatedAt:2};return structuredClone(state) as any}
    return original(path,options)
  })
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.get('option[value="managed-browser"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('正在下载 Chromium 45%')
    expect(wrapper.get('progress').attributes('value')).toBe('45')
    expect(request.mock.calls.filter(([path])=>path.endsWith('/prepare'))).toHaveLength(1)
    expect(request.mock.calls.some(([path])=>path.includes('/computer/take'))).toBe(false)
    state.available=true;state.installation={status:'ready',message:'浏览器已准备',updatedAt:3}
    await vi.advanceTimersByTimeAsync(1000);await flushPromises()
    expect(request.mock.calls.filter(([path])=>path.includes('/computer/take'))).toHaveLength(1)
    expect(wrapper.text()).toContain('人工控制中')
    expect(request.mock.calls.filter(([path])=>path.endsWith('/prepare'))).toHaveLength(1)
  }finally{wrapper.unmount()}
})

it('observes an existing installation without restarting it and cancels waiting when closed',async()=>{
  vi.useFakeTimers()
  state.available=false;state.installation={status:'installing',message:'正在下载 Chromium',updatedAt:1}
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(request.mock.calls.some(([path])=>path.endsWith('/prepare'))).toBe(false)
    expect(wrapper.get('.return-control').attributes('disabled')).toBeUndefined()
    await wrapper.get('.return-control').trigger('click');await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    const calls=request.mock.calls.length
    state.available=true;state.installation={status:'ready',message:'就绪',updatedAt:2}
    await vi.advanceTimersByTimeAsync(5000);await flushPromises()
    expect(request.mock.calls).toHaveLength(calls)
    expect(request.mock.calls.some(([path])=>path.includes('/computer/take'))).toBe(false)
  }finally{wrapper.unmount()}
})

it('shows installation failure with an explicit retry and resumes takeover after recovery',async()=>{
  vi.useFakeTimers()
  state.available=false;state.installation={status:'missing',message:'待准备',updatedAt:1}
  let attempts=0
  const original=request.getMockImplementation()!
  request.mockImplementation(async(path,options)=>{
    if(path.endsWith('/prepare')){
      attempts++
      state.installation=attempts===1?{status:'failed',message:'下载失败',error:'节点网络不可用',updatedAt:2}:{status:'ready',message:'已准备',updatedAt:3}
      state.available=attempts>1
      return structuredClone(state) as any
    }
    return original(path,options)
  })
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.text()).toContain('节点网络不可用')
    expect(attempts).toBe(1)
    await wrapper.findAll('button').find(button=>button.text()==='重试并接管浏览器')!.trigger('click');await flushPromises()
    expect(request.mock.calls.filter(([path])=>path.endsWith('/prepare')).at(-1)?.[1]?.body).toEqual({retry:true})
    expect(attempts).toBe(2)
    expect(wrapper.text()).toContain('人工控制中')
  }finally{wrapper.unmount()}
})

it('returns a takeover receipt that arrives after its viewer unmounts to the original browser',async()=>{
  let resolve!:(value:unknown)=>void
  const original=request.getMockImplementation()!
  request.mockImplementation((path,options)=>path.includes('/computer/take')?new Promise(done=>{resolve=done}):original(path,options))
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  await flushPromises();wrapper.unmount()
  resolve({mode:'human',controlId:'late-control',token:'late-token',generation:4});await flushPromises()
  expect(request).toHaveBeenCalledWith('/api/app/agents/bot/computer/giveback?backend=managed-browser',{method:'POST',body:{controlId:'late-control',token:'late-token',notes:''}})
})

it('exposes preparation in the side panel while read-only viewing never installs the browser',async()=>{
  state.available=false;state.installation={status:'missing',message:'首次接管将准备浏览器',updatedAt:1}
  const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
  try{
    await flushPromises()
    const browser=wrapper.get('[aria-label="托管浏览器"]')
    expect(browser.text()).toContain('首次接管将准备浏览器')
    expect(browser.get('button.primary').attributes('disabled')).toBeUndefined()
    expect(request.mock.calls.some(([path])=>path.endsWith('/prepare'))).toBe(false)
    await browser.get('button.primary').trigger('click')
    expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'managed-browser',undefined])
  }finally{wrapper.unmount()}
})

it('rechecks an offline browser in the side panel and restores takeover with GET requests only',async()=>{
  state.available=false;state.reason='执行节点离线'
  const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
  try{
    await flushPromises()
    await wrapper.get('[aria-label="显示的桌面"]').setValue('managed-browser');await flushPromises()
    const browser=wrapper.get('[aria-label="托管浏览器"]')
    expect(browser.get('button.primary').attributes('disabled')).toBeDefined()
    expect(browser.get('[role="status"]').text()).toBe('执行节点离线')
    expect(browser.find('progress').exists()).toBe(false)
    const before=request.mock.calls.length
    state.available=true;state.reason=undefined
    await browser.findAll('button').find(button=>button.text()==='重新检测')!.trigger('click');await flushPromises()
    expect(browser.get('button.primary').attributes('disabled')).toBeUndefined()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="显示的桌面"]').element.value).toBe('managed-browser')
    expect(request.mock.calls.slice(before).map(([path])=>path)).toEqual(['/api/app/agents/bot/managed-browser'])
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
    await browser.get('button.primary').trigger('click')
    expect(wrapper.emitted('desktop')?.at(-1)).toEqual([agent,'managed-browser',undefined])
  }finally{wrapper.unmount()}
})

it('recovers an explicitly selected browser after polling without starting or switching computers',async()=>{
  vi.useFakeTimers()
  state.available=false;state.reason='执行节点离线'
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true,autoTake:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.get('.browser-availability').text()).toContain('重新检测')
    expect(wrapper.find('progress').exists()).toBe(false)
    expect(wrapper.findAll('button').find(button=>button.text()==='打开并控制')!.attributes('disabled')).toBeDefined()
    state.available=true;state.reason=undefined
    await vi.advanceTimersByTimeAsync(1200);await flushPromises()
    expect(wrapper.findAll('button').find(button=>button.text()==='打开并控制')!.attributes('disabled')).toBeUndefined()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="切换电脑环境"]').element.value).toBe('managed-browser')
    expect(wrapper.find('.browser-availability').exists()).toBe(false)
    expect(request.mock.calls.filter(([path])=>path.includes('/computer')).every(([path])=>path.includes('backend=managed-browser'))).toBe(true)
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
  }finally{wrapper.unmount()}
})

it('refreshes viewer targets on explicit recheck without preparing the browser',async()=>{
  state.available=false;state.reason='执行节点离线'
  const wrapper=mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true},global:{stubs}})
  try{
    await flushPromises()
    const before=request.mock.calls.length
    state.reason=undefined;state.installation={status:'missing',message:'首次使用会自动准备 Chromium',updatedAt:1}
    await wrapper.get('.browser-availability button').trigger('click');await flushPromises()
    const calls=request.mock.calls.slice(before)
    expect(calls.some(([path])=>path.endsWith('/host-tools'))).toBe(true)
    expect(calls.some(([path])=>path.endsWith('/managed-browser'))).toBe(true)
    expect(calls.some(([,options])=>options?.method==='POST')).toBe(false)
    expect(wrapper.get('option[value="managed-browser"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('首次使用会自动准备 Chromium')
    expect(wrapper.find('progress').exists()).toBe(false)
  }finally{wrapper.unmount()}
})

it.each(['viewer','side panel'])('clears stale installation progress after a failed status read in the %s',async(view)=>{
  vi.useFakeTimers()
  state.available=false;state.installation={status:'installing',message:'正在下载 Chromium 40%',progress:40,updatedAt:1}
  const original=request.getMockImplementation()!
  let disconnected=false
  request.mockImplementation((path,options)=>disconnected&&path.endsWith('/managed-browser')?Promise.reject(new Error('执行节点连接已断开')):original(path,options))
  const wrapper=view==='viewer'
    ?mount(ComputerPanel,{props:{agents:[agent],backend:'managed-browser',standalone:true},global:{stubs}})
    :mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
  try{
    await flushPromises()
    expect(wrapper.find('progress').exists()).toBe(true)
    disconnected=true
    await vi.advanceTimersByTimeAsync(3000);await flushPromises()
    expect(wrapper.find('progress').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('正在下载 Chromium 40%')
    expect(wrapper.text()).toContain('执行节点连接已断开')
    expect(wrapper.text()).toContain('重新检测')
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
  }finally{wrapper.unmount()}
})

it('keeps a newer explicit browser detection result when an older periodic response arrives',async()=>{
  state.available=false;state.reason='执行节点离线'
  let release!:(value:unknown)=>void,count=0
  const original=request.getMockImplementation()!
  request.mockImplementation((path,options)=>path.endsWith('/managed-browser')&&++count===1?new Promise(resolve=>{release=resolve}):original(path,options))
  const wrapper=mount(Preview,{props:{agents:[agent],isAdmin:true,active:true},global:{stubs}})
  try{
    await flushPromises()
    const browser=wrapper.get('[aria-label="托管浏览器"]')
    state.available=true;state.reason=undefined
    await browser.findAll('button').find(button=>button.text()==='重新检测')!.trigger('click');await flushPromises()
    expect(browser.get('button.primary').attributes('disabled')).toBeUndefined()
    release({...state,available:false,reason:'过期的离线状态'});await flushPromises()
    expect(browser.get('button.primary').attributes('disabled')).toBeUndefined()
    expect(browser.text()).not.toContain('过期的离线状态')
    expect(request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
  }finally{wrapper.unmount()}
})
