// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ContainerComputerProvider,type ComputerSpecification} from '../../src/runner/computers/container'
import {ComputerMaintenance} from '../../src/runner/computers/maintenance'

it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('migrates a legacy home and keeps real browser and encrypted application authorization through rebuild and restore',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-auth-live-'))
  const provider=new ContainerComputerProvider('docker',randomUUID(),home)
  const spec:ComputerSpecification={id:randomUUID(),ownerKey:randomUUID(),imageId:process.env.YAOYAO_COMPUTER_IMAGE!,network:process.env.YAOYAO_COMPUTER_NETWORK==='managed-proxy'?'managed-proxy':'none'}
  const script=await readFile(new URL('../fixtures/computer_auth.mjs',import.meta.url),'utf8')
  const execute=(argv:string[],user:'cua'|'root'='cua')=>provider.execute(spec,argv,{authorize:()=>{},user,timeout:60000}).catch(error=>{throw new Error(`${argv[0]} ${argv.at(-1)}: ${error.stderr??error.message}`)})
  const maintenance=new ComputerMaintenance({status:()=>[{environmentId:spec.id,status:'free'}]} as any,provider,home)
  let derivedImage:string|undefined
  try{
    // Exercise the real upgrade path from the old workspace-only container.
    const workspace=await (provider as any).workspace(provider.validateSpecification(spec))
    if(spec.network==='managed-proxy')await (provider as any).ensureNetwork(provider.validateSpecification(spec),()=>{})
    const created=await provider.run('docker',(provider as any).args(provider.validateSpecification(spec),workspace))
    const legacyId=created.stdout.trim();await provider.run('docker',['start',legacyId])
    expect(JSON.parse((await execute(['node','--input-type=module','-e',script,'login'])).stdout)).toEqual({browser:true,encryptedApplicationToken:true})
    await execute(['sh','-c','mkdir -p /root/.config; printf root-fixture > /root/.config/authorization'],'root')
    const identity=(await execute(['cat','/var/lib/dbus/machine-id'])).stdout
    // The updater uses a fresh provider without a cached gateway identity.
    const migration=new ContainerComputerProvider('docker',provider.runnerId,home)
    expect(await migration.preserveUserData(spec)).toBe(true)
    await provider.remove(spec)
    const migrated=await provider.ensure(spec,()=>{})
    expect(migrated.containerId).not.toBe(legacyId)
    expect((await execute(['cat','/etc/machine-id'])).stdout).toBe(identity)
    expect((await execute(['cat','/root/.config/authorization'],'root')).stdout).toBe('root-fixture')
    expect(JSON.parse((await execute(['node','--input-type=module','-e',script,'check'])).stdout).browser).toBe(true)
    await maintenance.rebuild(spec);await provider.ensure(spec,()=>{})
    expect(JSON.parse((await execute(['node','--input-type=module','-e',script,'check'])).stdout).encryptedApplicationToken).toBe(true)
    await provider.stop(spec)
    derivedImage=(await provider.run('docker',['commit',(await provider.inspect(spec))!.containerId],{timeout:60000})).stdout.trim()
    await provider.remove(spec);spec.imageId=derivedImage
    await provider.ensure(spec,()=>{})
    expect(JSON.parse((await execute(['node','--input-type=module','-e',script,'check'])).stdout).browser).toBe(true)
    expect(await readdir(join(home,'computer-backups',spec.id))).toHaveLength(1)
    await maintenance.backup(spec,join(home,'snapshot'))
    await provider.ensure(spec,()=>{})
    await execute(['sh','-c','rm -rf ~/.config/yaoyao-auth-fixture ~/.local/share/keyrings/yaoyao-auth-fixture ~/.config/yaoyao-auth-browser'])
    await maintenance.restore(spec,join(home,'snapshot'))
    await provider.ensure(spec,()=>{})
    expect(JSON.parse((await execute(['node','--input-type=module','-e',script,'check'])).stdout).browser).toBe(true)
    expect((await execute(['cat','/etc/machine-id'])).stdout).toBe(identity)
  }finally{await provider.remove(spec);if(derivedImage)await provider.run('docker',['image','rm',derivedImage]);await rm(home,{recursive:true,force:true})}
},180000)
it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('flushes a newly authenticated open browser before rebuilding its container',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-open-auth-')),provider=new ContainerComputerProvider('docker',randomUUID(),home)
  const spec={id:randomUUID(),ownerKey:randomUUID(),imageId:process.env.YAOYAO_COMPUTER_IMAGE!}
  const script=await readFile(new URL('../fixtures/computer_auth.mjs',import.meta.url),'utf8')
  try{
    const state=await provider.ensure(spec,()=>{}),data=join(home,'computer-userdata',spec.id,'home')
    await provider.health(spec,()=>{})
    await provider.run('docker',['exec','-d','--user','1000:1000','--env','HOME=/home/cua',state.containerId,'node','--input-type=module','-e',script,'login-open'])
    await expect.poll(()=>readFile(join(data,'.config/yaoyao-auth-fixture/ready'),'utf8').catch(()=>''),{timeout:35000,interval:200}).toBe('ready')
    await provider.remove(spec)
    const preferences=JSON.parse(await readFile(join(data,'.config/yaoyao-auth-browser/Default/Preferences'),'utf8'))
    expect(preferences.profile.exit_type).toBe('Normal')
    await provider.ensure(spec,()=>{})
    const result=await provider.execute(spec,['node','--input-type=module','-e',script,'check'],{authorize:()=>{},timeout:60000})
    expect(JSON.parse(result.stdout).browser).toBe(true)
  }finally{await provider.remove(spec);await rm(home,{recursive:true,force:true})}
},100000)
