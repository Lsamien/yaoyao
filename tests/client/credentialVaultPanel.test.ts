import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CredentialVaultPanel from '@/components/app/CredentialVaultPanel.vue'
const api=vi.hoisted(()=>vi.fn())
vi.mock('@/api/client',()=>({apiRequest:api}))
let wrapper:VueWrapper|undefined
const initial={protocol:1,online:true,initialized:true,unlocked:false,execution:'disabled',entries:[],leases:[],tasks:[],requests:[]}
let state:any
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return {resolve,promise}}
beforeEach(()=>{state=structuredClone(initial);api.mockImplementation(async(_path,options)=>options?.method==='POST'?{}:structuredClone(state))})
afterEach(()=>{wrapper?.unmount();wrapper=undefined;vi.useRealTimers();vi.restoreAllMocks();api.mockReset()})
async function setup(){wrapper=mount(CredentialVaultPanel);await flushPromises();return wrapper}
it('shows an offline state without offering secret entry and explicitly keeps real login disabled',async()=>{
  state.online=false;const w=await setup()
  expect(w.find('input[type=password]').exists()).toBe(false);expect(w.text()).toContain('尚未启用');expect(w.text()).toContain('不会自动安装或启动服务')
})
it('preserves a master password draft while locked status is polled, then clears it after manual unlock',async()=>{
  vi.useFakeTimers();const storage=vi.spyOn(Storage.prototype,'setItem'),w=await setup(),input=w.get<HTMLInputElement>('input[type=password]')
  await input.setValue('DUMMY-ONLY-master');await vi.advanceTimersByTimeAsync(3000);await flushPromises();expect(input.element.value).toBe('DUMMY-ONLY-master')
  await w.get('form').trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/unlock',expect.objectContaining({method:'POST',body:{password:'DUMMY-ONLY-master',seconds:300}}))
  expect(input.element.value).toBe('');expect(storage).not.toHaveBeenCalled()
})
it('checks confirmation before initialization and leaves no draft in unmounted UI',async()=>{
  state.initialized=false;const w=await setup(),inputs=w.findAll('input[type=password]')
  await inputs[0]!.setValue('dummy-master-A');await inputs[1]!.setValue('dummy-master-B');await w.get('form').trigger('submit')
  expect(w.get('[role=alert]').text()).toContain('不一致');expect(api.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0)
  w.unmount();wrapper=undefined
})
it('editing exposes no saved secret and omits a blank replacement in the request',async()=>{
  state.unlocked=true;state.entries=[{id:'dummy-id',name:'dummy',username:'fixture',target:{kind:'website',origin:'https://example.test'},revision:3,updatedAt:1}]
  const w=await setup();await w.findAll('button').find(b=>b.text()==='编辑')!.trigger('click')
  const password=w.get<HTMLInputElement>('input[type=password]');expect(password.element.value).toBe('')
  await w.findAll('form')[0]!.trigger('submit');await flushPromises()
  const call=api.mock.calls.find(([p,o])=>p==='/api/app/vault/entries/dummy-id'&&o.method==='PUT')!
  expect(call[1].body).not.toHaveProperty('secret');expect(call[1].body.revision).toBe(3)
  expect(api.mock.calls.some(([p])=>p.includes('read-secret'))).toBe(false)
})
it('unmount aborts an in-flight unlock and sends an explicit lock without a password',async()=>{
  const w=await setup();await w.get('input[type=password]').setValue('dummy-master-only')
  const pending=deferred();api.mockImplementation((p)=>p.endsWith('/unlock')?pending.promise:Promise.resolve({}))
  await w.get('form').trigger('submit');const call=api.mock.calls.find(([p])=>p.endsWith('/unlock'))!
  w.unmount();wrapper=undefined;expect(call[1].signal.aborted).toBe(true)
  expect(api).toHaveBeenCalledWith('/api/app/vault/lock',expect.objectContaining({body:{}}));pending.resolve({});await flushPromises()
})
it('hiding the page locks even while unlock is still pending',async()=>{
  const w=await setup();await w.get('input[type=password]').setValue('dummy-master-only')
  const pending=deferred();api.mockImplementation(p=>p.endsWith('/unlock')?pending.promise:Promise.resolve({}))
  await w.get('form').trigger('submit');const call=api.mock.calls.find(([p])=>p.endsWith('/unlock'))!
  vi.spyOn(document,'hidden','get').mockReturnValue(true);document.dispatchEvent(new Event('visibilitychange'))
  await w.vm.$nextTick()
  expect(call[1].signal.aborted).toBe(true);expect(api).toHaveBeenCalledWith('/api/app/vault/lock',expect.objectContaining({body:{}}))
  expect(w.get<HTMLInputElement>('input[type=password]').element.value).toBe('');pending.resolve({});await flushPromises()
})
it('configures an encrypted fixed SFTP body in the dedicated UI, clears it after save and never reads it back',async()=>{
  state.unlocked=true;state.execution='protected-adapters';const w=await setup()
  await w.findAll('button').find(b=>b.text()==='添加凭据')!.trigger('click')
  const editor=w.findAll('form')[0]!
  await editor.get('select').setValue('ssh');await editor.get('input[type=checkbox]').setValue(true)
  await editor.findAll('select')[1]!.setValue('sftp.write')
  const label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  await label('名称').get('input').setValue('dummy transfer');await label('用户名').get('input').setValue('dummy')
  await label('SSH 主机').get('input').setValue('127.0.0.1');await label('已人工确认').get('input').setValue('SHA256:'+'A'.repeat(43))
  await label('私钥').get('textarea').setValue('DUMMY-private-key');await label('批准的远端').get('input').setValue('/approved/new.txt')
  await label('固定写入正文').get('textarea').setValue('DUMMY-private-write-body')
  await editor.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/entries',expect.objectContaining({method:'POST',body:expect.objectContaining({usage:{kind:'sftp.write',remotePath:'/approved/new.txt',contents:'DUMMY-private-write-body'}})}))
  expect(w.find('textarea').exists()).toBe(false);expect(w.text()).not.toContain('DUMMY-private-write-body')
})
