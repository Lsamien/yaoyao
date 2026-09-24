// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {ComputerPool} from '../../src/runner/computers/pool'
import {ContainerComputerProvider,type ComputerProvider,type ComputerSpecification} from '../../src/runner/computers/container'
const databases:DatabaseSync[]=[]
afterEach(()=>{for(const db of databases.splice(0))db.close()})
const spec=():ComputerSpecification=>({id:randomUUID(),ownerKey:'owner',imageId:`sha256:${'a'.repeat(64)}`})
it('uses the configured idle deadline, resets it after reuse, and never exempts active leases from expiry',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec()
  f.pool.idleStopMinutes=15
  await f.pool.desktop(resource,'start',()=>{})
  f.advance(5*60000);await f.pool.expire();expect(f.pool.status('owner')[0]?.status).toBe('idle')
  const lease=await f.pool.acquire(resource,'next',()=>{})
  expect(vi.mocked(f.provider.ensure)).toHaveBeenCalledTimes(2)
  await f.pool.release(lease,true)
  f.advance(15*60000-1);await f.pool.expire();expect(f.pool.status('owner')[0]?.status).toBe('idle')
  f.advance(1);await f.pool.expire();expect(f.pool.status('owner')[0]?.status).toBe('free')
  f.pool.idleStopMinutes=0;await f.pool.desktop(resource,'start',()=>{})
  f.advance(30*24*60*60000);await f.pool.expire();expect(f.pool.status('owner')[0]?.status).toBe('idle')
  await f.pool.acquire(resource,'expired-holder',()=>{});f.advance(30001);await f.pool.expire()
  expect(f.pool.status('owner')[0]?.status).toBe('free')
  await f.pool.desktop(resource,'start',()=>{});await f.pool.close();expect(f.pool.status('owner')[0]?.status).toBe('free')
})
function fixture(limits={concurrent:2,environments:32,ttlMs:30000}){
  let clock=100000
  const db=new DatabaseSync(':memory:');databases.push(db)
  const validate=new ContainerComputerProvider('docker',randomUUID(),'/unused').validateSpecification
  const provider={validateSpecification:validate,ensure:vi.fn(async(_spec,authorize)=>{authorize();return {running:true}}),stop:vi.fn(async()=>{}),remove:vi.fn(async()=>{})} as unknown as ComputerProvider
  const pool=new ComputerPool(db,provider,limits,()=>clock)
  return {db,provider,pool,advance:(value:number)=>{clock+=value}}
}
it('reserves quota before starting, shares an active environment and rejects malformed specs before storage',async()=>{
  const f=fixture({concurrent:1,environments:2,ttlMs:30000});await f.pool.recover()
  const first=spec();const lease=await f.pool.acquire(first,'task-one',()=>{})
  expect(await f.pool.acquire(first,'task-one',()=>{})).toEqual(lease)
  // A second holder joins the active shared environment without a new container or quota.
  const joined=await f.pool.acquire(first,'task-two',()=>{})
  expect(joined.generation).toBe(lease.generation)
  expect(f.provider.ensure).toHaveBeenCalledTimes(1)
  expect(f.pool.status('owner')[0]?.holderIds).toEqual(expect.arrayContaining(['task-one','task-two']))
  await expect(f.pool.acquire(spec(),'task-three',()=>{})).rejects.toMatchObject({code:'computer_quota'})
  await expect(f.pool.acquire({...spec(),imageId:'untrusted:latest'},'invalid',()=>{})).rejects.toMatchObject({code:'computer_spec_invalid'})
  expect(f.db.prepare('SELECT count(*) AS n FROM computer_environments').get()?.n).toBe(1)
  expect(f.pool.status('different-owner')).toEqual([])
  // One holder leaving keeps the desktop for the other; the last one stops it.
  await f.pool.release(lease)
  expect(f.pool.status('owner')[0]?.status).toBe('active')
  expect(f.provider.stop).not.toHaveBeenCalled()
  await f.pool.release(joined)
  expect(f.pool.status('owner')[0]?.status).toBe('free')
  expect(f.provider.stop).toHaveBeenCalledTimes(1)
  await f.pool.close()
})
it('fences cancellation before an old operation returns and waits for its stop before admitting a successor',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'task-one',()=>{})
  let entered=false
  const operation=f.pool.use(lease,({signal})=>new Promise<void>((resolve)=>{entered=true;signal.addEventListener('abort',()=>resolve(),{once:true})})).catch(error=>error)
  await vi.waitFor(()=>expect(entered).toBe(true))
  const released=f.pool.release(lease)
  expect(await operation).toMatchObject({code:'computer_lease_stale'})
  await released
  const next=await f.pool.acquire(resource,'task-two',()=>{})
  expect(next.generation).toBeGreaterThan(lease.generation)
  expect(()=>f.pool.release(lease)).toThrow('电脑控制权已改变')
  expect(f.provider.stop).toHaveBeenCalledTimes(1)
  await f.pool.close()
})
it('aborts only the cancelled holder and keeps other shared work in the same environment generation',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),abort=new AbortController()
  const cancelled=await f.pool.acquire(resource,'cancelled',()=>{},abort.signal)
  const peer=await f.pool.acquire(resource,'peer',()=>{})
  let cancelledSignal:AbortSignal|undefined,peerSignal:AbortSignal|undefined,finishPeer!:()=>void
  const cancelledWork=f.pool.use(cancelled,({signal})=>new Promise<void>(resolve=>{
    cancelledSignal=signal;signal.addEventListener('abort',()=>resolve(),{once:true})
  })).catch(error=>error)
  const peerWork=f.pool.use(peer,({signal})=>new Promise<void>(resolve=>{peerSignal=signal;finishPeer=resolve}))
  await vi.waitFor(()=>expect(peerSignal).toBeDefined())
  try{
    abort.abort()
    expect(cancelledSignal?.aborted).toBe(true)
    await expect(cancelledWork).resolves.toMatchObject({code:'computer_lease_stale'})
    // Joining also drains any queued lifecycle work from the cancellation.
    const next=await f.pool.acquire(resource,'next',()=>{})
    expect(next.generation).toBe(peer.generation)
    expect(peerSignal?.aborted).toBe(false)
    expect(()=>f.pool.authorize(peer)).not.toThrow()
    expect(f.provider.stop).not.toHaveBeenCalled()
    expect(f.provider.ensure).toHaveBeenCalledTimes(1)
  }finally{finishPeer();await peerWork.catch(()=>{});await f.pool.close()}
})
it('rejects an already cancelled holder without touching another shared holder',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),peer=await f.pool.acquire(resource,'peer',()=>{})
  try{
    await expect(f.pool.acquire(resource,'cancelled',()=>{},AbortSignal.abort())).rejects.toMatchObject({code:'computer_cancelled'})
    expect(()=>f.pool.authorize(peer)).not.toThrow()
    expect(f.pool.status('owner')[0]?.holderIds).toEqual(['peer'])
    expect(f.provider.stop).not.toHaveBeenCalled()
  }finally{await f.pool.close()}
})
it('keeps an unconfirmed stop reserved and recovers it before a new acquisition',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'task',()=>{})
  vi.mocked(f.provider.stop).mockRejectedValueOnce(new Error('daemon unavailable'))
  await expect(f.pool.release(lease)).rejects.toThrow('daemon unavailable')
  expect(f.pool.status('owner')[0]?.status).toBe('uncertain')
  await expect(f.pool.acquire(resource,'new-task',()=>{})).rejects.toMatchObject({code:'computer_busy'})
  const restarted=new ComputerPool(f.db,f.provider)
  await expect(restarted.acquire(resource,'new-task',()=>{})).rejects.toMatchObject({code:'computer_pool_unavailable'})
  await restarted.recover()
  const next=await restarted.acquire(resource,'new-task',()=>{})
  expect(next.generation).toBeGreaterThan(lease.generation)
  await restarted.close()
})
it('retries an unconfirmed stop on later sweeps so the environment does not stay blocked',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'task',()=>{})
  vi.mocked(f.provider.stop).mockRejectedValueOnce(new Error('daemon unavailable'))
  await expect(f.pool.release(lease)).rejects.toThrow('daemon unavailable')
  expect(f.pool.status('owner')[0]?.status).toBe('uncertain')
  f.advance(29999);await f.pool.expire()
  expect(f.pool.status('owner')[0]?.status).toBe('uncertain')
  f.advance(1);await f.pool.expire()
  expect(f.pool.status('owner')[0]?.status).toBe('free')
  const next=await f.pool.acquire(resource,'new-task',()=>{})
  expect(next.generation).toBeGreaterThan(lease.generation)
  await f.pool.close()
})
it('does not expire a new holder acquired while an earlier environment stop was in flight',async()=>{
  const f=fixture();await f.pool.recover();const a=spec(),b=spec()
  const first=await f.pool.acquire(a,'first',()=>{}),second=await f.pool.acquire(b,'second',()=>{})
  let release!:()=>void,entered=false
  const gate=new Promise<void>(resolve=>{release=resolve})
  vi.mocked(f.provider.stop).mockImplementation(async resource=>{if(resource.id===a.id){entered=true;await gate}})
  f.advance(30001)
  const sweep=f.pool.expire()
  await vi.waitFor(()=>expect(entered).toBe(true))
  await f.pool.release(second)
  const replacement=await f.pool.acquire(b,'replacement',()=>{})
  release();await sweep
  expect(f.pool.status('owner').find(row=>row.environmentId===a.id)?.status).toBe('free')
  expect(f.pool.status('owner').find(row=>row.environmentId===b.id)).toMatchObject({status:'active',holderIds:['replacement'],generation:replacement.generation})
  expect(()=>f.pool.renew(first)).toThrow()
  f.pool.renew(replacement);await f.pool.close()
})
it('rechecks authority and cleans up a creation cancelled while the provider is starting',async()=>{
  const f=fixture();await f.pool.recover();const abort=new AbortController()
  let release!:()=>void,entered=false
  const gate=new Promise<void>(resolve=>{release=resolve})
  vi.mocked(f.provider.ensure).mockImplementationOnce(async(_spec,authorize)=>{entered=true;await gate;authorize();return {} as any})
  const acquiring=f.pool.acquire(spec(),'starting',()=>{},abort.signal).catch(error=>error)
  await vi.waitFor(()=>expect(entered).toBe(true));abort.abort();release()
  expect(await acquiring).toBeInstanceOf(Error)
  expect(f.pool.status('owner')[0]?.status).toBe('free')
  expect(f.provider.stop).toHaveBeenCalledTimes(1)
  await f.pool.close()
})
it('rejects changes of account identity and resource configuration for a persistent environment',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'task',()=>{})
  await f.pool.release(lease)
  for(const change of [{ownerKey:'other'},{memoryMiB:8192}])await expect(f.pool.acquire({...resource,...change},'changed',()=>{})).rejects.toMatchObject({code:'computer_owner_mismatch'})
  expect(f.provider.ensure).toHaveBeenCalledTimes(1)
})
it('applies a changed authoritative cwd only after an environment is released',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'task',()=>{})
  const updated={...resource,cwd:'/projects/new-location'}
  await expect(f.pool.configure(updated,()=>{})).rejects.toMatchObject({code:'computer_busy'})
  await f.pool.release(lease)
  await f.pool.configure(updated,()=>{})
  const next=await f.pool.acquire(updated,'next',()=>{})
  expect(next.generation).toBeGreaterThan(lease.generation)
  await f.pool.close()
})
it('lets a human takeover join an active environment and fence only its own holder',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'agent',()=>{})
  f.provider.inspect=vi.fn(async()=>({id:resource.id,containerId:'same-computer',running:true,workspace:'/fixture',isolation:'container'}))
  // The human becomes a second holder of the same live desktop — nothing stops.
  const human=await f.pool.acquire(resource,'human:control',()=>{})
  expect(human.generation).toBe(lease.generation)
  expect(f.pool.status('owner')[0]?.holderIds).toEqual(expect.arrayContaining(['agent','human:control']))
  expect(f.provider.stop).not.toHaveBeenCalled()
  f.pool.authorize(human);f.pool.authorize(lease)
  // Ending the human's control hands the desktop back without stopping it.
  await f.pool.release(human,true)
  expect(f.pool.status('owner')[0]?.status).toBe('active')
  expect(f.pool.status('owner')[0]?.holderIds).toEqual(['agent'])
  expect(f.provider.stop).not.toHaveBeenCalled()
  await f.pool.close()
})
