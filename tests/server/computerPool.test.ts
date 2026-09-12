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
  const lease=await f.pool.acquire(resource,'next',()=>{});await f.pool.release(lease,true)
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
it('reserves quota before starting, rejects another holder and rejects malformed specs before storage',async()=>{
  const f=fixture({concurrent:1,environments:2,ttlMs:30000});await f.pool.recover()
  const first=spec();const lease=await f.pool.acquire(first,'task-one',()=>{})
  expect(await f.pool.acquire(first,'task-one',()=>{})).toEqual(lease)
  await expect(f.pool.acquire(first,'task-two',()=>{})).rejects.toMatchObject({code:'computer_busy'})
  await expect(f.pool.acquire(spec(),'task-three',()=>{})).rejects.toMatchObject({code:'computer_quota'})
  await expect(f.pool.acquire({...spec(),imageId:'untrusted:latest'},'invalid',()=>{})).rejects.toMatchObject({code:'computer_spec_invalid'})
  expect(f.db.prepare('SELECT count(*) AS n FROM computer_environments').get()?.n).toBe(1)
  expect(f.pool.status('different-owner')).toEqual([])
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
  expect(f.pool.status('owner').find(row=>row.environmentId===b.id)).toMatchObject({status:'active',holderId:'replacement',generation:replacement.generation})
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
it('transfers an idle live computer with a new generation and rejects its previous holder',async()=>{
  const f=fixture();await f.pool.recover();const resource=spec(),lease=await f.pool.acquire(resource,'agent',()=>{})
  f.provider.inspect=vi.fn(async()=>({id:resource.id,containerId:'same-computer',running:true,workspace:'/fixture',isolation:'container'}))
  const human=await f.pool.transfer(lease,'human',()=>{})
  expect(human.generation).toBeGreaterThan(lease.generation)
  expect(()=>f.pool.authorize(lease)).toThrow()
  expect(f.provider.stop).not.toHaveBeenCalled()
  f.pool.authorize(human)
  const resumed=await f.pool.transfer(human,'agent',()=>{})
  expect(resumed.generation).toBeGreaterThan(human.generation)
  await f.pool.close()
})
