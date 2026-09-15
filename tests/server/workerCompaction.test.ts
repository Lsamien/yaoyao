// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'

async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'yaoyao-compaction-')),db=new DatabaseSync(':memory:'),script=join(home,'worker.py')
 await writeFile(script,`import json,sys
boot=json.loads(sys.stdin.readline())
def emit(kind, **data):
    print(json.dumps({"nonce":boot["nonce"],"type":kind,**data}),flush=True)
payload=json.loads(boot["prompt"])
emit("checkpoint",messages=payload.pop("checkpoint",boot["history"]))
emit("probe",boot=boot)
emit("complete",**payload)
for line in sys.stdin:
    if json.loads(line).get("type")=="interrupt":break
`)
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'python3',hermesSource:home,hermesHome:home,network:'none'}},home,script)
 await runtime.ready;runtime.retainDesktops=true
 const id=randomUUID(),meta={environmentId:id,agentId:id,ownerKey:'owner'},gateways:ComputerGateway[]=[]
 vi.spyOn(runtime,'resolve').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:'.',model:{provider:'custom',api_mode:'chat_completions',model:'fixture'},contextConfig:{compression:{enabled:true,threshold:0.5}}})
 vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id,containerId:'fixture',running:true,workspace:home,isolation:'container'})
 const stop=vi.spyOn(runtime.provider,'stop').mockResolvedValue(),remove=vi.spyOn(runtime.provider,'remove').mockResolvedValue()
 async function turn(payload:Record<string,unknown>,sessionId?:string){
  const gateway=new ComputerGateway(runtime,meta,randomUUID(),async()=>{},async()=>({}));gateways.push(gateway)
  const completed=new Promise<any>((resolve,reject)=>{gateway.onEvent=frame=>{if(frame.type==='message.complete')resolve(frame.payload)};gateway.onDisconnect=()=>reject(new Error('unexpected disconnection'))})
  await gateway.connect();const opened=await gateway.rpc(sessionId?'session.resume':'session.create',{profile:'default',...(sessionId?{session_id:sessionId}:{})})
  await gateway.rpc('prompt.submit',{session_id:opened.session_id,text:JSON.stringify(payload)})
  const worker=runtime.workers.get(gateway.workId)!.process,probe=worker.wait('probe',5000)
  return {gateway,sessionId:opened.session_id,result:await completed,boot:(await probe).boot,worker}
 }
 return {db,runtime,meta,stop,remove,turn,async close(){await Promise.all(gateways.map(g=>g.close()));await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks();await rm(home,{recursive:true,force:true})}}
}

it.each(['context_compaction_disabled','context_compaction_failed'])('keeps a desktop idle after %s and resumes the saved compacted history',async failureCode=>{
 const f=await fixture(),checkpoint=[{role:'system',content:'compacted checkpoint'}],history=[...checkpoint,{role:'user',content:'pending task'}]
 try{
  const first=await f.turn({completed:false,failureCode,checkpoint,messages:history,text:'engine context failure'})
  expect(first.boot.tools.map((tool:any)=>tool.name)).toContain('computer_skill_publish')
  expect(first.boot.skillInstructions).toContain('expected_revision')
  expect(first.result).toMatchObject({status:'failed',code:failureCode,error:expect.stringContaining('虚拟机已进入空闲')})
  expect(f.runtime.pool.status('owner')[0]?.status).toBe('idle');expect(f.stop).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled()
  expect(f.runtime.session(first.sessionId,f.meta,'default')).toMatchObject({history,outcome:'failed'})
  first.worker.onEvent({type:'checkpoint',messages:[{role:'user',content:'late frame'}]})
  expect(f.runtime.session(first.sessionId,f.meta,'default').history).toEqual(history)
  await first.gateway.close();expect(f.stop).not.toHaveBeenCalled()
  const nextHistory=[...history,{role:'assistant',content:'continued'}],next=await f.turn({completed:true,messages:nextHistory,text:'continued'},first.sessionId)
  expect(next.boot.skillInstructions).toBe(first.boot.skillInstructions)
  expect(next.boot.history).toEqual(history);expect(next.boot.contextConfig.compression.enabled).toBe(true)
  expect(f.runtime.session(first.sessionId,f.meta,'default')).toMatchObject({history:nextHistory,outcome:'complete'})
 }finally{await f.close()}
})

it.each([
 {completed:false,text:'Context overflow and auto-compaction is disabled'},
 {completed:false,failureCode:'unknown_failure'},
 {completed:false,failureCode:'context_compaction_failed',interrupted:true},
])('stops for unclassified or interrupted failures: %j',async payload=>{
 const f=await fixture()
 try{
  const checkpoint=[{role:'system',content:'latest compacted history'}],result=await f.turn({...payload,checkpoint})
  expect(result.result.status).toBe('failed');expect(result.result).not.toHaveProperty('code')
  expect(f.stop).toHaveBeenCalledOnce();expect(f.remove).toHaveBeenCalledOnce()
  expect(f.runtime.pool.status('owner')[0]?.status).toBe('free')
  expect(f.runtime.session(result.sessionId,f.meta,'default').history).toEqual(checkpoint)
 }finally{await f.close()}
})
