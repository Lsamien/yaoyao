// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'
import {VmToolSession} from '../../src/server/vmComputer'
import type {GatewayTarget} from '../../src/server/workspaceGateway'

async function fixture(docker=false){
  const home=await mkdtemp(join(tmpdir(),'yaoyao-vm-lifecycle-')),db=new DatabaseSync(':memory:')
  const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1:1',hermesURL:'http://127.0.0.1:1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:docker?process.env.YAOYAO_COMPUTER_IMAGE!:'sha256:'+'a'.repeat(64),python:'/unused',hermesSource:home,hermesHome:home,network:'none'}},home)
  await runtime.ready;runtime.retainDesktops=true;runtime.pool.idleStopMinutes=0
  const id=randomUUID(),meta={environmentId:id,agentId:id,ownerKey:'vm-lifecycle-fixture',hermesRuntime:true}
  const gateways:ComputerGateway[]=[],closed:Promise<void>[]=[],calls:string[]=[]
  let allowed=true
  const authorize=()=>{if(!allowed)throw new Error('revoked')}
  if(!docker){
    vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id,containerId:id,running:true,workspace:home,isolation:'container'})
    vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
    vi.spyOn(runtime.provider,'execute').mockResolvedValue({stdout:'vm proof',stderr:''})
  }
  const target={url:new URL('http://127.0.0.1:1'),client:{},session:{},runner:{id:randomUUID(),computer:true,
    async open(onEvent,onDisconnect,scope){
      const gateway=new ComputerGateway(runtime,meta,scope!.workId,async()=>{authorize();scope!.authorize()},async()=>({}),target)
      gateways.push(gateway);gateway.onEvent=onEvent;gateway.onDisconnect=onDisconnect
      await gateway.connect()
      return {rpc:async(method,params)=>{calls.push(method);return gateway.rpc(method,params)},close:()=>{closed.push(gateway.close())}}
    },lease:async()=>{throw new Error('unused')},
  }} as GatewayTarget
  const session=()=>new VmToolSession(target,'default',randomUUID(),authorize)
  return {runtime,meta,gateways,calls,session,revoke:()=>{allowed=false},drain:()=>Promise.all(closed),state:()=>runtime.pool.status(meta.ownerKey)[0],
    async close(){await Promise.all(gateways.map(g=>g.close().catch(()=>{})));await Promise.all(closed);await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks();await rm(home,{recursive:true,force:true})},
  }
}

it('keeps a completed Bot VM idle across tool-channel disconnection and the next turn',async()=>{
  const f=await fixture()
  try{
    const first=f.session();await first.call('computer_shell',{command:'pwd'});await first.complete();await f.drain()
    expect(f.state()).toMatchObject({status:'idle',holderIds:[]})
    await f.runtime.pool.expire();expect(f.state()?.status).toBe('idle')
    expect(f.runtime.provider.stop).not.toHaveBeenCalled()
    const ended=f.gateways[0]!
    await expect(ended.rpc('computer.invoke',{session_id:'old',name:'computer_shell'})).rejects.toMatchObject({code:'computer_cancelled'})
    const second=f.session();await second.call('computer_shell',{command:'pwd'});await second.complete();await f.drain()
    expect(f.state()?.status).toBe('idle');expect(f.runtime.provider.stop).not.toHaveBeenCalled()
    f.runtime.pool.idleStopMinutes=1
    const clock=vi.spyOn(f.runtime.pool,'now').mockReturnValue(Date.now()+61000)
    try{await f.runtime.pool.expire();expect(f.state()?.status).toBe('free')}finally{clock.mockRestore()}
  }finally{await f.close()}
})

it.each(['disconnect','revoked','interrupt'] as const)('still stops the last VM holder on %s with idle stopping disabled',async reason=>{
  const f=await fixture()
  try{
    const session=f.session();await session.call('computer_shell',{command:'pwd'})
    if(reason==='revoked'){f.revoke();await expect(session.complete()).rejects.toThrow('revoked')}
    else if(reason==='interrupt')await f.gateways[0]!.interrupt()
    else session.close()
    await f.drain();expect(f.state()?.status).toBe('free')
    expect(f.runtime.provider.stop).toHaveBeenCalled()
  }finally{await f.close()}
})

it('waits for an in-flight command and rejects new work while completing',async()=>{
  const f=await fixture()
  let release!:()=>void
  try{
    const gate=new Promise<void>(done=>{release=done}),session=f.session()
    vi.mocked(f.runtime.provider.execute).mockImplementation(async()=>{await gate;return {stdout:'finished',stderr:''}})
    const command=session.call('computer_shell',{command:'slow'})
    await vi.waitFor(()=>expect(f.runtime.provider.execute).toHaveBeenCalled())
    const completion=session.complete()
    await vi.waitFor(()=>expect(f.calls).toContain('computer.complete'))
    await expect(session.call('computer_shell',{command:'late'})).rejects.toMatchObject({code:'computer_cancelled'})
    expect(f.state()?.status).toBe('active');expect(f.runtime.provider.stop).not.toHaveBeenCalled()
    release();await command;await completion;await f.drain()
    expect(f.state()?.status).toBe('idle')
  }finally{release?.();await f.close()}
})

it('releases only its own holder while another Bot still uses the shared VM',async()=>{
  const f=await fixture()
  try{
    const first=f.session(),second=f.session()
    await first.call('computer_shell',{command:'pwd'});await second.call('computer_shell',{command:'pwd'})
    await first.complete();await f.drain()
    expect(f.state()).toMatchObject({status:'active',holderIds:[f.gateways[1]!.workId]})
    await second.complete();await f.drain()
    expect(f.state()?.status).toBe('idle');expect(f.runtime.provider.stop).not.toHaveBeenCalled()
  }finally{await f.close()}
})

it('does not start an unused VM merely to complete a turn',async()=>{
  const f=await fixture()
  try{await f.session().complete();expect(f.calls).toEqual([]);expect(f.state()).toBeUndefined()}finally{await f.close()}
})

it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('retains the real Docker container and running processes after Bot completion',async()=>{
  const f=await fixture(true)
  try{
    const first=f.session()
    await first.call('computer_shell',{command:'nohup sleep 600 >/tmp/yaoyao-retain.log 2>&1 </dev/null & echo $! > retain.pid'})
    const spec=f.gateways[0]!.specification!,before=await f.runtime.provider.inspect(spec)
    expect(before?.running).toBe(true)
    await first.complete();await f.drain();await f.runtime.pool.expire()
    expect(f.state()?.status).toBe('idle')
    expect(await f.runtime.provider.inspect(spec)).toMatchObject({containerId:before!.containerId,running:true})
    const second=f.session(),result=await second.call('computer_shell',{command:'kill -0 "$(cat retain.pid)" && printf process-survived'})
    expect(JSON.stringify(result)).toContain('process-survived')
    await second.complete();await f.drain()
    expect(await f.runtime.provider.inspect(spec)).toMatchObject({containerId:before!.containerId,running:true})
    f.runtime.pool.idleStopMinutes=1
    const clock=vi.spyOn(f.runtime.pool,'now').mockReturnValue(Date.now()+61000)
    try{await f.runtime.pool.expire()}finally{clock.mockRestore()}
    expect(await f.runtime.provider.inspect(spec)).toBeUndefined()
  }finally{await f.close()}
},120000)
