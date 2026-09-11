// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {HermesWorkerProcess} from '../../src/runner/worker/process'

afterEach(()=>vi.unstubAllEnvs())
const enabled=!!process.env.YAOYAO_HERMES_PYTHON&&!!process.env.YAOYAO_HERMES_SOURCE
const listen=(server:Server)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port)))
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})

it.skipIf(!enabled).each(['uppercase','lowercase','no-proxy','unconfigured'] as const)('uses the actual Hermes loop with Profile proxy policy: %s',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-worker-proxy-live-')),hermesHome=join(root,'hermes'),workerHome=join(root,'worker')
 const profile=mode==='uppercase'?'default':'writer',profileHome=profile==='default'?hermesHome:join(hermesHome,'profiles',profile)
 await mkdir(profileHome,{recursive:true})
 const proxyRequests:Array<{url:string;auth?:string}>=[],directRequests:string[]=[],modelRequests:any[]=[]
 const reply=async(req:IncomingMessage,res:ServerResponse)=>{
  const url=new URL(req.url!,'http://fixture')
  if(req.method==='GET'&&url.pathname==='/v1/models'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model',object:'model',context_length:65536}]}));return
  }
  if(req.method!=='POST'||url.pathname!=='/v1/chat/completions'){res.statusCode=404;res.end('{}');return}
  let body='';for await(const chunk of req)body+=chunk
  const input=JSON.parse(body);modelRequests.push(input)
  if(req.headers.authorization!=='Bearer fixture-model-key'){res.statusCode=401;res.end('{}');return}
  const message={role:'assistant',content:'代理链路已完成完整回复。'}
  if(input.stream){
   res.setHeader('Content-Type','text/event-stream')
   res.end('data: '+JSON.stringify({id:'fixture-response',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:message,finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
  }else{
   res.setHeader('Content-Type','application/json')
   res.end(JSON.stringify({id:'fixture-response',object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}))
  }
 }
 // The HTTP proxy terminates a fixture-only origin. The .invalid name cannot
 // resolve directly, so a successful model response proves proxy traversal.
 const proxy=createServer((req,res)=>{
  proxyRequests.push({url:req.url!,auth:req.headers['proxy-authorization']})
  if(!req.url?.startsWith('http://worker-proxy.invalid/')){res.statusCode=502;res.end('{}');return}
  void reply(req,res).catch(()=>{res.statusCode=500;res.end('{}')})
 })
 const direct=createServer((req,res)=>{directRequests.push(req.url!);void reply(req,res).catch(()=>{res.statusCode=500;res.end('{}')})})
 const workers:HermesWorkerProcess[]=[]
 let diagnostics=''
 try{
  const [proxyPort,directPort]=await Promise.all([listen(proxy),listen(direct)])
  const proxyURL=`http://fixture-user:fixture-proxy-password@127.0.0.1:${proxyPort}`
  const proxied=mode==='uppercase'||mode==='lowercase'
  const baseURL=proxied?'http://worker-proxy.invalid/v1':`http://127.0.0.1:${directPort}/v1`
  // A Runner-level proxy must neither override a Profile nor become a fallback.
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])vi.stubEnv(key,proxyURL)
  for(const key of ['NO_PROXY','no_proxy'])vi.stubEnv(key,'')
  await writeFile(join(profileHome,'config.yaml'),`model:\n  provider: custom\n  default: fixture-model\n  base_url: ${baseURL}\n  api_key: \${WORKER_FIXTURE_KEY}\n  api_mode: chat_completions\nterminal:\n  cwd: /home/cua/workspace\n`,{mode:0o600})
  const proxyVars=mode==='uppercase'?`HTTP_PROXY=\${FIXTURE_PROXY_URL}\nHTTPS_PROXY=\${FIXTURE_PROXY_URL}\nNO_PROXY=\n`:mode==='lowercase'?`http_proxy=\${FIXTURE_PROXY_URL}\nhttps_proxy=\${FIXTURE_PROXY_URL}\nno_proxy=\n`:mode==='no-proxy'?`HTTP_PROXY=\${FIXTURE_PROXY_URL}\nHTTPS_PROXY=\${FIXTURE_PROXY_URL}\nNO_PROXY=127.0.0.1,localhost\n`:''
  await writeFile(join(profileHome,'.env'),`WORKER_FIXTURE_KEY=fixture-model-key\nFIXTURE_PROXY_URL=${proxyURL}\nUNRELATED_SECRET=fixture-unrelated-secret\n${proxyVars}`,{mode:0o600})
  const resolver=new HermesWorkerProcess(process.env.YAOYAO_HERMES_PYTHON!,resolve('src/runner/worker/hermes_worker.py'),{mode:'resolve',profile,hermesHome,hermesSource:process.env.YAOYAO_HERMES_SOURCE})
  workers.push(resolver)
  const resolved=await resolver.wait('resolved');await resolver.close()
  expect(resolved.proxyEnv??{}).not.toHaveProperty('UNRELATED_SECRET')
  expect(resolved.proxyEnv??{}).not.toHaveProperty('FIXTURE_PROXY_URL')
  if(mode==='unconfigured')expect(resolved).not.toHaveProperty('proxyEnv')
  const worker=new HermesWorkerProcess(process.env.YAOYAO_HERMES_PYTHON!,resolve('src/runner/worker/hermes_worker.py'),{diagnostic:true,mode:'run',home:workerHome,hermesSource:process.env.YAOYAO_HERMES_SOURCE,model:resolved.model,proxyEnv:resolved.proxyEnv,sessionId:randomUUID(),taskId:randomUUID(),cwd:resolved.cwd,tools:[],prompt:'返回测试回复。',history:[]},text=>{diagnostics+=text})
  workers.push(worker)
  const frames:unknown[]=[];worker.onEvent=frame=>frames.push(frame)
  const complete=await worker.wait('complete',45000).catch(error=>{throw new Error(`${String(error)}\n${diagnostics}`)})
  expect(complete).toMatchObject({text:'代理链路已完成完整回复。',completed:true})
  expect(modelRequests.length).toBeGreaterThan(0)
  if(proxied){
   expect(proxyRequests.some(request=>request.url==='http://worker-proxy.invalid/v1/chat/completions')).toBe(true)
   expect(proxyRequests.find(request=>request.url.endsWith('/chat/completions'))?.auth).toBe('Basic '+Buffer.from('fixture-user:fixture-proxy-password').toString('base64'))
   expect(directRequests).toEqual([])
  }else{
   expect(directRequests).toContain('/v1/chat/completions')
   expect(proxyRequests).toEqual([])
  }
  expect(JSON.stringify(frames)+diagnostics).not.toMatch(/fixture-proxy-password|fixture-unrelated-secret|proxyEnv/)
 }finally{
  await Promise.all(workers.map(worker=>worker.close()))
  await Promise.all([close(proxy),close(direct)])
  await rm(root,{recursive:true,force:true})
 }
},60000)
