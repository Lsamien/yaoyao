import {flushPromises,mount} from '@vue/test-utils'
import {beforeEach,expect,it,vi} from 'vitest'
import ExecutionSettingsPanel from '@/components/app/ExecutionSettingsPanel.vue'
import {apiRequest} from '@/api/client'
vi.mock('@/api/client',()=>({apiRequest:vi.fn()}))
const request=vi.mocked(apiRequest)
const initial=()=>({execution:{mode:'none',revision:1,credentialSource:'yaoyao'},proxy:{enabled:true,protocol:'http',host:'proxy.test',port:8080,username:'',revision:2,hasPassword:true},resources:[],agents:[{id:'fixture-bot',name:'夭夭',owner:'admin'}],nodes:[],activeTurns:[]})
beforeEach(()=>{request.mockReset();request.mockImplementation(async()=>initial() as never)})
it('saves an explicit system environment without changing model settings',async()=>{
  const wrapper=mount(ExecutionSettingsPanel);await flushPromises()
  await wrapper.findAll('select')[0]!.setValue('virtual');await wrapper.findAll('form')[0]!.trigger('submit');await flushPromises()
  expect(request).toHaveBeenCalledWith('/api/app/admin/execution/environment',{method:'PUT',body:{mode:'virtual',revision:1}})
  expect(wrapper.text()).toContain('下一轮任务生效');wrapper.unmount()
})
it('keeps proxy credentials write-only and allows explicitly clearing the saved password',async()=>{
  const wrapper=mount(ExecutionSettingsPanel);await flushPromises()
  const clear=wrapper.findAll('label').find(l=>l.text().includes('清除已保存的代理密码'))!.get('input')
  await clear.setValue(true);await wrapper.findAll('form').at(-1)!.trigger('submit');await flushPromises()
  expect(request).toHaveBeenCalledWith('/api/app/admin/execution/proxy',expect.objectContaining({method:'PUT',body:expect.objectContaining({password:'',revision:2})}))
  expect(JSON.stringify(request.mock.calls)).not.toContain('hasPassword');wrapper.unmount()
})
it('does not grant new resources to every Bot and reports invalid variable JSON without sending it',async()=>{
  const wrapper=mount(ExecutionSettingsPanel,{global:{stubs:{StandaloneDialog:{template:'<div role="dialog"><slot /></div>'}}}});await flushPromises()
  await wrapper.findAll('button').find(b=>b.text()==='添加授权或变量')!.trigger('click')
  await wrapper.get('[role=dialog] select').setValue('variables')
  expect(wrapper.findAll('fieldset input').every(i=>!(i.element as HTMLInputElement).checked)).toBe(true)
  await wrapper.get('textarea').setValue('{broken')
  const count=request.mock.calls.length;await wrapper.findAll('form')[1]!.trigger('submit');await flushPromises()
  expect(request.mock.calls.length).toBe(count);expect(wrapper.get('[role=alert]').text()).not.toBe('');wrapper.unmount()
})
it('shows the node readiness failure instead of blaming proxy credentials',async()=>{
  const wrapper=mount(ExecutionSettingsPanel);await flushPromises()
  request.mockResolvedValueOnce({nodes:[{name:'本机虚拟机',ok:false,error:'缺少虚拟机网络网关，请重新准备网络镜像'}]})
  await wrapper.findAll('button').find(b=>b.text()==='测试已保存的代理')!.trigger('click');await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toBe('本机虚拟机：缺少虚拟机网络网关，请重新准备网络镜像')
  expect(wrapper.find('[role=status]').exists()).toBe(false);wrapper.unmount()
})
