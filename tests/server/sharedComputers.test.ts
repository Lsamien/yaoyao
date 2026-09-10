// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {SharedComputers} from '../../src/server/sharedComputers'
import type {WorkspaceAgent} from '../../src/shared/workspace'
it('requires an explicit human grant, one compatible source and idle permanent members',()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-shared-')),store=new WorkspaceStore(home),nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)
  const service=new SharedComputers(store,{} as any,nodes,{sharedComputerRunner:()=>({id:'runner'})} as any)
  try{
    const first=store.createAgent('owner',{name:'第一位',execution:'computer',profile:'default'}),second=store.createAgent('owner',{name:'第二位',execution:'computer',profile:'default'})
    const command={requestId:randomUUID(),name:'可信研发电脑',memberIds:[first.id,second.id],trusted:true}
    expect(()=>service.create('owner',{...command,trusted:false})).toThrow()
    expect(()=>store.createAgent('owner',{name:'模型新建',profile:'default',computerEnvironmentId:randomUUID()})).toThrow()
    store.put('owner','turn','busy',{agentId:first.id,status:'queued'})
    expect(()=>service.create('owner',command)).toThrow('先停止')
    store.remove('owner','turn','busy')
    const shared=service.create('owner',command)
    expect(service.create('owner',command).id).toBe(shared.id)
    const linked=store.require<WorkspaceAgent>('owner','agent',first.id)
    expect(linked.computerEnvironmentId).toBe(shared.id)
    expect(()=>nodes.requireSource('other',linked)).toThrow()
    expect(()=>nodes.requireSource('owner',{...linked,id:randomUUID()})).toThrow()
    expect(()=>store.updateAgent('owner',first.id,{execution:'profile'})).toThrow('解除电脑共享')
    store.put('_system','computer-control','fixture',{owner:'owner',agentId:first.id,environmentId:shared.id,expiresAt:Date.now()+30000})
    expect(()=>service.remove('owner',shared.id)).toThrow('交还')
    store.remove('_system','computer-control','fixture')
    service.remove('owner',shared.id)
    expect(store.require<WorkspaceAgent>('owner','agent',first.id).computerEnvironmentId).toBeUndefined()
    expect(()=>nodes.requireSource('owner',linked)).toThrow('授权')
    expect(store.require<any>('owner','shared-computer',shared.id).archived).toBe(true)
  }finally{nodes.close();store.close();rmSync(home,{recursive:true,force:true})}
})
it('shares one desktop across authorized profiles and rejects temporary helpers',()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-shared-')),store=new WorkspaceStore(home),nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any),service=new SharedComputers(store,{} as any,nodes,{sharedComputerRunner:()=>({id:'runner'})} as any)
  try{
    const first=store.createAgent('owner',{name:'第一位',execution:'computer',profile:'default'}),second=store.createAgent('owner',{name:'第二位',execution:'computer',profile:'different'})
    const command={requestId:randomUUID(),name:'共享',memberIds:[first.id,second.id],trusted:true}
    const group=service.create('owner',command)
    expect(store.require<WorkspaceAgent>('owner','agent',second.id).computerEnvironmentId).toBe(group.id)
    nodes.requireSource('owner',store.require<WorkspaceAgent>('owner','agent',second.id))
    service.remove('owner',group.id)
    command.requestId=randomUUID()
    store.put('owner','agent',second.id,{...second,profile:'default',temporaryGoalId:randomUUID()})
    expect(()=>service.create('owner',command)).toThrow('持久隔离成员')
  }finally{nodes.close();store.close();rmSync(home,{recursive:true,force:true})}
})
it('changes only persistent local VM members and leaves unrelated running chats untouched',()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-shared-scope-')),store=new WorkspaceStore(home),nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any),service=new SharedComputers(store,{} as any,nodes,{} as any)
  try{
    const vm=store.createAgent('owner',{name:'虚拟机成员',execution:'computer',profile:'default'})
    const chat=store.createAgent('owner',{name:'正在聊天',profile:'server'})
    const archived=store.createAgent('owner',{name:'已归档',execution:'computer',profile:'default'})
    store.put('owner','agent',archived.id,{...archived,archived:true})
    const helper=store.createAgent('owner',{name:'临时助手',execution:'computer',profile:'default'},{createdByAgentId:vm.id,createdFromRunId:randomUUID(),temporaryGoalId:randomUUID()})
    const remote=store.createAgent('owner',{name:'远端成员',execution:'computer',profile:'default'})
    store.put('owner','agent',remote.id,{...remote,nodeId:randomUUID()})
    const unaffected=[chat,archived,helper,remote].map(a=>store.require<WorkspaceAgent>('owner','agent',a.id))
    for(const agent of unaffected)store.put('owner','turn',agent.id,{agentId:agent.id,status:'running'})
    service.setLocalVmMode('owner','shared','runner')
    const linked=store.require<WorkspaceAgent>('owner','agent',vm.id)
    expect(linked.computerEnvironmentId).toBeTruthy()
    for(const agent of unaffected)expect(store.require('owner','agent',agent.id)).toEqual(agent)
    service.setLocalVmMode('owner','shared','runner')
    expect(store.require('owner','agent',vm.id)).toEqual(linked)
    // Explicit per-Agent execution changes must still guard an ordinary chat.
    expect(()=>service.assertLocalVmIdle('owner',[chat.id])).toThrow('正在聊天')
    for(const status of ['queued','running','waiting','uncertain','cancelling']){
      store.put('owner','turn','active-vm',{agentId:vm.id,status})
      expect(()=>service.setLocalVmMode('owner','per-bot','runner')).toThrow('请先停止「虚拟机成员」')
      expect(store.require('owner','agent',vm.id)).toEqual(linked)
    }
    store.remove('owner','turn','active-vm')
    // A controller acquired through another member still owns this same VM.
    store.put('_system','computer-control','human',{owner:'owner',agentId:archived.id,environmentId:linked.computerEnvironmentId,expiresAt:Date.now()+30000})
    expect(()=>service.setLocalVmMode('owner','per-bot','runner')).toThrow('交还')
    store.remove('_system','computer-control','human')
    service.setLocalVmMode('owner','per-bot','runner')
    expect(store.require<WorkspaceAgent>('owner','agent',vm.id).computerEnvironmentId).toBeUndefined()
    for(const agent of unaffected)expect(store.require('owner','agent',agent.id)).toEqual(agent)
  }finally{nodes.close();store.close();rmSync(home,{recursive:true,force:true})}
})
