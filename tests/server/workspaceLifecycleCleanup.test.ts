// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {OpenVikingClient} from '@openviking/sdk'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {UploadStore} from '../../src/server/uploads'
import {OpenVikingConfigurationManager} from '../../src/server/openVikingConfiguration'
import {OpenVikingService} from '../../src/server/openVikingService'
import type {WorkspaceAgent,WorkspaceConversation} from '../../src/shared/workspace'

const owner='lifecycle-owner'
let home:string,store:WorkspaceStore,uploads:UploadStore,runtime:WorkspaceRuntime,service:OpenVikingService,manager:OpenVikingConfigurationManager,bot:WorkspaceAgent,conversation:WorkspaceConversation
const admin={adminRegisterUser:vi.fn(async()=>({user_key:'temporary-test-key'})),adminRemoveUser:vi.fn(async()=>({ok:true}))}
const nodes={requireSource:()=>{}} as unknown as WorkspaceNodes
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-cleanup-test-'));store=new WorkspaceStore(home);uploads=new UploadStore(home)
  manager=new OpenVikingConfigurationManager(home,undefined,async()=>undefined)
  await manager.update({enabled:true,url:'http://127.0.0.1:1933',accountId:'fixture',adminKey:'temporary-test-admin'})
  service=new OpenVikingService(store,manager,()=>admin as unknown as OpenVikingClient)
  runtime=new WorkspaceRuntime(store,nodes,uploads,undefined,undefined,service)
  vi.spyOn(runtime,'wake').mockImplementation(()=>{})
  bot=store.createAgent(owner,{name:'待删除 Bot',profile:'default'})
  conversation=store.list<WorkspaceConversation>(owner,'conversation').find(c=>c.kind==='direct'&&c.memberIds[0]===bot.id)!
})
afterEach(()=>{runtime.close();uploads.close();store.close();rmSync(home,{recursive:true,force:true});vi.clearAllMocks()})

it('validates every local delete condition before removing any remote memory',async()=>{
  await service.ensureUser(owner,bot)
  await expect(runtime.deleteAgent(owner,bot.id)).rejects.toMatchObject({code:'agent_not_archived'})
  const peer=store.createAgent(owner,{name:'群成员',profile:'default'})
  const group=store.createGroup(owner,{name:'现有群',memberIds:[bot.id,peer.id],administratorId:peer.id})
  store.updateAgent(owner,bot.id,{archived:true})
  await expect(runtime.deleteAgent(owner,bot.id)).rejects.toMatchObject({code:'agent_in_group'})
  expect(store.require<WorkspaceConversation>(owner,'conversation',group.id).memberIds).toContain(bot.id)
  expect(admin.adminRemoveUser).not.toHaveBeenCalled()
  expect(service.binding(owner,bot.id)?.status).toBe('active')
  expect(store.get(owner,'agent-deletion',bot.id)).toBeUndefined()
})

it('preserves the stop ledger and session binding, and blocks deletion and source reuse until cleanup',()=>{
  store.updateAgent(owner,bot.id,{archived:true})
  const turnId=randomUUID(),bindingId=`${conversation.id}:${bot.id}`
  store.put(owner,'turn',turnId,{id:turnId,agentId:bot.id,conversationId:conversation.id,status:'interrupted',cleanupPending:true})
  store.put(owner,'binding',bindingId,{id:bindingId,conversationId:conversation.id,agentId:bot.id,storedId:'original-session'})
  expect(()=>store.deleteAgent(owner,bot.id)).toThrow('尚未确认停止')
  expect(()=>store.updateAgent(owner,bot.id,{profile:'changed'})).toThrow('确认当前任务停止')
  expect(()=>store.deleteConversation(owner,conversation.id,true)).toThrow('尚未确认停止')
  expect(store.require<any>(owner,'binding',bindingId).storedId).toBe('original-session')
  const turn=store.require<any>(owner,'turn',turnId);turn.cleanupPending=false;store.put(owner,'turn',turnId,turn)
  store.deleteAgent(owner,bot.id)
  expect(store.get(owner,'turn',turnId)).toBeUndefined()
  expect(store.require<any>(owner,'agent-deletion',bot.id).conversationIds).toEqual([conversation.id])
  expect(()=>store.createAgent(owner,{name:'复用旧 ID',profile:'default'},undefined,bot.id)).toThrow('不能复用')
})

it('keeps a failed remote deletion retryable by the same Bot id after local deletion',async()=>{
  await service.ensureUser(owner,bot);store.updateAgent(owner,bot.id,{archived:true})
  admin.adminRemoveUser.mockRejectedValueOnce(new Error('fixture temporarily unavailable'))
  await expect(runtime.deleteAgent(owner,bot.id)).rejects.toMatchObject({code:'openviking_unavailable'})
  expect(store.get(owner,'agent',bot.id)).toBeUndefined()
  expect(store.require<any>(owner,'agent-deletion',bot.id).memoryCleanupPending).toBe(true)
  await runtime.deleteAgent(owner,bot.id);await runtime.deleteAgent(owner,bot.id)
  expect(store.require<any>(owner,'agent-deletion',bot.id).memoryCleanupPending).toBe(false)
  expect(admin.adminRemoveUser).toHaveBeenCalledTimes(2)
})

it('automatically recovers persisted remote cleanup after restart and retries transient failure',async()=>{
  await service.ensureUser(owner,bot);store.updateAgent(owner,bot.id,{archived:true})
  admin.adminRemoveUser.mockRejectedValueOnce(new Error('fixture initial failure'))
  await expect(runtime.deleteAgent(owner,bot.id)).rejects.toThrow('fixture initial failure')
  runtime.close()
  service=new OpenVikingService(store,manager,()=>admin as unknown as OpenVikingClient)
  runtime=new WorkspaceRuntime(store,nodes,uploads,undefined,undefined,service)
  admin.adminRemoveUser.mockRejectedValueOnce(new Error('fixture retry failure'))
  runtime.start()
  await vi.waitFor(()=>expect(store.require<any>(owner,'agent-deletion',bot.id).memoryCleanupPending).toBe(false),{timeout:3000})
  expect(service.binding(owner,bot.id)).toMatchObject({status:'removed',pendingRemoval:false})
  expect(admin.adminRemoveUser).toHaveBeenCalledTimes(3)
  expect(admin.adminRegisterUser).toHaveBeenCalledTimes(1)
})

it('keeps cleanup durable while disabled and resumes it when the configured service returns',async()=>{
  await service.ensureUser(owner,bot);store.updateAgent(owner,bot.id,{archived:true})
  service.configure(undefined)
  await runtime.deleteAgent(owner,bot.id)
  expect(admin.adminRemoveUser).not.toHaveBeenCalled()
  expect(store.require<any>(owner,'agent-deletion',bot.id).memoryCleanupPending).toBe(true)
  vi.mocked(runtime.wake).mockRestore()
  service.configure(manager.configuration())
  await vi.waitFor(()=>expect(store.require<any>(owner,'agent-deletion',bot.id).memoryCleanupPending).toBe(false))
  expect(admin.adminRemoveUser).toHaveBeenCalledTimes(1)
})
