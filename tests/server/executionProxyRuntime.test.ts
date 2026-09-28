// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerRuntime,type ComputerGateway} from '../../src/runner/worker/gateway'
import {ManagedProxy} from '../../src/runner/network/managedProxy'
import type {VmProxySettings} from '../../src/shared/executionEnvironment'

let home:string,db:DatabaseSync,runtime:ComputerRuntime
const proxy=(revision:number):VmProxySettings=>({enabled:true,protocol:'http',host:'proxy.invalid',port:3128,username:'',revision})
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-proxy-runtime-'));db=new DatabaseSync(':memory:')
  runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:[],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'python3',hermesSource:home,network:'none'}},home)
  await runtime.ready
})
afterEach(async()=>{await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks();rmSync(home,{recursive:true,force:true})})

it('serializes updates, cleans up with the old network and rejects new leases while switching',async()=>{
  let unblock!:()=>void
  const blocked=new Promise<void>(resolve=>{unblock=resolve})
  const close=vi.fn(async()=>{expect(runtime.network).toBe('none');await blocked;runtime.gateways.clear()})
  runtime.gateways.set('fixture',new Set([{close} as unknown as ComputerGateway]))
  const verify=vi.spyOn(runtime.provider,'verifyNetwork').mockResolvedValue()
  const first=runtime.updateProxy(proxy(1)),second=runtime.updateProxy(proxy(1))
  await vi.waitFor(()=>expect(close).toHaveBeenCalledTimes(1))
  expect(()=>runtime.assertNetworkReady()).toThrow('尚未就绪')
  expect(verify).not.toHaveBeenCalled()
  unblock();await Promise.all([first,second])
  expect(verify).toHaveBeenCalledTimes(1)
  expect(runtime.network).toBe('managed-proxy')
  expect(()=>runtime.assertNetworkReady()).not.toThrow()
  await runtime.updateProxy(proxy(0))
  expect(runtime.proxySettings?.revision).toBe(1)
})

it('keeps a failed proxy preparation closed and allows retry of the same revision',async()=>{
  const verify=vi.spyOn(runtime.provider,'verifyNetwork').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue()
  await expect(runtime.updateProxy(proxy(1))).rejects.toThrow('unavailable')
  expect(runtime.network).toBe('managed-proxy')
  expect(()=>runtime.assertNetworkReady()).toThrow()
  await runtime.updateProxy(proxy(1))
  expect(verify).toHaveBeenCalledTimes(2)
  expect(()=>runtime.assertNetworkReady()).not.toThrow()
})

it('does not share a failed network channel with the next task',async()=>{
  vi.spyOn(runtime.provider,'verifyNetwork').mockResolvedValue()
  await runtime.updateProxy(proxy(1))
  let stopped!:()=>void
  const old={close:vi.fn(async()=>{})},next={close:vi.fn(async()=>{})}
  const start=vi.spyOn(ManagedProxy,'start').mockImplementationOnce(async(_provider,_spec,_proxy,_authorize,onClose)=>{stopped=onClose!;return old as unknown as ManagedProxy}).mockResolvedValueOnce(next as unknown as ManagedProxy)
  const spec={id:randomUUID(),ownerKey:'fixture',imageId:'sha256:'+'a'.repeat(64),cwd:'/workspace',network:'managed-proxy' as const}
  const first=await runtime.acquireProxy(spec,()=>{})
  stopped()
  const second=await runtime.acquireProxy(spec,()=>{})
  expect(start).toHaveBeenCalledTimes(2)
  await first.release()
  expect(next.close).not.toHaveBeenCalled()
  await second.release()
  expect(next.close).toHaveBeenCalledTimes(1)
})

it('uses the same proxy for human takeover and ends old control leases when the proxy changes',async()=>{
  vi.spyOn(runtime.provider,'verifyNetwork').mockResolvedValue()
  vi.spyOn(runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/workspace',configuredCwd:'/workspace'})
  const ensure=vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id:'fixture',containerId:'fixture',running:true,workspace:home,isolation:'container'})
  vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
  const close=vi.fn(async()=>{})
  vi.spyOn(ManagedProxy,'start').mockResolvedValue({close} as unknown as ManagedProxy)
  await runtime.updateProxy(proxy(1))
  const meta={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'fixture'},controlId=randomUUID()
  await runtime.controls.take(meta,'default',controlId,async()=>{})
  await vi.waitFor(async()=>expect((await runtime.controls.status(meta)).mode).toBe('human'))
  expect(ensure.mock.calls[0]?.[0].network).toBe('managed-proxy')
  await runtime.updateProxy(proxy(2))
  expect(close).toHaveBeenCalled()
  expect((await runtime.controls.status(meta)).controlId).toBeUndefined()
  expect(runtime.pool.hasHolders(meta.ownerKey,meta.environmentId)).toBe(false)
  await runtime.controls.take(meta,'default',randomUUID(),async()=>{})
  await vi.waitFor(async()=>expect((await runtime.controls.status(meta)).mode).toBe('human'))
})
