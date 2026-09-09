// @vitest-environment node
import {it,expect} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import request from 'supertest'
const exec=promisify(execFile)
it.skipIf(!process.env.YAOYAO_PLATFORM_IMAGE||!process.env.YAOYAO_COMPUTER_IMAGE||!process.env.YAOYAO_HERMES_PYTHON)('executes an isolated task through the packaged Docker control plane and an external Runner',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-docker-platform-')),name=`yaoyao-platform-${randomUUID()}`,webHome=join(home,'web'),hermesHome=join(home,'hermes')
  await mkdir(webHome);await mkdir(hermesHome)
  const upstream=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify(req.url?.startsWith('/api/profiles')?{profiles:[{name:'default'}]}:req.url?.startsWith('/api/config')?{terminal:{cwd:'/workspace/docker-proof'}}:{ok:true}));return}
    let body='';for await(const chunk of req)body+=chunk
    const input=JSON.parse(body||'{}'),called=input.messages?.some((message:any)=>message.role==='tool'),exported=input.messages?.some((message:any)=>message.role==='tool'&&message.name==='computer_export')
    const message=exported?{role:'assistant',content:'Docker 控制面任务完成'}:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:called?'computer_export':'computer_shell',arguments:JSON.stringify(called?{path:'docker-proof.txt'}:{command:'printf docker-control-plane-proof > docker-proof.txt; id -u'})}}]}
    if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((tool,index)=>({...tool,index}))}:{})},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')}
    else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}))
  })
  await new Promise<void>(done=>upstream.listen(0,'0.0.0.0',done));const upstreamPort=(upstream.address() as {port:number}).port
  let child:ReturnType<typeof spawn>|undefined,exited:Promise<void>|undefined
  try{
    await exec('docker',['run','-d','--name',name,'--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:mode=1777','--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::15300','--mount',`type=volume,source=${name}-data,target=/var/lib/hermes-yaoyao`,'-e','HERMES_YAOYAO_ALLOW_INSECURE_LAN=1','-e','HERMES_YAOYAO_ALLOWED_HOSTS=localhost,127.0.0.1','-e',`HERMES_YAOYAO_UPSTREAM=http://host.docker.internal:${upstreamPort}`,process.env.YAOYAO_PLATFORM_IMAGE!])
    const detail=JSON.parse((await exec('docker',['inspect',name])).stdout)[0],port=detail.NetworkSettings.Ports['15300/tcp'][0].HostPort,address=`http://127.0.0.1:${port}`,client=request.agent(address)
    await expect.poll(async()=>{try{return (await client.get('/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
    expect(detail.Config.User).toBe('node');expect(detail.HostConfig.ReadonlyRootfs).toBe(true);expect(detail.HostConfig.CapDrop).toContain('ALL')
    expect((await exec('docker',['exec',name,'id','-u'])).stdout.trim()).toBe('1000')
    const bootstrap=await client.get('/api/app/bootstrap').expect(200)
    const setup=await client.post('/api/app/setup').set('Origin',address).set('X-CSRF-Token',bootstrap.body.csrfToken).send({username:'docker-fixture',password:'docker-fixture-password'}).expect(200)
    expect(setup.body.user.id).toBeTruthy()
    const fresh=await client.get('/api/app/bootstrap').expect(200)
    const post=(path:string,body:unknown)=>client.post(path).set('Origin',address).set('X-CSRF-Token',fresh.body.csrfToken).send(body)
    const registration=await post('/api/app/admin/runners',{name:'容器外执行节点',allowedProfiles:['default']}).expect(201)
    const runnerID=registration.body.runner.id
    await writeFile(join(hermesHome,'config.yaml'),`model:\n  provider: custom\n  default: fixture-model\n  base_url: http://127.0.0.1:${upstreamPort}/v1\n  api_key: fixture-key\n  api_mode: chat_completions\nterminal:\n  cwd: /workspace/docker-proof\n`,{mode:0o600})
    const config={protocol:1,serverURL:address,runnerId:runnerID,token:registration.body.token,hermesURL:`http://127.0.0.1:${upstreamPort}`,allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',network:'none',imageId:process.env.YAOYAO_COMPUTER_IMAGE,python:process.env.YAOYAO_HERMES_PYTHON,hermesSource:process.env.YAOYAO_HERMES_SOURCE,hermesHome}}
    const path=join(home,'runner.json');await writeFile(path,JSON.stringify(config),{mode:0o600})
    child=spawn(process.execPath,[resolve('.runner-build/runner.mjs'),'--config',path],{stdio:'ignore'})
    exited=new Promise(done=>child!.once('exit',()=>done()))
    await expect.poll(async()=>(await client.get('/api/app/admin/runners')).body.runners?.some((runner:any)=>runner.id===runnerID&&runner.online),{timeout:15000}).toBe(true)
    const created=await post('/api/app/agents',{name:'Docker 隔离成员',profile:'default',execution:'computer'}).expect(201)
    const agentID=created.body.agent.id,conversations=await client.get('/api/app/conversations').expect(200),conversation=conversations.body.conversations.find((item:any)=>item.memberIds.includes(agentID))
    const sent=await post(`/api/app/conversations/${conversation.id}/messages`,{requestId:randomUUID(),content:'执行当前隔离工具并导出结果。'}).expect(202)
    let result:any,message:any
    await expect.poll(async()=>{result=(await client.get(`/api/app/conversations/${conversation.id}`)).body;message=result.messages?.find((item:any)=>item.role==='assistant'&&item.runId===sent.body.run.id);return message?.status??'pending'},{timeout:45000}).toMatch(/complete|failed|uncertain/)
    expect(message.status,JSON.stringify(result)).toBe('complete')
    expect(message.runId).toBe(sent.body.run.id)
    const file=message.attachments?.[0]
    expect(file?.id).toBeTruthy()
    expect((await client.get(`/api/app/files/${file.id}/download`).expect(200)).text).toBe('docker-control-plane-proof')
    expect(await readFile(join(home,'state',runnerID,'computer-workspaces',agentID,'docker-proof.txt'),'utf8')).toBe('docker-control-plane-proof')
    const identity=await client.get('/api/status').expect(200);expect(identity.body.server_kind).toBe('yaoyao-web')
  }catch(error){const logs=await exec('docker',['logs','--tail','35',name]).catch(()=>({stdout:'',stderr:''}));console.error(logs.stdout,logs.stderr);throw error}finally{
    child?.kill('SIGTERM');await exited
    await exec('docker',['rm','-f',name]).catch(()=>{})
    await exec('docker',['volume','rm',name+'-data']).catch(()=>{})
    await new Promise<void>(done=>{upstream.close(()=>done());upstream.closeAllConnections()})
    await rm(home,{recursive:true,force:true})
  }
},100000)
