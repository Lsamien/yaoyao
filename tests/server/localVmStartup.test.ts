// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {LocalVmService} from '../../src/server/localVm'
import {saveHostTools} from '../../src/server/hostToolSettings'

const runners=vi.hoisted(()=>[] as any[])
vi.mock('../../src/runner/agent',()=>({RunnerAgent:class {
  onConnected=()=>{}
  constructor(readonly config:any){runners.push(this)}
  async run(signal:AbortSignal){this.onConnected();await new Promise<void>(done=>signal.addEventListener('abort',()=>done(),{once:true}))}
}}))

function fixture(){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-vm-startup-')),store=new WorkspaceStore(home)
  saveHostTools(home,{vm:true})
  const record={id:randomUUID(),enabled:true,sourceNodeId:'local',sourceOwner:'_system'}
  const auth={isUserActive:(owner:string)=>owner==='alice'} as any
  const nodes={open:()=>({runnerId:record.id}),requireSource:vi.fn((_owner:string,agent:any)=>{if(agent.profile==='denied')throw new Error('unauthorized')})} as any
  const hub={records:()=>[record],computerRunner:()=>record,computer:vi.fn(async(_owner:string,_agent:any,_op:string,_data:any,authorize:()=>void)=>{authorize();return {ok:true}})} as any
  const shared={reconcileLocalVmGroups:vi.fn(),attachLocalVm:vi.fn()} as any
  const service=new LocalVmService(store,auth,nodes,hub,shared,{home} as any)
  store.put('_system','local-vm-managed','local',{sealed:'fixture'})
  const add=(owner='alice',changes:Record<string,unknown>={})=>{
    const agent=store.createAgent(owner,{name:`启动测试 ${randomUUID()}`,profile:'default'})
    Object.assign(agent,changes);store.put(owner,'agent',agent.id,agent);return agent
  }
  return {home,store,service,hub,shared,record,add,
    async settled(){await (service as any).managed?.warmup},
    async close(){await service.close();store.close();rmSync(home,{recursive:true,force:true})},
  }
}

it('starts authorized configured desktops once per service start and deduplicates shared members',async()=>{
  const f=fixture()
  try{
    const group=randomUUID(),first=f.add('alice',{computerEnvironmentId:group})
    f.add('alice',{computerEnvironmentId:group});const own=f.add()
    f.add('alice',{archived:true});f.add('alice',{temporaryGoalId:randomUUID()})
    f.add('alice',{remoteAgentId:randomUUID()});f.add('alice',{nodeId:'remote'})
    f.add('alice',{profile:'denied'});f.add('bob')
    await f.service.start('http://127.0.0.1:15300');await f.settled()
    expect(f.hub.computer.mock.calls.map((c:any[])=>(c[1].computerEnvironmentId??c[1].id)).sort()).toEqual([group,own.id].sort())
    expect(f.hub.computer).toHaveBeenCalledWith('alice',expect.objectContaining({computerEnvironmentId:first.computerEnvironmentId}),'autostart',{},expect.any(Function))
    // Reconnection, repeated start(), or polling settings must not undo a stop.
    runners.at(-1).onConnected()
    await f.service.start('http://127.0.0.1:15300');await f.settled()
    expect(f.hub.computer).toHaveBeenCalledTimes(2)
    await f.service.close();await f.service.start('http://127.0.0.1:15300');await f.settled()
    expect(f.hub.computer).toHaveBeenCalledTimes(4)
  }finally{await f.close()}
})

it('respects the global VM switch and rechecks authorization before each admitted start',async()=>{
  const f=fixture()
  try{
    f.add();saveHostTools(f.home,{vm:false})
    await f.service.start('http://127.0.0.1:15300');await f.settled()
    expect(f.hub.computer).not.toHaveBeenCalled()
    await f.service.close();saveHostTools(f.home,{vm:true})
    f.hub.computer.mockImplementation(async(_owner:string,_agent:any,_op:string,_data:any,authorize:()=>void)=>{
      saveHostTools(f.home,{vm:false});expect(authorize).toThrow('虚拟机启动授权已失效')
    })
    await f.service.start('http://127.0.0.1:15300');await f.settled()
    expect(f.hub.computer).toHaveBeenCalledOnce()
  }finally{await f.close()}
})

it('keeps Web startup available if one desktop fails, and attempts the remaining desktops',async()=>{
  const f=fixture()
  try{
    f.add();f.add()
    f.hub.computer.mockRejectedValueOnce(new Error('Docker unavailable'))
    await expect(f.service.start('http://127.0.0.1:15300')).resolves.toBeUndefined();await f.settled()
    expect(f.hub.computer).toHaveBeenCalledTimes(2)
    expect((f.service as any).problem).toContain('未能自动启动')
  }finally{await f.close()}
})
