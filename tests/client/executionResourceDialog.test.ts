import {flushPromises,mount,type VueWrapper} from '@vue/test-utils'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import Dialog from '@/components/app/ExecutionResourceDialog.vue'
import {apiRequest} from '@/api/client'
vi.mock('@/api/client',()=>({apiRequest:vi.fn()}))
const request=vi.mocked(apiRequest),root='/api/app/admin/execution'
let wrapper:VueWrapper
const mountDialog=(resource?:any)=>mount(Dialog,{props:{agents:[{id:'bot-1',name:'夭夭',owner:'admin'}],resource},global:{stubs:{StandaloneDialog:{template:'<div role="dialog"><slot /></div>'}}}})
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!
beforeEach(()=>{request.mockReset();vi.spyOn(window,'open').mockReturnValue(null);request.mockResolvedValue({})})
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks();vi.useRealTimers()})
it('defaults to browser login, opens on the click, polls completion and saves only the attempt reference',async()=>{
  vi.useFakeTimers();let resolveStart!:(value:any)=>void
  request.mockImplementation(async(path,options)=>{
    if(path===root+'/codex-auth')return new Promise(resolve=>{resolveStart=resolve})
    if(path.startsWith(root+'/codex-auth/')&&!options?.method)return {id:'attempt',status:'authorized',expiresAt:Date.now()+60000}
    return {}
  })
  wrapper=mountDialog();expect(button('浏览器授权（推荐）').attributes('aria-pressed')).toBe('true')
  expect(wrapper.find('input[type=file]').exists()).toBe(false);expect(button('保存授权').attributes('disabled')).toBeDefined()
  await button('打开浏览器授权').trigger('click')
  expect(window.open).toHaveBeenCalledWith('https://auth.openai.com/codex/device','_blank',expect.stringContaining('noopener'))
  expect(wrapper.text()).toContain('正在获取授权码')
  const id=(request.mock.calls[0]![1]!.body as any).requestId
  resolveStart({id,status:'pending',loginUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-12345',expiresAt:Date.now()+60000});await flushPromises()
  expect(wrapper.get('a').attributes('href')).toBe('https://auth.openai.com/codex/device')
  expect(wrapper.text()).toContain('ABCD-12345')
  await vi.advanceTimersByTimeAsync(1500);await flushPromises()
  expect(wrapper.text()).toContain('浏览器授权成功')
  await wrapper.get('input[maxlength="80"]').setValue('工作账号');await wrapper.get('input[type=checkbox]').setValue(true)
  await wrapper.get('form').trigger('submit');await flushPromises()
  expect(request).toHaveBeenCalledWith(root+'/resources',{method:'POST',body:{name:'工作账号',kind:'codex',agentIds:['bot-1'],revision:0,authAttemptId:'attempt'}})
  expect(wrapper.emitted('saved')).toHaveLength(1)
})
it('cancels a late login response when switching to file import and keeps file grants explicit',async()=>{
  let finish!:(v:any)=>void
  request.mockImplementation(async path=>path===root+'/codex-auth'?new Promise(resolve=>{finish=resolve}):{})
  wrapper=mountDialog();await button('打开浏览器授权').trigger('click')
  const id=(request.mock.calls[0]![1]!.body as any).requestId
  await button('导入授权文件').trigger('click')
  finish({id,status:'authorized',expiresAt:Date.now()+60000});await flushPromises()
  expect(request).toHaveBeenCalledWith(root+'/codex-auth/'+id,{method:'DELETE'})
  expect(wrapper.text()).not.toContain('浏览器授权成功')
  const input=wrapper.get('input[type=file]'),content=JSON.stringify({tokens:{access_token:'fixture-secret'}})
  Object.defineProperty(input.element,'files',{value:[{name:'auth.json',size:content.length,text:async()=>content}]})
  await input.trigger('change');await flushPromises();expect(wrapper.text()).toContain('已读取 auth.json')
  expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
  await wrapper.get('input[maxlength="80"]').setValue('导入账号');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(request).toHaveBeenCalledWith(root+'/resources',{method:'POST',body:{name:'导入账号',kind:'codex',agentIds:[],revision:0,authJson:content}})
})
it('validates pasted credentials without echoing secret content in the error',async()=>{
  wrapper=mountDialog();await button('导入授权文件').trigger('click')
  await wrapper.get('details textarea').setValue('invalid fixture-secret');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toBe('请选择有效的 Codex auth.json 授权文件')
  expect(request).not.toHaveBeenCalled()
})
it('retains an existing login when only changing its name or grants',async()=>{
  wrapper=mountDialog({id:'resource',kind:'codex',name:'旧账号',agentIds:['bot-1'],revision:2})
  await wrapper.get('input[maxlength="80"]').setValue('新名称');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(request).toHaveBeenCalledWith(root+'/resources/resource',{method:'PUT',body:{name:'新名称',kind:'codex',agentIds:['bot-1'],revision:2}})
})
it('shows failed and expired login states and permits a fresh attempt',async()=>{
  request.mockResolvedValue({id:'attempt',status:'expired',expiresAt:0})
  wrapper=mountDialog();await button('打开浏览器授权').trigger('click');await flushPromises()
  expect(wrapper.text()).toContain('授权已过期');expect(button('保存授权').attributes('disabled')).toBeDefined()
  request.mockResolvedValue({id:'next',status:'failed',expiresAt:0,error:'服务器未找到 Codex CLI'})
  await button('打开浏览器授权').trigger('click');await flushPromises();expect(wrapper.text()).toContain('未找到 Codex CLI')
})
