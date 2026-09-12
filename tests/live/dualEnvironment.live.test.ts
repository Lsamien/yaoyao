// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {ComputerRuntime,ComputerGateway} from '../../src/runner/worker/gateway'

it.skipIf(!process.env.YAOYAO_HERMES_PYTHON||!process.env.YAOYAO_COMPUTER_IMAGE)('uses host and VM tools in one real Worker turn and copies binary files in both directions',async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-dual-live-')),db=new DatabaseSync(':memory:'),proof=randomUUID()
 const source=join(home,'host-source.bin'),returned=join(home,'returned.bin'),bytes=Buffer.alloc(9*1024*1024,0xa5)
 await writeFile(source,bytes);await writeFile(join(home,'host-proof.txt'),proof)
 const requests:any[]=[],toolResults:any[]=[]
 const steps=[
  ['host_read_file',{path:'host-proof.txt'}],
  ['host_shell',{command:'uname -s; pwd'}],
  ['computer_copy_file',{from:'host',source:'host-source.bin',destination:'import.bin'}],
  ['computer_shell',{command:`uname -s; test ! -e '${source}'; wc -c < import.bin`}],
  ['computer_copy_file',{from:'vm',source:'import.bin',destination:'returned.bin'}],
 ] as const
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model',context_length:65536}]}));return}
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input)
  const results=input.messages.filter((m:any)=>m.role==='tool');toolResults.push(...results)
  const step=steps[results.length]
  const message=step?{role:'assistant',content:null,tool_calls:[{id:'dual-'+results.length,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:'双环境完成'}
  if(input.stream){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((t:any,index:number)=>({...t,index}))}:{})},finish_reason:step?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:step?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}))}
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:base,hermesURL:base,token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python:process.env.YAOYAO_HERMES_PYTHON!,hermesSource:process.env.YAOYAO_HERMES_SOURCE!,hermesHome:home,network:'none'}},home,resolve('src/runner/worker/hermes_worker.py'))
 const id=randomUUID(),gateway=new ComputerGateway(runtime,{agentId:id,environmentId:id,ownerKey:'dual-fixture',hostAccess:true},randomUUID(),async()=>{},async()=>({}))
 const completed=new Promise<any>((done,reject)=>{gateway.onEvent=frame=>{if(frame.type==='message.complete')frame.payload.status==='complete'?done(frame.payload):reject(new Error(JSON.stringify(frame)))};gateway.onDisconnect=()=>reject(new Error('Worker disconnected'))})
 try{
  await runtime.ready
  vi.spyOn(runtime,'resolve').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:home,model:{model:'fixture-model',provider:'custom',api_mode:'chat_completions',base_url:base+'/v1',api_key:'fixture'}})
  await gateway.connect();const session=await gateway.rpc('session.create',{profile:'default'})
  await gateway.rpc('prompt.submit',{session_id:session.session_id,text:'依次执行本机读取、本机命令、文件复制、虚拟机命令，并把结果复制回本机。'})
  expect((await completed).text).toBe('双环境完成')
  expect(await readFile(returned)).toEqual(bytes)
  expect(toolResults.some(m=>String(m.content).includes(proof))).toBe(true)
  expect(toolResults.some(m=>String(m.content).includes('Linux')&&String(m.content).includes(String(bytes.length)))).toBe(true)
  expect(toolResults.some(m=>String(m.content).includes(process.platform==='darwin'?'Darwin':'Linux')&&String(m.content).includes(home))).toBe(true)
  for(const req of requests){expect(req.tools.map((t:any)=>t.function.name)).toEqual(expect.arrayContaining(['host_shell','host_read_file','computer_shell','computer_copy_file']));expect(JSON.stringify(req.messages.filter((m:any)=>m.role==='system'))).toContain('separate files')}
 }finally{
  await gateway.close();await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks()
  await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections()});await rm(home,{recursive:true,force:true})
 }
},120000)
