// @vitest-environment node
import {afterEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,symlink,mkdir,rename,writeFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContainerComputerProvider,type ContainerCommand,type ComputerSpecification} from '../../src/runner/computers/container'
const homes:string[]=[]
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})))})
async function fixture(runtime:'docker'|'podman'='docker'){
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-computer-unit-')));homes.push(home)
  const spec:ComputerSpecification={id:randomUUID(),ownerKey:randomUUID(),imageId:`sha256:${'a'.repeat(64)}`}
  let detail:any
  const calls:string[][]=[]
  const run:ContainerCommand=async(_runtime,args)=>{
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
  expect(f.calls.find(args=>args[0]==='exec')).toEqual(['exec','--user','1000:1000','--workdir','/home/cua/workspace','--',state.containerId,'/bin/sh','-c','echo hello'])
  await expect(f.provider.ensure({...f.spec,ownerKey:'different-account'},()=>{})).rejects.toMatchObject({code:'computer_owner_mismatch'})
  await f.provider.remove(f.spec)
  expect(f.calls.find(args=>args[0]==='rm')).toEqual(['rm','--',state.containerId])
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
