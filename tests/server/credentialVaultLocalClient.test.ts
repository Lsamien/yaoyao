// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createCredentialVaultClient, LocalCredentialVaultClient } from '../../src/server/credentialVault/localClient'
import { sshFixture } from '../fixtures/credentialProtocols'

const homes: string[] = [], clients: LocalCredentialVaultClient[] = []
const session = 'a'.repeat(64), password = 'DUMMY-local-master-only', secret = 'DUMMY-local-website-secret'
function client(home = mkdtempSync(join(tmpdir(), 'yaoyao-local-vault-'))) {
  if (!homes.includes(home)) homes.push(home)
  const value = new LocalCredentialVaultClient(home); clients.push(value)
  return { home, value, call: (command: string, body?: unknown, owner = 'dummy-owner', binding = session) => value.call(owner, binding, command, body) }
}
afterEach(async () => { clients.splice(0).forEach(c => c.close()); await Promise.resolve(); homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })) })

it('provides encrypted local CRUD and bounded task execution by default without an external service', async () => {
  const f = client()
  expect(await f.call('status')).toMatchObject({ online: true, initialized: false, unlocked: false, execution: 'local-adapters', reason: 'local_controlled', storageMode: 'local' })
  await f.call('initialize', { password })
  await expect(f.call('add', {})).rejects.toMatchObject({ code: 'vault_locked' })
  await f.call('unlock', { password })
  const entry = await f.call('add', { name: 'Dummy website', username: 'dummy', target: { kind: 'website', origin: 'https://example.test' }, secret })
  expect(entry).not.toHaveProperty('secret')
  const stored = readdirSync(join(f.home, 'credential-vault')).filter(name => name.endsWith('.vault')).map(name => readFileSync(join(f.home, 'credential-vault', name), 'utf8')).join('')
  expect(stored).not.toContain(secret); expect(stored).not.toContain(password); expect(stored).not.toContain('Dummy website')
  expect((await f.call('status')).entries).toHaveLength(1)
  await expect(f.call('read-secret', {id:entry.id})).rejects.toMatchObject({ code: 'vault_command_unknown' })
  await f.call('update', { id: entry.id, entry: { name: 'Updated', username: 'dummy', target: entry.target, revision: entry.revision } })
  expect((await f.call('status')).entries[0].name).toBe('Updated')
  await f.call('remove', { id: entry.id }); expect((await f.call('status')).entries).toEqual([])
})

it('binds one-use local execution to the owner and session and requires a configured usage policy',async()=>{
  const f=client();await f.call('initialize',{password});await f.call('unlock',{password})
  const entry=await f.call('add',{name:'Dummy',username:'dummy',target:{kind:'website',origin:'https://example.test'},secret})
  const input={credentialRef:entry.id,agentId:randomUUID(),workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'website.login',target:entry.target,seconds:60}
  const lease=await f.call('grant',input)
  await expect(f.call('execute',{id:lease.id,input},'another-owner')).rejects.toMatchObject({code:'vault_lease_revoked'})
  await expect(f.call('execute',{id:lease.id,input},'dummy-owner','b'.repeat(64))).rejects.toMatchObject({code:'vault_scope_forbidden'})
  expect(await f.call('execute',{id:lease.id,input})).toEqual({status:'manual_takeover_required',reason:'usage_policy_required',submitted:false})
  await expect(f.call('execute',{id:lease.id,input})).rejects.toMatchObject({code:'vault_lease_revoked'})
})

it('saves SSH offline, remembers the first host without authenticating, persists its pin and rejects a changed host before sending a password',async()=>{
  const f=client();await f.call('initialize',{password});await f.call('unlock',{password})
  let ssh=await sshFixture('password')
  try{
    const {hostKey:_initialKey,...target}=ssh.target
    await ssh.close() // The server is actually offline while the password is saved.
    const entry=await f.call('add',{name:'Dummy SSH',username:ssh.username,target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    ssh=await sshFixture('password',target.port);const hostKey=ssh.target.hostKey
    const input={credentialRef:entry.id,agentId:randomUUID(),workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target,seconds:60}
    expect(ssh.state.authMethods).toEqual([])
    await expect(f.call('grant',input)).rejects.toMatchObject({code:'vault_host_key_required'})
    await expect(f.call('prepare-host',{id:entry.id,revision:entry.revision},'dummy-owner','b'.repeat(64))).rejects.toMatchObject({code:'vault_locked'})
    const prepared=await f.call('prepare-host',{id:entry.id,revision:entry.revision})
    expect(prepared.target.hostKey).toBe(hostKey);expect(ssh.state.authMethods).toEqual([])
    await f.call('lock');await f.call('unlock',{password});expect((await f.call('status')).entries[0].target.hostKey).toBe(hostKey)
    const port=target.port;await ssh.close();ssh=await sshFixture('password',port)
    expect(ssh.target.hostKey).not.toBe(hostKey)
    expect((await f.call('prepare-host',{id:entry.id,revision:prepared.revision})).target.hostKey).toBe(hostKey)
    const bound={...input,target:prepared.target},lease=await f.call('grant',bound)
    await expect(f.call('execute',{id:lease.id,input:bound})).rejects.toMatchObject({code:'vault_host_key_rejected'})
    expect(ssh.state.authMethods).toEqual([]);expect(ssh.state.commands).toEqual([])
    expect((await f.call('status')).entries[0].target.hostKey).toBe(hostKey)
  }finally{await ssh.close()}
},15000)

it('isolates accounts and login sessions and starts locked after a server restart', async () => {
  const f = client(); await f.call('initialize', { password }); await f.call('unlock', { password })
  await f.call('add', { name: 'Dummy', username: 'dummy', target: { kind: 'website', origin: 'https://example.test' }, secret })
  expect(await f.call('status', undefined, 'another-owner')).toMatchObject({ initialized: false, entries: [] })
  expect(await f.call('status', undefined, 'dummy-owner', 'b'.repeat(64))).toMatchObject({ unlocked: false, entries: [] })
  await expect(f.call('add', {}, 'dummy-owner', 'b'.repeat(64))).rejects.toMatchObject({ code: 'vault_locked' })
  f.value.close(); await Promise.resolve()
  const restarted = client(f.home)
  expect(await restarted.call('status')).toMatchObject({ initialized: true, unlocked: false, entries: [] })
  await restarted.call('unlock', { password }); expect((await restarted.call('status')).entries).toHaveLength(1)
})

it('keeps an explicitly configured but unavailable private broker offline', async () => {
  const c = createCredentialVaultClient({ socket: '/missing/socket', tokenFile: '/missing/token', hermesUid: process.getuid!() + 1 }, '/unused')
  expect(c).not.toBeInstanceOf(LocalCredentialVaultClient)
  await expect(c.call('owner', session, 'status')).rejects.toMatchObject({ code: 'vault_offline' })
  c.close()
})

it('prevents concurrent brokers from writing the same local vault', async () => {
  const first = client(); await first.call('initialize', { password })
  const second = client(first.home)
  await expect(second.call('status')).rejects.toMatchObject({ code: 'vault_offline' })
  first.value.close(); await Promise.resolve()
  expect(await second.call('status')).toMatchObject({ initialized: true, unlocked: false })
})

it('keeps specified Bot approval across management lock and restart, without exposing secrets, and revokes it explicitly',async()=>{
  const ssh=await sshFixture('password'),f=client(),agentId=randomUUID(),owner='dummy-owner'
  const controller=new AbortController()
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    const {hostKey:_hostKey,...target}=ssh.target
    const entry=await f.call('add',{name:'Dummy SSH',username:ssh.username,target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    await expect(f.call('bot-grant',{credentialRef:entry.id,agentId},owner,'b'.repeat(64))).rejects.toMatchObject({code:'vault_locked'})
    await f.call('bot-grant',{credentialRef:entry.id,agentId})
    expect(ssh.state.authMethods).toEqual([])
    await f.call('lock')
    await expect(f.call('bot-grant',{credentialRef:entry.id,agentId})).rejects.toMatchObject({code:'vault_locked'})
    const refs=await f.call('bot-refs',{agentId})
    expect(refs).toHaveLength(1);expect(refs[0]).toMatchObject({credentialRef:entry.id,agentId,authorized:true,allowedTarget:target})
    expect((await f.call('status')).unlocked).toBe(false)
    expect(await f.call('bot-refs',{agentId:randomUUID()})).toEqual([])
    expect(await f.call('bot-refs',{agentId},'other-owner')).toEqual([])
    const input={credentialRef:entry.id,agentId,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target,seconds:60}
    await expect(f.value.executeBot('other-owner',input,controller.signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
    await expect(f.value.executeBot(owner,{...input,agentId:randomUUID()},controller.signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
    f.value.close();await Promise.resolve();const restarted=client(f.home)
    expect(await restarted.call('status')).toMatchObject({unlocked:false,botGrants:[{credentialRef:entry.id,agentId}]})
    expect(await restarted.value.executeBot(owner,input,controller.signal)).toEqual({status:'complete',operation:'ssh.exec',exitCode:0,stdout:'DUMMY-private-command-output',stderr:'DUMMY-private-stderr',truncated:false})
    expect(ssh.state.commands).toEqual(['/usr/bin/uptime'])
    const directory=join(f.home,'credential-vault','bot-access')
    const disk=readdirSync(directory).map(n=>readFileSync(join(directory,n),'utf8')).join('')
    for(const value of [ssh.secret,ssh.username,password,'Dummy SSH'])expect(disk).not.toContain(value)
    const publicData=JSON.stringify([refs,(await restarted.call('status')).botGrants])
    for(const value of [ssh.secret,ssh.username,password])expect(publicData).not.toContain(value)
    await restarted.call('unlock',{password});await restarted.call('bot-revoke',{credentialRef:entry.id,agentId});await restarted.call('lock')
    expect(await restarted.call('bot-refs',{agentId})).toEqual([])
    await expect(restarted.value.executeBot(owner,input,controller.signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
  }finally{await ssh.close()}
},15000)

it('management expiry and editing preserve Bot approval while deletion aborts in-flight use',async()=>{
  const ssh=await sshFixture('password'),f=client(),agentId=randomUUID(),owner='dummy-owner'
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    const entry=await f.call('add',{name:'Dummy SSH',username:ssh.username,target:ssh.target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    const grant={credentialRef:entry.id,agentId};await f.call('bot-grant',grant)
    const broker=await (f.value as any).broker
    const future=vi.spyOn(broker.store,'now').mockReturnValue(Date.now()+301000)
    expect(await f.call('status')).toMatchObject({unlocked:false});expect(await f.call('bot-refs',{agentId})).toHaveLength(1);future.mockRestore()
    await f.call('unlock',{password})
    await f.call('update',{id:entry.id,entry:{name:'Updated',username:ssh.username,target:entry.target,revision:entry.revision}})
    expect(await f.call('bot-refs',{agentId})).toMatchObject([{name:'Updated',authorized:true}])
    await f.call('lock')
    ssh.state.delayExec=true
    const input={...grant,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target:ssh.target,seconds:60}
    const pending=f.value.executeBot(owner,input,new AbortController().signal),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'})
    await ssh.executed;await f.call('unlock',{password});await f.call('remove',{id:entry.id});await assertion
    expect(await f.call('bot-refs',{agentId})).toEqual([])
  }finally{vi.restoreAllMocks();await ssh.close()}
},15000)

it('keeps two Bots authorized when the SSH port changes offline, uses the new port after restart, and retains a learned pin on later edits',async()=>{
  let ssh=await sshFixture('password');const second=await sshFixture('password'),f=client(),owner='dummy-owner',bots=[randomUUID(),randomUUID()]
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    let entry=await f.call('add',{name:'Dummy SSH',username:ssh.username,target:ssh.target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    for(const agentId of bots)await f.call('bot-grant',{credentialRef:entry.id,agentId})
    await expect(f.call('update',{id:entry.id,entry:{name:'Conflict',username:ssh.username,target:entry.target,revision:99}})).rejects.toMatchObject({code:'vault_revision_conflict'})
    expect(await f.call('bot-refs')).toHaveLength(2)
    const newPort=second.target.port;await second.close()
    // An editor sends the existing pin; changing the endpoint discards that old pin.
    entry=await f.call('update',{id:entry.id,entry:{name:'New port',username:ssh.username,target:{...entry.target,port:newPort},revision:entry.revision}})
    expect(entry.target.hostKey).toBeUndefined()
    await f.call('lock');f.value.close();await Promise.resolve();const restarted=client(f.home)
    const input=(agentId:string,target:any)=>({credentialRef:entry.id,agentId,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target,seconds:60})
    expect((await restarted.call('status')).unlocked).toBe(false);expect((await restarted.call('status')).botGrants).toHaveLength(2)
    // Server offline means connection failure, never an empty authorization list.
    await expect(restarted.value.executeBot(owner,input(bots[0]!,entry.target),new AbortController().signal)).rejects.toMatchObject({code:'vault_host_probe_failed'})
    expect(await restarted.call('bot-refs')).toHaveLength(2)
    await ssh.close();ssh=await sshFixture('password',newPort)
    for(const agentId of bots)expect(await restarted.value.executeBot(owner,input(agentId,entry.target),new AbortController().signal)).toMatchObject({status:'complete',exitCode:0})
    expect(ssh.state.commands).toEqual(['/usr/bin/uptime','/usr/bin/uptime'])
    await restarted.call('unlock',{password})
    entry=await restarted.call('update',{id:entry.id,entry:{name:'Rename only',username:ssh.username,target:entry.target,revision:entry.revision}})
    for(const agentId of bots)expect((await restarted.call('bot-refs',{agentId}))[0].allowedTarget.hostKey).toBe(ssh.target.hostKey)
    await restarted.call('lock')
    const port=ssh.target.port;await ssh.close();ssh=await sshFixture('password',port)
    await expect(restarted.value.executeBot(owner,input(bots[0]!,entry.target),new AbortController().signal)).rejects.toMatchObject({code:'vault_host_key_rejected'})
    expect(ssh.state.authMethods).toEqual([]);expect(await restarted.call('bot-refs')).toHaveLength(2)
  }finally{await ssh.close()}
},15000)

it('updates cancel in-flight old operations without dropping approval for the next operation',async()=>{
  const ssh=await sshFixture('password'),f=client(),agentId=randomUUID()
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    const entry=await f.call('add',{name:'Dummy SSH',username:ssh.username,target:ssh.target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    await f.call('bot-grant',{credentialRef:entry.id,agentId});await f.call('lock');ssh.state.delayExec=true
    const input={credentialRef:entry.id,agentId,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target:ssh.target,seconds:60}
    const pending=f.value.executeBot('dummy-owner',input,new AbortController().signal),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'})
    await ssh.executed;await f.call('unlock',{password})
    await f.call('update',{id:entry.id,entry:{name:'New operation',username:ssh.username,target:ssh.target,revision:entry.revision,usage:{kind:'ssh.exec',command:'/usr/bin/true'}}})
    await assertion;await f.call('lock');ssh.state.delayExec=false
    expect(await f.value.executeBot('dummy-owner',input,new AbortController().signal)).toMatchObject({status:'complete',exitCode:0})
    expect(ssh.state.commands).toEqual(['/usr/bin/uptime','/usr/bin/true'])
    expect(await f.call('bot-refs',{agentId})).toMatchObject([{authorized:true,name:'New operation'}])
  }finally{await ssh.close()}
},15000)

it.each(['password','privateKey'] as const)('supports autonomous SSH %s with arguments, pipelines, returned output and credential redaction only for an explicitly approved Bot',async auth=>{
  const ssh=await sshFixture(auth),f=client(),ops=randomUUID(),restricted=randomUUID()
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    const entry=await f.call('add',{name:'SSH operations',username:ssh.username,target:ssh.target,secret:ssh.secret,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
    await f.call('bot-grant',{credentialRef:entry.id,agentId:ops});await f.call('lock')
    expect(await f.call('bot-refs',{agentId:ops})).toMatchObject([{operation:'ssh.exec',allowedUse:{kind:'ssh.exec',mode:'unrestricted'}}])
    const input={credentialRef:entry.id,agentId:ops,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target:ssh.target,command:'uname -s; printf "status\\n" | head -n 1',timeoutSeconds:30,seconds:60}
    ssh.state.execReplies.set(input.command,{stdout:'Linux\nstatus\ncredential='+ssh.secret+'\n',stderr:'warning '+ssh.secret,exitCode:3})
    await expect(f.value.executeBot('dummy-owner',{...input,agentId:restricted},new AbortController().signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
    await expect(f.value.executeBot('other-owner',input,new AbortController().signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
    expect(ssh.state.commands).toEqual([])
    const result=await f.value.executeBot('dummy-owner',input,new AbortController().signal)
    expect(result).toEqual({status:'complete',operation:'ssh.exec',exitCode:3,stdout:'Linux\nstatus\ncredential=[REDACTED]\n',stderr:'warning [REDACTED]',truncated:false})
    expect(ssh.state.commands).toEqual([input.command]);expect(JSON.stringify(result)).not.toContain(ssh.secret)
    const next=(result as any).stdout.includes('Linux')?'df -h /\nfree -m':'df -h /'
    ssh.state.execReplies.set(next,{stdout:'Filesystem 40% used\nMem: available 4096\n',stderr:''})
    expect(await f.value.executeBot('dummy-owner',{...input,command:next},new AbortController().signal)).toMatchObject({stdout:'Filesystem 40% used\nMem: available 4096\n',exitCode:0})
    // Existing approval allows arbitrary commands before and after editing and restart.
    await f.call('unlock',{password});await f.call('update',{id:entry.id,entry:{name:'Changed',username:ssh.username,target:ssh.target,revision:entry.revision}})
    await f.call('lock');f.value.close();await Promise.resolve();const restarted=client(f.home)
    expect(await restarted.call('bot-refs',{agentId:ops})).toMatchObject([{operation:'ssh.exec'}])
    expect(await restarted.call('bot-refs',{agentId:restricted})).toEqual([])
    expect(await restarted.value.executeBot('dummy-owner',{...input,command:next},new AbortController().signal)).toMatchObject({exitCode:0,stdout:'Filesystem 40% used\nMem: available 4096\n'})
    await restarted.call('unlock',{password});await restarted.call('bot-revoke',{credentialRef:entry.id,agentId:ops});await restarted.call('lock')
    await expect(restarted.value.executeBot('dummy-owner',input,new AbortController().signal)).rejects.toMatchObject({code:'vault_bot_forbidden'})
  }finally{await ssh.close()}
},15000)

it('permits operations approval without a fixed plan, bounds output and time, and cancels on revocation',async()=>{
  const ssh=await sshFixture('password'),f=client(),agentId=randomUUID()
  try{
    await f.call('initialize',{password});await f.call('unlock',{password})
    const {hostKey:_pin,...target}=ssh.target
    const entry=await f.call('add',{name:'SSH operations',username:ssh.username,target,secret:ssh.secret})
    await f.call('bot-grant',{credentialRef:entry.id,agentId});await f.call('lock')
    const input={credentialRef:entry.id,agentId,workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:randomUUID(),operation:'ssh.exec',target,command:'cat diagnostic.log',timeoutSeconds:30,seconds:60}
    const sensitive='x'.repeat(65530)+ssh.secret+'\n'+'y'.repeat(100000)
    ssh.state.execReplies.set(input.command,{stdout:sensitive,stderr:'bounded stderr'})
    const result=await f.value.executeBot('dummy-owner',input,new AbortController().signal) as any
    expect(result).toMatchObject({status:'complete',truncated:true,exitCode:0});expect(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(65536)
    expect(result.stdout).not.toContain(ssh.secret);expect(result.stdout).not.toContain(ssh.secret.slice(0,5))
    ssh.state.execReplies.set('unicode diagnostic',{stdout:'汉'.repeat(30000),stderr:''})
    const unicode=await f.value.executeBot('dummy-owner',{...input,command:'unicode diagnostic'},new AbortController().signal) as any
    expect(Buffer.byteLength(unicode.stdout)+Buffer.byteLength(unicode.stderr)).toBeLessThanOrEqual(65536);expect(unicode.stdout).not.toContain('�');expect(unicode.truncated).toBe(true)
    await expect(f.value.executeBot('dummy-owner',{...input,command:'',timeoutSeconds:30},new AbortController().signal)).rejects.toMatchObject({code:'vault_invalid_request'})
    await expect(f.value.executeBot('dummy-owner',{...input,timeoutSeconds:601},new AbortController().signal)).rejects.toMatchObject({code:'vault_invalid_request'})
    ssh.state.delayExec=true
    const timed=f.value.executeBot('dummy-owner',{...input,timeoutSeconds:1},new AbortController().signal)
    await expect(timed).rejects.toMatchObject({code:'vault_operation_uncertain'})
    const pending=f.value.executeBot('dummy-owner',input,new AbortController().signal),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'})
    await vi.waitFor(()=>expect(ssh.state.commands).toHaveLength(4))
    await f.call('unlock',{password});await f.call('bot-revoke',{credentialRef:entry.id,agentId});await assertion
    expect(await f.call('bot-refs',{agentId})).toEqual([])
  }finally{await ssh.close()}
},15000)
