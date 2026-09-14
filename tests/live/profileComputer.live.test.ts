// @vitest-environment node
import {expect,it} from 'vitest'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,mkdir,cp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'
import {UpstreamClient} from '../../src/server/upstream'
import {UpstreamServiceSession} from '../../src/server/localAuth'

const available=['YAOYAO_HERMES_PYTHON','YAOYAO_HERMES_SOURCE','YAOYAO_PROFILE_BRIDGE','YAOYAO_COMPUTER_IMAGE'].every(name=>!!process.env[name])
it.skipIf(!available)('runs a real Hermes Profile with native tools and a real Docker VM through the cloud-style bridge',async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-profile-live-')),workspace=join(home,'workspace'),db=new DatabaseSync(':memory:')
 await mkdir(workspace);await mkdir(join(home,'plugins'))
 await cp(process.env.YAOYAO_PROFILE_BRIDGE!,join(home,'plugins','yaoyao-bot-bridge'),{recursive:true})
 await writeFile(join(workspace,'AGENTS.md'),'PROFILE_CONTEXT_MARKER: use only the fixture files and the assigned test virtual machine.\n')
 const requests:any[]=[],results:any[]=[]
 let step=0
 const model=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part
  res.setHeader('Content-Type','application/json')
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture-profile-model',context_length:65536}]}));return}
  const input=JSON.parse(body);requests.push(input)
  const tools=input.tools??[];let tool:string|undefined,args:any
  if(tools.length){
   results.push(...input.messages.filter((m:any)=>m.role==='tool'))
   const operation=[['terminal',{command:'printf native-profile-proof',timeout:10}],['yaoyao_computer_shell_',{command:'printf vm-profile-proof > proof.txt; uname -s'}],['yaoyao_computer_read_file_',{path:'proof.txt'}]][step]
   if(operation){tool=tools.find((t:any)=>t.function.name===operation[0]||t.function.name.startsWith(operation[0]))?.function.name;args=operation[1];if(tool)step++}
  }
  const message=tool?{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:tools.length?'本机与虚拟机协作完成':'fixture'}
  if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-profile-model',choices:[{index:0,delta:message,finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')}
  else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-profile-model',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}))
 })
 await new Promise<void>(done=>model.listen(0,'127.0.0.1',done))
 const modelURL=`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`
 await writeFile(join(home,'config.yaml'),JSON.stringify({model:{default:'fixture-profile-model',provider:'custom',base_url:modelURL,api_key:'fixture',context_length:65536,max_tokens:4096},terminal:{cwd:workspace},plugins:{enabled:['yaoyao-bot-bridge']},toolsets:['all'],tools:{tool_search:{enabled:'off'}},dashboard:{turn_isolation:false},compression:{enabled:false},memory:{memory_enabled:false,user_profile_enabled:false}}))
 const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done))
 const port=(reservation.address() as {port:number}).port;await new Promise<void>(done=>reservation.close(()=>done()))
 const url=new URL(`http://127.0.0.1:${port}`),source=process.env.YAOYAO_HERMES_SOURCE!,python=process.env.YAOYAO_HERMES_PYTHON!
 let logs=''
 const child=spawn(python,['-m','hermes_cli.main','serve','--host','127.0.0.1','--port',String(port),'--skip-build','--isolated'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',HERMES_HOME:home,PYTHONPATH:source,HERMES_DASHBOARD_SESSION_TOKEN:'fixture-local-profile-token-123456789',HERMES_YOLO_MODE:'1',NO_PROXY:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',c=>{logs=(logs+String(c)).slice(-16000)});child.stderr.on('data',c=>{logs=(logs+String(c)).slice(-16000)})
 const client=new UpstreamClient(url),target={url,client,session:new UpstreamServiceSession(client,()=>undefined)}
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:url.href,hermesURL:url.href,token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python,hermesSource:source,hermesHome:home,network:'none'}},home,resolve('src/runner/worker/hermes_worker.py'))
 const id=randomUUID(),gateway=new ComputerGateway(runtime,{environmentId:id,agentId:id,ownerKey:'profile-live-fixture',hostAccess:true,profileSession:true},randomUUID(),async()=>{},async()=>({}),target)
 try{
  await expect.poll(async()=>{if(child.exitCode!==null)throw new Error(logs);try{return(await fetch(new URL('/api/status',url))).status}catch{return 0}},{timeout:45000}).toBe(200)
  const complete=new Promise<any>((done,reject)=>{gateway.onEvent=frame=>{if(frame.type==='message.complete')done(frame.payload)};gateway.onDisconnect=()=>reject(new Error('Profile disconnected\n'+logs))})
  void complete.catch(()=>{})
  await gateway.connect();const opened=await gateway.rpc('session.create',{profile:'default'})
  await gateway.rpc('prompt.submit',{session_id:opened.session_id,text:'依次执行本机终端、虚拟机命令、读取虚拟机文件，然后报告完成。'})
  const result=await complete
  expect(result.text,logs).toBe('本机与虚拟机协作完成');expect(step,JSON.stringify(requests.map(r=>r.tools?.map((t:any)=>t.function.name)))).toBe(3)
  expect(JSON.stringify(results)).toContain('native-profile-proof');expect(JSON.stringify(results)).toContain('vm-profile-proof');expect(JSON.stringify(results)).toContain('Linux')
  expect(JSON.stringify(requests.filter(r=>r.tools?.length).map(r=>r.messages))).toContain('PROFILE_CONTEXT_MARKER')
  expect(runtime.workers.size).toBe(0)
 }finally{
  await gateway.close().catch(()=>{});await runtime.controls.close();await runtime.pool.close();db.close();client.close()
  child.kill('SIGTERM');await new Promise<void>(done=>{if(child.exitCode!==null){done();return}const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);done()})})
  await new Promise<void>(done=>{model.close(()=>done());model.closeAllConnections()});await rm(home,{recursive:true,force:true})
 }
},120000)
