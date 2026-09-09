// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ComputerMaintenance} from '../../src/runner/computers/maintenance'
import {ComputerPool} from '../../src/runner/computers/pool'
import {randomUUID} from 'node:crypto'
import {ContainerComputerProvider,CUA_DRIVER,CUA_SOCKET,type ComputerSpecification} from '../../src/runner/computers/container'

// Only creates a UUID-owned private fixture; never adopts user containers.
it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('executes in a real private computer and preserves its workspace across recreation',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-computer-live-'))
  const provider=new ContainerComputerProvider('docker',randomUUID(),home)
  const spec:ComputerSpecification={id:randomUUID(),ownerKey:randomUUID(),imageId:process.env.YAOYAO_COMPUTER_IMAGE!}
  const db=new DatabaseSync(':memory:'),pool=new ComputerPool(db,provider)
  try {
    await pool.recover()
    const lease=await pool.acquire(spec,'initial-task',()=>{})
    const initial=(await provider.inspect(spec))!
    expect(initial.running).toBe(true)
    expect((await provider.execute(spec,['ls','/sys/class/net'],{authorize:()=>{}})).stdout.trim()).toBe('lo')
    const result=await provider.execute(spec,['/bin/sh','-c','id -u; printf isolated-fixture > persistence-proof.txt; pwd'],{authorize:()=>{}})
    expect(result.stdout).toContain('1000\n');expect(result.stdout).toContain('/home/cua/workspace')
    expect(await readFile(join(initial.workspace,'persistence-proof.txt'),'utf8')).toBe('isolated-fixture')
    let healthError=''
    try{await expect.poll(async()=>{
      try{return await provider.health(spec,()=>{})}catch(error){healthError=`${String(error)} ${String((error as any).stderr??'')}`;return null}
    },{timeout:60000,interval:1000}).toMatchObject({schema_version:'1'})}catch{
      const diagnostics=await provider.run('docker',['logs','--tail','70',initial.containerId]).catch(()=>({stdout:'',stderr:''}))
      const vnc=await provider.run('docker',['exec','--user','0',initial.containerId,'/bin/sh','-c','tail -40 /var/log/supervisor/vncserver* /home/cua/.vnc/*.log 2>/dev/null']).catch(error=>({stdout:String(error.stdout??''),stderr:String(error.stderr??'')}))
      throw new Error(`Computer health: ${healthError}\n${diagnostics.stdout}\n${diagnostics.stderr}\n${vnc.stdout}\n${vnc.stderr}`)
    }
    await provider.execute(spec,[CUA_DRIVER,'call','get_desktop_state','{}','--socket',CUA_SOCKET,'--screenshot-out-file','/tmp/yaoyao-computer-proof.png'],{authorize:()=>{}})
    const screenshot=Buffer.from((await provider.execute(spec,['base64','-w0','/tmp/yaoyao-computer-proof.png'],{authorize:()=>{}})).stdout.trim(),'base64')
    expect(screenshot.subarray(1,4).toString()).toBe('PNG');expect(screenshot.byteLength).toBeGreaterThan(1024)
    await mkdir('test-results/computer',{recursive:true});await writeFile('test-results/computer/desktop.png',screenshot)
    await pool.release(lease)
    const nextLease=await pool.acquire(spec,'next-task',()=>{})
    const recreated=(await provider.inspect(spec))!
    expect(recreated.containerId).not.toBe(initial.containerId)
    expect((await provider.execute(spec,['cat','persistence-proof.txt'],{authorize:()=>{}})).stdout).toBe('isolated-fixture')
    const pending=pool.use(nextLease,context=>provider.execute(spec,['/bin/sh','-c','sleep 30; printf should-not-run > cancelled-proof.txt'],context))
    const settled=pending.catch(error=>error)
    await new Promise(resolve=>setTimeout(resolve,500));await pool.release(nextLease)
    expect(await settled).toBeInstanceOf(Error)
    expect(await provider.inspect(spec)).toBeUndefined()
    expect(()=>pool.use(lease,async()=>{})).toThrow('电脑控制权已改变')
    await expect(readFile(join(initial.workspace,'cancelled-proof.txt'))).rejects.toMatchObject({code:'ENOENT'})
    const maintenance=new ComputerMaintenance(pool,provider,home),snapshot=join(home,'snapshot')
    await maintenance.backup(spec,snapshot)
    await writeFile(join(initial.workspace,'persistence-proof.txt'),'changed-after-backup')
    const restored=await maintenance.restore(spec,snapshot)
    expect(await readFile(join(restored.previousWorkspace,'persistence-proof.txt'),'utf8')).toBe('changed-after-backup')
    const restoredLease=await pool.acquire(spec,'restored-task',()=>{})
    expect((await provider.execute(spec,['cat','persistence-proof.txt'],{authorize:()=>{}})).stdout).toBe('isolated-fixture')
    await pool.release(restoredLease)

  }catch(error){console.error('电脑验收错误',String((error as any).stderr??''),String((error as any).stdout??''));throw error}finally{await pool.close();await provider.remove(spec);db.close();await rm(home,{recursive:true,force:true})}
},100000)
