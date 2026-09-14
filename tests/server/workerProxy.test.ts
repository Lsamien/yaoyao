// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'
import type {WorkerProxyEnvironment} from '../../src/runner/worker/process'

it('keeps proxy settings private, reuses them after takeover, and refreshes them when resuming a session',async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-worker-proxy-')),db=new DatabaseSync(':memory:'),script=join(home,'probe.py')
 // Exercise the real Gateway, process launcher and lease lifecycle; replace
 // only the model loop and the VM provider. The probe stays on the private pipe.
 await writeFile(script,`import json,os,sys
boot=json.loads(sys.stdin.readline())
print(json.dumps({"nonce":boot["nonce"],"type":"probe","env":{k:v for k,v in os.environ.items() if k.lower().endswith("_proxy")},"boot":boot}),flush=True)
for line in sys.stdin:
    if json.loads(line).get("type")=="interrupt": break
`)
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'python3',hermesSource:home,hermesHome:home,network:'none'}},home,script)
 const id=randomUUID(),meta={environmentId:id,agentId:id,ownerKey:'owner'},gateways:ComputerGateway[]=[],events:unknown[]=[]
 const first={HTTPS_PROXY:'http://user:first-private-proxy@127.0.0.1:7890',NO_PROXY:'localhost'}
 const second={https_proxy:'http://user:second-private-proxy@127.0.0.1:8890',no_proxy:'internal.test'}
 let current:WorkerProxyEnvironment|undefined=first
 let contextConfig={compression:{enabled:true,threshold:0.5}}
 const createGateway=()=>{
  const gateway=new ComputerGateway(runtime,meta,randomUUID(),async()=>{},async()=>({}))
  gateway.onEvent=frame=>events.push(frame);gateways.push(gateway);return gateway
 }
 const probe=(gateway:ComputerGateway)=>runtime.workers.get(gateway.workId)!.process.wait('probe',5000)
 try{
  await runtime.ready
  const resolver=vi.spyOn(runtime,'resolve').mockImplementation(async()=>({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:'.',model:{provider:'custom',api_mode:'chat_completions',model:'fixture'},contextConfig:structuredClone(contextConfig),...(current?{proxyEnv:{...current}}:{})}))
  const state={id,containerId:'fixture',running:true,workspace:home,isolation:'container' as const}
  const ensure=vi.spyOn(runtime.provider,'ensure').mockResolvedValue(state)
  vi.spyOn(runtime.provider,'inspect').mockResolvedValue(state)
  vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
  const gateway=createGateway();await gateway.connect()
  const created=await gateway.rpc('session.create',{profile:'default'})
  await gateway.rpc('prompt.submit',{session_id:created.session_id,text:'first turn'})
  expect((await probe(gateway)).env).toEqual(first)
  const oldWorker=runtime.workers.get(gateway.workId)!.process
  current=second
  contextConfig={compression:{enabled:false,threshold:0.7}}
  await gateway.takeControl(randomUUID(),()=>{})
  await gateway.giveBack('continue')
  const continued=await probe(gateway)
  expect(continued.env).toEqual(first)
  expect(continued.boot.contextConfig).toEqual({compression:{enabled:true,threshold:0.5}})
  oldWorker.onEvent({type:'checkpoint',messages:[{role:'user',content:'stale worker history'}]})
  expect(JSON.stringify(runtime.session(created.session_id,meta,'default').history)).not.toContain('stale worker history')
  expect(continued.boot.history).toContainEqual({role:'user',content:'first turn'})
  expect(resolver).toHaveBeenCalledTimes(1)
  await gateway.close()

  const resumed=createGateway();await resumed.connect()
  expect((await resumed.rpc('session.resume',{profile:'default',session_id:created.session_id})).session_id).toBe(created.session_id)
  await resumed.rpc('prompt.submit',{session_id:created.session_id,text:'next turn'})
  const resumedProbe=await probe(resumed)
  expect(resumedProbe.env).toEqual(second)
  expect(resumedProbe.boot.contextConfig).toEqual(contextConfig)
  expect(resolver).toHaveBeenCalledTimes(2)
  await resumed.close()

  current=undefined
  const direct=createGateway();await direct.connect()
  await direct.rpc('session.resume',{profile:'default',session_id:created.session_id})
  await direct.rpc('prompt.submit',{session_id:created.session_id,text:'direct turn'})
  const frame=await probe(direct)
  expect(frame.env).toEqual({})
  expect(frame.boot.model).not.toHaveProperty('proxyEnv')
  expect(frame.boot).not.toHaveProperty('proxyEnv')
  expect(resolver).toHaveBeenCalledTimes(3)
  const persisted=db.prepare('SELECT value FROM computer_sessions').all()
  for(const value of [created,persisted,events,ensure.mock.calls])expect(JSON.stringify(value)).not.toMatch(/private-proxy|proxyEnv|HTTPS_PROXY|https_proxy/)
 }finally{
  await Promise.all(gateways.map(gateway=>gateway.close()))
  await runtime.controls.close();await runtime.pool.close();db.close()
  vi.restoreAllMocks();await rm(home,{recursive:true,force:true})
 }
})

it('extracts memory with an empty tool catalog and without acquiring or starting a computer', async () => {
 const home=await mkdtemp(join(tmpdir(),'yaoyao-memory-worker-')),db=new DatabaseSync(':memory:'),script=join(home,'memory.py')
 await writeFile(script,`import json,sys\nboot=json.loads(sys.stdin.readline())\nprint(json.dumps({"nonce":boot["nonce"],"type":"complete","completed":True,"interrupted":False,"text":json.dumps({"tools":boot["tools"],"prompt":boot["prompt"],"history":boot["history"]})}),flush=True)\n`)
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'python3',hermesSource:home,hermesHome:home,network:'none'}},home,script)
 try {
  await runtime.ready
  vi.spyOn(runtime,'resolve').mockResolvedValue({type:'resolved',model:{provider:'custom',api_mode:'chat_completions',model:'fixture'}})
  const ensure=vi.spyOn(runtime.provider,'ensure')
  const result=JSON.parse(await runtime.extractMemory('default','只提炼已给定的事实'))
  expect(result).toEqual({tools:[],prompt:'只提炼已给定的事实',history:[]})
  expect(ensure).not.toHaveBeenCalled()
  expect(runtime.workers.size).toBe(0)
 } finally { await runtime.pool.close();db.close();await rm(home,{recursive:true,force:true}) }
})
