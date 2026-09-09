// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceAssets} from '../../src/server/workspaceAssets'
import type {WorkspaceNodes} from '../../src/server/workspaceGateway'
it('never resolves a computer message path against native Hermes or the host filesystem',async()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-computer-artifacts-')),store=new WorkspaceStore(home),target=vi.fn()
  const assets=new WorkspaceAssets(store,{target} as unknown as WorkspaceNodes,home)
  try{
    const agent=store.createAgent('owner',{name:'隔离',profile:'default',execution:'computer'})
    const conversation=store.list<any>('owner','conversation')[0]
    const message:any={id:crypto.randomUUID(),conversationId:conversation.id,seq:0,role:'assistant',execution:'computer',agentId:agent.id,content:'[host file](/Users/private/secret.txt)',reasoning:'',status:'complete',attachments:[],tools:[],createdAt:Date.now()}
    store.saveMessage('owner',message)
    await assets.archive('owner',message)
    expect(target).not.toHaveBeenCalled()
    store.updateAgent('owner',agent.id,{execution:'profile'})
    await assets.archive('owner',message)
    expect(target).not.toHaveBeenCalled()
    const first=assets.publish('owner',message,agent,'report.txt',Buffer.from('guest output'))
    expect(assets.publish('owner',message,agent,'report.txt',Buffer.from('guest output'))).toEqual(first)
    await assets.archive('owner',message)
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]).not.toHaveProperty('path')
  }finally{assets.close();store.close();rmSync(home,{recursive:true,force:true})}
})
