// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {ComputerRuntime,ComputerGateway} from '../../src/runner/worker/gateway'
import {LocalVmImages} from '../../src/runner/computers/localVm'

const available=!!process.env.YAOYAO_HERMES_PYTHON&&!!process.env.YAOYAO_HERMES_SOURCE
async function fixture(enabled:boolean,docker=false,overflow=!enabled,inPlace=true){
 const home=await mkdtemp(join(tmpdir(),'yaoyao-context-live-')),profile=join(home,'profile'),db=new DatabaseSync(':memory:')
 await mkdir(profile);const requests:any[]=[],gateways:ComputerGateway[]=[]
 const summary='## Task\nContinue the fixture task.\n## Progress\nCOMPACTED_WORKER_HISTORY\n'+'Earlier inspection is complete. Keep the user request and continue from the saved result.\n'.repeat(25)
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json')
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture-context-model',context_length:65536}]}));return}
  let body='';for await(const chunk of req)body+=chunk
  const input=JSON.parse(body);requests.push(input)
  const modelCall=Array.isArray(input.tools)&&input.tools.length>0
  if(overflow&&modelCall){res.statusCode=400;res.end(JSON.stringify({error:{message:'maximum context length is 65536 tokens, requested 80000 tokens',code:'context_length_exceeded',type:'invalid_request_error'}}));return}
  const content=modelCall?'压缩后继续完成。':summary
  if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-context-model',choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n')}
  else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-context-model',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}))
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 await writeFile(join(profile,'config.yaml'),JSON.stringify({model:{default:'fixture-context-model',provider:'custom',base_url:base+'/v1',api_key:'fixture-secret',context_length:65536,max_tokens:4096},compression:{enabled,in_place:inPlace,threshold:0.5,target_ratio:0.2,protect_first_n:0,protect_last_n:2,tail_mode:'legacy',max_attempts:1},terminal:{cwd:'.'}}))
 const script=join(home,'diagnostic-worker.py')
 await writeFile(script,(await readFile(resolve('src/runner/worker/hermes_worker.py'),'utf8')).replace('NONCE = BOOT["nonce"]','NONCE = BOOT["nonce"]\nBOOT["diagnostic"] = True'))
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:base,hermesURL:base,token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE??'sha256:'+'a'.repeat(64),python:process.env.YAOYAO_HERMES_PYTHON!,hermesSource:process.env.YAOYAO_HERMES_SOURCE!,hermesHome:profile,network:'none'}},home,script)
 await runtime.ready;runtime.retainDesktops=true
 const id=randomUUID(),meta={agentId:id,environmentId:id,ownerKey:'context-live-fixture'}
 if(!docker){
  vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id,containerId:id,running:true,workspace:home,isolation:'container'})
  vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
 }
 async function open(sessionId?:string){
  const gateway=new ComputerGateway(runtime,meta,randomUUID(),async()=>{},async()=>({}));gateways.push(gateway)
  await gateway.connect();const opened=await gateway.rpc(sessionId?'session.resume':'session.create',{profile:'default',...(sessionId?{session_id:sessionId}:{})})
  return {gateway,id:opened.session_id as string}
 }
 async function send(gateway:ComputerGateway,id:string,prompt:string){
  let diagnostics=''
  const completed=new Promise<any>((done,reject)=>{gateway.onEvent=frame=>{if(frame.type==='message.complete')done(frame.payload)};gateway.onDisconnect=()=>reject(new Error('unexpected Worker disconnection\n'+diagnostics))})
  await gateway.rpc('prompt.submit',{session_id:id,text:prompt})
  runtime.workers.get(gateway.workId)?.process.child.stderr.on('data',chunk=>{diagnostics+=String(chunk)})
  return completed
 }
 return {runtime,db,meta,requests,open,send,async close(){await Promise.all(gateways.map(g=>g.close()));await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks();await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections()});await rm(home,{recursive:true,force:true})}}
}

it.skipIf(!available).each([true,false])('inherits Profile compression and resumes compacted history with in_place=%s',async inPlace=>{
 const f=await fixture(true,false,false,inPlace)
 try{
  const seed=await f.open(),session=f.runtime.session(seed.id,f.meta,'default')
  session.history=Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',content:`HISTORY_PAYLOAD_${i}: `+'Long earlier fixture investigation with completed tool results. '.repeat(180)}))
  const initialSize=JSON.stringify(session.history).length;f.runtime.save(session)
  await seed.gateway.close();const first=await f.open(seed.id)
  const result=await f.send(first.gateway,first.id,'Continue the pending fixture task.')
  expect(result).toMatchObject({status:'complete',text:'压缩后继续完成。'})
  const history=f.runtime.session(first.id,f.meta,'default').history
  expect(JSON.stringify(history)).toContain('COMPACTED_WORKER_HISTORY')
  expect(JSON.stringify(history).length).toBeLessThan(initialSize/2)
  expect(f.requests.some(r=>!r.tools?.length)).toBe(true)
  await first.gateway.close()
  const next=await f.open(first.id);const again=await f.send(next.gateway,next.id,'Continue another step from the compacted history.')
  expect(again.status).toBe('complete')
  const last=f.requests.filter(r=>r.tools?.length).at(-1)!
  expect(JSON.stringify(last.messages)).toContain('COMPACTED_WORKER_HISTORY')
  expect(JSON.stringify(last.messages).length).toBeLessThan(initialSize/2)
  expect(last.tools.map((t:any)=>t.function.name)).toEqual(expect.arrayContaining(['computer_shell','computer_export']))
  expect(last.tools.map((t:any)=>t.function.name)).not.toContain('terminal')
 }finally{await f.close()}
},120000)

it.skipIf(!available||!process.env.YAOYAO_COMPUTER_IMAGE)('keeps a real Docker desktop running on a typed context error, then honors the idle policy',async()=>{
 const f=await fixture(false,true),manager=new LocalVmImages(f.runtime,f.db)
 try{
  await manager.ready;await manager.idlePolicy(0)
  const turn=await f.open(),spec=f.runtime.pool.definition(f.meta.ownerKey,f.meta.environmentId)!,before=await f.runtime.provider.inspect(spec)
  await f.runtime.provider.execute(spec,['/bin/sh','-c','printf context-proof > retained.txt'],{authorize:()=>{}})
  const result=await f.send(turn.gateway,turn.id,'Trigger the fixture context overflow.')
  expect(result).toMatchObject({status:'failed',code:'context_compaction_disabled',error:expect.stringContaining('虚拟机已进入空闲')})
  await turn.gateway.close();await f.runtime.pool.expire()
  expect(await f.runtime.provider.inspect(spec)).toMatchObject({running:true,containerId:before!.containerId})
  expect((await f.runtime.provider.execute(spec,['cat','retained.txt'],{authorize:()=>{}})).stdout).toBe('context-proof')
  await manager.idlePolicy(1)
  f.db.prepare("UPDATE computer_environments SET value=json_set(value,'$.updatedAt',?)").run(Date.now()-61000)
  await f.runtime.pool.expire();expect(await f.runtime.provider.inspect(spec)).toBeUndefined()
 }finally{await manager.close();await f.close()}
},120000)

it.skipIf(!available)('classifies exhausted automatic compression as a session error without retiring the desktop',async()=>{
 const f=await fixture(true,false,true)
 try{
  const turn=await f.open(),result=await f.send(turn.gateway,turn.id,'The fixture provider always rejects its context size.')
  expect(result).toMatchObject({status:'failed',code:'context_compaction_failed'})
  expect(f.runtime.pool.status(f.meta.ownerKey)[0]?.status).toBe('idle')
  expect(f.runtime.provider.stop).not.toHaveBeenCalled()
 }finally{await f.close()}
},120000)
