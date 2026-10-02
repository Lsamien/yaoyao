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
it('offers local credential management and persistent Bot approval without requiring an independent service',async()=>{
  state.initialized=false;state.storageMode='local';state.execution='local-adapters';const w=await setup()
  expect(w.text()).toContain('授权一次即可使用');expect(w.text()).toContain('创建密码库')
  state.initialized=true;state.unlocked=true
  await w.findAll('button').find(b=>b.text()==='刷新状态')!.trigger('click');await flushPromises()
  await w.findAll('button').find(b=>b.text()==='添加凭据')!.trigger('click')
  const editor=w.findAll('form')[0]!,label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  await label('名称').get('input').setValue('Dummy site');await label('用户名').get('input').setValue('dummy')
  await label('准确网站').get('input').setValue('https://example.test');await label('密码').get('input').setValue('DUMMY-new-secret')
  await editor.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/entries',expect.objectContaining({method:'POST',body:{name:'Dummy site',username:'dummy',target:{kind:'website',origin:'https://example.test'},secret:'DUMMY-new-secret'}}))
  expect(w.findAll('button').find(b=>b.text()==='授权此 Bot 使用')!.attributes('disabled')).toBeDefined()
  expect(w.text()).not.toContain('DUMMY-new-secret');expect(w.find('input[type=password]').exists()).toBe(true)
})
it('reports a wrong vault master password without expiring the application login or echoing errors',async()=>{
  const w=await setup();await w.get('input[type=password]').setValue('DUMMY-wrong-master')
  api.mockImplementation(async(path)=>{if(path.endsWith('/unlock'))throw Object.assign(new Error('DUMMY-private-error-DUMMY-wrong-master'),{code:'vault_unlock_failed'});return structuredClone(state)})
  await w.get('form').trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/unlock',expect.objectContaining({notifyUnauthorized:false}))
  expect(w.get('[role=alert]').text()).toContain('主密码错误');expect(w.text()).not.toContain('DUMMY-private-error');expect(w.text()).not.toContain('DUMMY-wrong-master')
  expect(w.get<HTMLInputElement>('input[type=password]').element.value).toBe('')
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
  await editor.findAll('label').find(l=>l.text().startsWith('SSH 认证方式'))!.get('select').setValue('privateKey')
  await editor.findAll('label').find(l=>l.text().startsWith('允许操作'))!.get('select').setValue('sftp.write')
  const label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  await label('名称').get('input').setValue('dummy transfer');await label('用户名').get('input').setValue('dummy')
  await label('SSH 主机').get('input').setValue('127.0.0.1');await label('服务器指纹').get('input').setValue('SHA256:'+'A'.repeat(43))
  await label('私钥').get('textarea').setValue('DUMMY-private-key');await label('批准的远端').get('input').setValue('/approved/new.txt')
  await label('固定写入正文').get('textarea').setValue('DUMMY-private-write-body')
  await editor.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/entries',expect.objectContaining({method:'POST',body:expect.objectContaining({usage:{kind:'sftp.write',remotePath:'/approved/new.txt',contents:'DUMMY-private-write-body'}})}))
  expect(w.find('textarea').exists()).toBe(false);expect(w.text()).not.toContain('DUMMY-private-write-body')
})

it('defaults to a masked SSH password and saves it without a host fingerprint or opening advanced settings',async()=>{
  state.unlocked=true;state.storageMode='local';const w=await setup()
  await w.findAll('button').find(b=>b.text()==='添加凭据')!.trigger('click')
  const editor=w.get('form'),label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  await label('用途').get('select').setValue('ssh');expect(label('SSH 认证方式').get('select').element.value).toBe('password')
  expect(editor.get('details').attributes('open')).toBeUndefined();expect(label('服务器指纹').get('input').attributes('required')).toBeUndefined()
  await label('名称').get('input').setValue('Dummy password SSH');await label('用户名').get('input').setValue('dummy')
  await label('SSH 主机').get('input').setValue('ssh.example.test')
  const field=label('SSH 登录密码').get<HTMLInputElement>('input');expect(field.attributes('type')).toBe('password')
  await field.setValue('DUMMY-ssh-login-password')
  expect(editor.text()).not.toContain('私钥口令');expect(editor.find('textarea').exists()).toBe(false)
  await editor.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/entries',expect.objectContaining({method:'POST',body:{name:'Dummy password SSH',username:'dummy',target:{kind:'ssh',host:'ssh.example.test',port:22,auth:'password'},secret:'DUMMY-ssh-login-password'}}))
  expect(w.text()).not.toContain('DUMMY-ssh-login-password');expect(w.text()).toContain('授权 Bot 使用')
})

it('clears SSH secret drafts on authentication changes and requires a new secret when editing a legacy key entry',async()=>{
  state.unlocked=true;state.storageMode='local';state.entries=[{id:'legacy-id',name:'legacy SSH',username:'dummy',target:{kind:'ssh',host:'ssh.example.test',port:22,hostKey:'SHA256:'+'A'.repeat(43)},revision:2,updatedAt:1}]
  const w=await setup();await w.findAll('button').find(b=>b.text()==='编辑')!.trigger('click')
  const editor=w.get('form'),label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  expect(label('SSH 认证方式').get('select').element.value).toBe('privateKey')
  await label('私钥').get('textarea').setValue('DUMMY-private-key-draft');await label('私钥口令').get('input').setValue('DUMMY-passphrase-draft')
  await label('SSH 认证方式').get('select').setValue('password')
  const field=label('SSH 登录密码').get<HTMLInputElement>('input')
  expect(field.element.value).toBe('');expect(field.attributes('required')).toBeDefined()
  await editor.trigger('submit');await flushPromises()
  expect(w.get('[role=alert]').text()).toContain('重新填写');expect(api.mock.calls.some(([,o])=>o?.method==='PUT')).toBe(false)
  await field.setValue('DUMMY-replacement-password');await editor.trigger('submit');await flushPromises()
  const body=api.mock.calls.find(([p,o])=>p.endsWith('/legacy-id')&&o.method==='PUT')![1].body
  expect(body).toMatchObject({target:{auth:'password'},secret:'DUMMY-replacement-password',revision:2});expect(body).not.toHaveProperty('passphrase')
  expect(JSON.stringify(body)).not.toContain('DUMMY-private-key-draft')
})

it('keeps an existing SSH password when its masked replacement field is left blank',async()=>{
  state.unlocked=true;state.storageMode='local';state.entries=[{id:'password-id',name:'password SSH',username:'dummy',target:{kind:'ssh',host:'ssh.example.test',port:22,hostKey:'SHA256:'+'A'.repeat(43),auth:'password'},revision:3,updatedAt:1}]
  const w=await setup();await w.findAll('button').find(b=>b.text()==='编辑')!.trigger('click')
  const field=w.get<HTMLInputElement>('input[type=password]');expect(field.element.value).toBe('');expect(field.attributes('required')).toBeUndefined()
  await w.get('form').trigger('submit');await flushPromises()
  const body=api.mock.calls.find(([p,o])=>p.endsWith('/password-id')&&o.method==='PUT')![1].body
  expect(body.target.auth).toBe('password');expect(body).not.toHaveProperty('secret');expect(body).not.toHaveProperty('passphrase')
})

it.each(['pinned','first-use'])('grants a %s local credential to a specified Bot without a task or secret in the approval request',async trust=>{
  state.unlocked=true;state.storageMode='local';state.execution='local-adapters'
  state.entries=[{id:'credential-id',name:'SSH test',username:'dummy',target:{kind:'ssh',host:'ssh.example.test',port:22,...(trust==='pinned'?{hostKey:'SHA256:'+'A'.repeat(43)}:{}),auth:'password'},usage:{kind:'ssh.exec',command:'/usr/bin/uptime'},revision:1,updatedAt:1}]
  state.tasks=[{workId:'work-id',agentId:'bot-id',name:'Current Bot task'}]
  state.bots=[{id:'bot-id',name:'Selected Bot'}]
  state.requests=[{workId:'work-id',agentId:'bot-id',credentialRef:'credential-id',operation:'ssh.exec'}]
  const w=await setup(),button=w.findAll('button').find(b=>b.text()==='授权此 Bot 使用')!
  expect(button.attributes('disabled')).toBeDefined()
  const label=(text:string)=>w.findAll('label').find(l=>l.text().startsWith(text))!
  await label('凭据').get('select').setValue('credential-id')
  if(trust==='first-use')expect(w.text()).toContain('首次使用会自动记住服务器指纹')
  await label('Bot').get('select').setValue('bot-id')
  expect(button.attributes('disabled')).toBeUndefined()
  await w.findAll('form')[0]!.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/bot-grant',expect.objectContaining({method:'POST',body:{credentialRef:'credential-id',agentId:'bot-id'}}))
  expect(w.text()).toContain('此 Bot 已获持续授权');expect(w.text()).not.toContain('本次任务授权')
})

it('shows persistent approval while locked and saves explicit Bot approval together with a configured entry',async()=>{
  state.storageMode='local';state.bots=[{id:'selected-bot',name:'竹儿'}];state.botGrants=[{credentialRef:'entry-id',agentId:'selected-bot',name:'SSH test',operation:'ssh.exec'}]
  const w=await setup();expect(w.text()).toContain('SSH test → 竹儿 · 已持续授权')
  expect(w.findAll('button').find(b=>b.text()==='撤销 Bot 授权')!.attributes('disabled')).toBeDefined()
  state.unlocked=true;await w.findAll('button').find(b=>b.text()==='刷新状态')!.trigger('click');await flushPromises()
  await w.findAll('button').find(b=>b.text()==='添加凭据')!.trigger('click')
  const editor=w.get('form'),label=(text:string)=>editor.findAll('label').find(l=>l.text().startsWith(text))!
  await label('名称').get('input').setValue('SSH new');await label('用户名').get('input').setValue('dummy')
  await label('用途').get('select').setValue('ssh');await label('SSH 主机').get('input').setValue('127.0.0.1')
  await label('SSH 登录密码').get('input').setValue('DUMMY-new-password')
  await label('授权给 Bot').get('select').setValue('selected-bot')
  api.mockImplementation(async(p,o)=>p.endsWith('/entries')?{id:'new-entry'}:o?.method==='POST'?{}:structuredClone(state))
  await editor.trigger('submit');await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/app/vault/bot-grant',expect.objectContaining({body:{credentialRef:'new-entry',agentId:'selected-bot'}}))
  expect(w.text()).toContain('凭据已加密保存并授权所选 Bot');expect(w.text()).not.toContain('DUMMY-new-password')
})
