// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,symlink,mkdir,rename,writeFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContainerComputerProvider,CUA_DRIVER,type ContainerCommand,type ComputerSpecification} from '../../src/runner/computers/container'
import {COMMAND_ROOT,GUEST_COMMAND} from '../../src/runner/computers/commandProcess'
const homes:string[]=[]
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})))})
async function fixture(runtime:'docker'|'podman'='docker',onCommand?:(args:string[])=>Promise<void>){
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-computer-unit-')));homes.push(home)
  const spec:ComputerSpecification={id:randomUUID(),ownerKey:randomUUID(),imageId:`sha256:${'a'.repeat(64)}`}
  let detail:any
  const calls:string[][]=[]
  const run:ContainerCommand=async(_runtime,args)=>{
    if(onCommand)await onCommand(args)
    calls.push(args)
    if(args[0]==='context')return {stdout:JSON.stringify('unix:///tmp/fixture-engine.sock'),stderr:''}
    if(args[0]==='system')return {stdout:'[]',stderr:''}
    if(args[0]==='image')return {stdout:JSON.stringify([{Id:spec.imageId,Config:{Labels:{'com.openmausbot.cua-driver':'0.20.0','com.openmausbot.image-layer':'5'}}}]),stderr:''}
    if(args[0]==='inspect'){
      if(!detail)throw Object.assign(new Error('missing'),{stderr:'No such object'})
      return {stdout:JSON.stringify([detail]),stderr:''}
    }
    if(args[0]==='create'){
      const value=(flag:string)=>args[args.indexOf(flag)+1]!
      const values=(flag:string)=>args.flatMap((arg,i)=>arg===flag?[args[i+1]!]:[])
      const workspace=/source=([^,]+)/.exec(value('--mount'))![1]
      detail={Id:'b'.repeat(64),Image:spec.imageId,Config:{Labels:Object.fromEntries(values('--label').map(label=>label.split('=')))},State:{Running:false},
        HostConfig:{Memory:4096*1024*1024,MemorySwap:4096*1024*1024,NanoCpus:2e9,PidsLimit:512,Privileged:false,IpcMode:'private',CgroupnsMode:'private',NetworkMode:'none',RestartPolicy:{Name:'no'},CapAdd:values('--cap-add'),CapDrop:values('--cap-drop'),SecurityOpt:values('--security-opt'),PortBindings:{}},
        Mounts:[{Type:'bind',Source:workspace,Destination:'/home/cua/workspace',RW:true}],NetworkSettings:{Ports:{}}}
      return {stdout:detail.Id,stderr:''}
    }
    if(args[0]==='start')detail.State.Running=true
    if(args[0]==='stop')detail.State.Running=false
    if(args[0]==='rm')detail=undefined
    return {stdout:'fixture',stderr:''}
  }
  const provider=new ContainerComputerProvider(runtime,randomUUID(),home,run,{})
  return {provider,spec,calls,home,run,get detail(){return detail}}
}
it.each(['docker','podman'] as const)('uses the same private ownership and execution boundary for %s',async runtime=>{
  const f=await fixture(runtime),state=await f.provider.ensure(f.spec,()=>{})
  expect(state).toMatchObject({running:true,isolation:'container'})
  await f.provider.execute(f.spec,['/bin/sh','-c','echo hello'],{authorize:()=>{}})
  expect(f.calls.find(args=>args[0]==='exec')).toEqual(['exec','--user','0:0','--env','HOME=/home/cua','--env','USER=cua','--workdir','/home/cua/workspace','--',state.containerId,'python3','-u','-c',GUEST_COMMAND,'run',COMMAND_ROOT,expect.any(String),'cua','30','/bin/sh','-c','echo hello'])
  await f.provider.execute(f.spec,['/bin/sh','-c','id -u'],{authorize:()=>{},user:'root'})
  expect(f.calls.find(args=>args.includes('HOME=/root'))).toEqual(['exec','--user','0:0','--env','HOME=/root','--env','USER=root','--workdir','/home/cua/workspace','--',state.containerId,'python3','-u','-c',GUEST_COMMAND,'run',COMMAND_ROOT,expect.any(String),'root','30','/bin/sh','-c','id -u'])
  await expect(f.provider.ensure({...f.spec,ownerKey:'different-account'},()=>{})).rejects.toMatchObject({code:'computer_owner_mismatch'})
  await f.provider.remove(f.spec)
  expect(f.calls.find(args=>args[0]==='rm')).toEqual(['rm','--',state.containerId])
})
it('waits for the desktop driver on a cold start before sending a GUI command',async()=>{
  const f=await fixture();await f.provider.ensure(f.spec,()=>{})
  let checks=0
  const provider=new ContainerComputerProvider('docker',f.provider.runnerId,f.home,async(runtime,args,options)=>{
    if(args.includes('health_report')){
      checks++
      if(checks<3)throw Object.assign(new Error('driver starting'),{stderr:'Cua Driver daemon is not running on /run/user/1000/openmausbot-cua.sock.'})
    }
    return f.run(runtime,args,options)
  },{})
  await provider.execute(f.spec,[CUA_DRIVER,'call','get_desktop_state','{}'],{authorize:()=>{},lane:'gui'})
  expect(checks).toBe(3)
  expect(f.calls.filter(args=>args.includes('health_report'))).toHaveLength(1)
  expect(f.calls.some(args=>args.includes('get_desktop_state'))).toBe(true)
})
it.each([
  (d:any)=>{d.HostConfig.Privileged=true},
  (d:any)=>{d.HostConfig.CapAdd.push('SYS_ADMIN')},
  (d:any)=>{d.HostConfig.Memory=0},
  (d:any)=>{d.HostConfig.NetworkMode='host'},
  (d:any)=>{d.HostConfig.PidMode='host'},
  (d:any)=>{d.HostConfig.SecurityOpt=['seccomp=unconfined']},
  (d:any)=>{d.Mounts[0].Source='/Users/private'},
  (d:any)=>{d.Mounts.push({Source:'/var/run/docker.sock'})},
  (d:any)=>{d.HostConfig.PortBindings['6901/tcp']=[{HostIp:'127.0.0.1',HostPort:'12345'}]},
  (d:any)=>{d.Image=`sha256:${'c'.repeat(64)}`},
])('refuses execution when an existing container no longer matches its constraints (%#)',async mutate=>{
  const f=await fixture();await f.provider.ensure(f.spec,()=>{});mutate(f.detail)
  await expect(f.provider.execute(f.spec,['true'],{authorize:()=>{}})).rejects.toMatchObject({code:'computer_configuration_unsafe'})
  expect(f.calls.some(args=>args[0]==='exec')).toBe(false)
  await f.provider.stop(f.spec)
  expect(f.detail.State.Running).toBe(false)
})

it('replaces an existing desktop created with the old no-new-privileges flag',async()=>{
  const f=await fixture();await f.provider.ensure(f.spec,()=>{})
  f.detail.HostConfig.SecurityOpt=['no-new-privileges:true'];f.detail.State.Running=true
  const state=await f.provider.ensure(f.spec,()=>{})
  expect(state.running).toBe(true)
  expect(f.detail.HostConfig.SecurityOpt).toEqual([])
  expect(f.calls.filter(args=>args[0]==='create')).toHaveLength(2)
  expect(f.calls.some(args=>args[0]==='rm')).toBe(true)
  expect(f.calls.flat().includes('no-new-privileges:true')).toBe(false)
})
it('does not stop or remove an identically named container belonging to another node',async()=>{
  const f=await fixture();await f.provider.ensure(f.spec,()=>{})
  f.detail.Config.Labels['cn.samien.yaoyao.runner']=randomUUID()
  await expect(f.provider.stop(f.spec)).rejects.toMatchObject({code:'computer_owner_mismatch'})
  await expect(f.provider.remove(f.spec)).rejects.toMatchObject({code:'computer_owner_mismatch'})
  expect(f.calls.some(args=>['stop','rm'].includes(args[0]!))).toBe(false)
})
it('rejects workspace links and remote engine contexts before creating a computer',async()=>{
  const f=await fixture(),outside=await mkdtemp(join(tmpdir(),'yaoyao-computer-outside-'));homes.push(outside)
  await mkdir(join(f.home,'computer-workspaces'));await symlink(outside,join(f.home,'computer-workspaces',f.spec.id))
  await expect(f.provider.ensure(f.spec,()=>{})).rejects.toMatchObject({code:'computer_path_unsafe'})
  const remote=new ContainerComputerProvider('docker',randomUUID(),f.home,f.run,{DOCKER_HOST:'tcp://remote.invalid:2375'})
  await expect(remote.ensure(f.spec,()=>{})).rejects.toMatchObject({code:'computer_remote_engine'})
  expect(f.calls.some(args=>args[0]==='create')).toBe(false)
})
it('checks authority again after asynchronous inspection, before a guest command starts',async()=>{
  const f=await fixture();await f.provider.ensure(f.spec,()=>{})
  let active=true
  const provider=new ContainerComputerProvider('docker',f.provider.runnerId,f.home,async(runtime,args,options)=>{
    const result=await f.run(runtime,args,options);if(args[0]==='inspect')active=false;return result
  },{})
  await expect(provider.execute(f.spec,['true'],{authorize:()=>{if(!active)throw new Error('revoked')}})).rejects.toThrow('revoked')
  expect(f.calls.some(args=>args[0]==='exec')).toBe(false)
})

it('recreates a migrated mount while retaining the stopped original container and persistent workspace',async()=>{
  const f=await fixture(),oldRoot=join(f.home,'.hermes-yaoyao'),newRoot=join(f.home,'.yaoyao')
  const oldHome=join(oldRoot,'runner-state/r1'),newHome=join(newRoot,'runner-state/r1')
  await mkdir(oldHome,{recursive:true})
  const provider=new ContainerComputerProvider('docker',f.provider.runnerId,oldHome,f.run,{})
  await provider.ensure(f.spec,()=>{});await provider.stop(f.spec)
  await writeFile(join(oldHome,'computer-workspaces',f.spec.id,'keep.txt'),'keep workspace')
  await rename(oldRoot,newRoot)
  await writeFile(join(newRoot,'.data-home-migration.json'),JSON.stringify({source:oldRoot,target:newRoot,phase:'complete'}))
  let renamed=false
  const next=new ContainerComputerProvider('docker',f.provider.runnerId,newHome,async(runtime,args,options)=>{
    if(args[0]==='rename'){renamed=true;expect(args[1]).toBe(f.detail.Id);expect(args[2]).toContain('-before-data-move-');return {stdout:'',stderr:''}}
    if(args[0]==='inspect'&&renamed&&args[1]!==f.detail.Id)throw Object.assign(new Error('missing'),{stderr:'No such object'})
    if(args[0]==='create')renamed=false
    return f.run(runtime,args,options)
  },{})
  const state=await next.ensure(f.spec,()=>{})
  expect(state.workspace).toContain('/.yaoyao/')
  await expect((await import('node:fs/promises')).readFile(join(state.workspace,'keep.txt'),'utf8')).resolves.toBe('keep workspace')
  expect(f.calls.filter(args=>args[0]==='rm')).toHaveLength(0)
})
it('runs command lanes concurrently, serializes desktop input and drains every lane before lifecycle operations',async()=>{
  const order:string[]=[],held:Array<()=>void>=[]
  let active=0,peak=0
  const f=await fixture('docker',async args=>{
    if(args[0]==='exec'){
      const marker=String(args.at(-1))
      active++;peak=Math.max(peak,active)
      try{
        if(marker.startsWith('hold'))await new Promise<void>(resolve=>held.push(resolve))
        order.push(`exec:${marker}`)
      }finally{active--}
    }
    if(args[0]==='stop'||args[0]==='rm')order.push(args[0]!)
  })
  await f.provider.ensure(f.spec,()=>{})
  // File commands from different holders overlap on the exec lane.
  const slowFile=f.provider.execute(f.spec,['/bin/sh','-c','hold-a'],{authorize:()=>{}})
  await f.provider.execute(f.spec,['/bin/sh','-c','plain-b'],{authorize:()=>{}})
  expect(order).toContain('exec:plain-b')
  // Desktop input is serialized: the second GUI action waits for the first.
  const slowGui=f.provider.execute(f.spec,['driver','hold-gui-1'],{authorize:()=>{},lane:'gui'})
  let guiTwoDone=false
  const guiTwo=f.provider.execute(f.spec,['driver','plain-gui-2'],{authorize:()=>{},lane:'gui'}).then(()=>{guiTwoDone=true})
  await new Promise(resolve=>setTimeout(resolve,25))
  expect(guiTwoDone).toBe(false)
  // A lifecycle operation drains both lanes before touching the container.
  let stopped=false
  const stopping=f.provider.stop(f.spec).then(()=>{stopped=true})
  await new Promise(resolve=>setTimeout(resolve,25))
  expect(stopped).toBe(false)
  for(const release of held.splice(0))release()
  await Promise.all([slowFile,slowGui,guiTwo,stopping])
  expect(guiTwoDone).toBe(true)
  expect(peak).toBeGreaterThanOrEqual(2)
  expect(order.filter(entry=>entry.startsWith('exec:')).indexOf('exec:plain-gui-2')).toBeGreaterThan(order.indexOf('exec:hold-gui-1'))
  expect(order.indexOf('stop')).toBeGreaterThan(order.indexOf('exec:plain-gui-2'))
})
it('keeps a shared desktop alive when one holder cancels an unacknowledged operation',async()=>{
  let stopped=0
  const f=await fixture('docker',async args=>{
    if(args[0]==='stop')stopped++
    if(args[0]==='exec'&&String(args.at(-1)).startsWith('boom'))throw Object.assign(new Error('unacknowledged'),{killed:true})
  })
  await f.provider.ensure(f.spec,()=>{})
  // Another holder still shares the desktop: the ambiguous operation must not close it.
  await expect(f.provider.execute(f.spec,['/bin/sh','-c','boom-shared'],{authorize:()=>{},mayFence:()=>false})).rejects.toMatchObject({code:'computer_cancel_uncertain'})
  await new Promise(resolve=>setTimeout(resolve,25))
  expect(stopped).toBe(0)
  await f.provider.execute(f.spec,['/bin/sh','-c','after'],{authorize:()=>{}})
  // A sole holder keeps the original hard fence.
  await expect(f.provider.execute(f.spec,['/bin/sh','-c','boom-alone'],{authorize:()=>{}})).rejects.toMatchObject({code:'computer_cancel_uncertain'})
  await new Promise(resolve=>setTimeout(resolve,25))
  expect(stopped).toBe(1)
})

it('requires a guest stop acknowledgement for a cancelled command and preserves another holder',async()=>{
  const f=await fixture(),abort=new AbortController(),calls:string[][]=[]
  await f.provider.ensure(f.spec,()=>{})
  let acknowledge:()=>void=()=>{}
  const provider=new ContainerComputerProvider('docker',f.provider.runnerId,f.home,async(runtime,args,options)=>{
    calls.push(args)
    if(args.includes(GUEST_COMMAND)&&args.includes('run')){abort.abort();return {stdout:'late',stderr:''}}
    if(args.includes(GUEST_COMMAND)&&args.includes('cancel')){
      expect(options?.signal).toBeUndefined()
      await new Promise<void>(resolve=>{acknowledge=resolve})
      return {stdout:JSON.stringify({stopped:true}),stderr:''}
    }
    return f.run(runtime,args,options)
  },{})
  let finished=false
  const execution=provider.execute(f.spec,['work'],{authorize:()=>{},signal:abort.signal,mayFence:()=>false}).catch(error=>{finished=true;return error})
  await vi.waitFor(()=>expect(calls.some(args=>args.includes('cancel'))).toBe(true))
  expect(finished).toBe(false)
  const running=calls.find(args=>args.includes('run'))!,cancelled=calls.find(args=>args.includes('cancel'))!
  expect(cancelled.at(-1)).toBe(running[running.indexOf(COMMAND_ROOT)+1])
  acknowledge()
  expect(await execution).toMatchObject({code:'computer_cancelled'})
  expect(calls.some(args=>args[0]==='stop')).toBe(false)
})
