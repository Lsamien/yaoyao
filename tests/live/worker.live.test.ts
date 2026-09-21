// @vitest-environment node
import {expect,it} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {HermesWorkerProcess} from '../../src/runner/worker/process'

it.skipIf(!process.env.YAOYAO_HERMES_PYTHON)('uses the actual Hermes model loop with only the closed parent tool catalog',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-worker-live-'))
  const requests:any[]=[],calls:any[]=[]
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'fixture-model',object:'model',context_length:65536}]}));return}
    const input=JSON.parse(body||'{}');if(!Array.isArray(input.messages)){res.statusCode=404;res.end('{}');return}requests.push(input)
    const called=input.messages.some((message:any)=>message.role==='tool')
    const message=called?{role:'assistant',content:'隔离 Worker 已完成。'}:{role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'computer_shell',arguments:JSON.stringify({command:'printf fixture'})}},{id:'forbidden-native',type:'function',function:{name:'terminal',arguments:JSON.stringify({command:`printf escaped > ${home}/host-escape.txt`})}}]}
    if(input.stream){
      res.setHeader('Content-Type','text/event-stream')
      res.end('data: '+JSON.stringify({id:'fixture-response',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((tool:any,index:number)=>({...tool,index}))}:{})},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')
    }else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture-response',object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  let worker:HermesWorkerProcess|undefined,diagnostics=''
  try{
    worker=new HermesWorkerProcess(process.env.YAOYAO_HERMES_PYTHON!,resolve('src/runner/worker/hermes_worker.py'),{diagnostic:true,mode:'run',home,hermesSource:process.env.YAOYAO_HERMES_SOURCE,model:{provider:'custom',api_mode:'chat_completions',base_url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,api_key:'fixture-private-key',model:'fixture-model'},sessionId:randomUUID(),taskId:randomUUID(),cwd:'/workspace',tools:[{name:'computer_shell',description:'fixture shell',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}}],prompt:'执行当前测试工具后总结。',history:[]},text=>{diagnostics+=text})
    worker.onTool=async(name,args)=>{calls.push({name,args});return {stdout:'fixture',exitCode:0}}
    const complete=await worker.wait('complete',45000).catch(error=>{throw new Error(`${String(error)}\n${diagnostics}`)})
    expect(complete.text).toBe('隔离 Worker 已完成。')
    expect(calls,JSON.stringify(requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool')))+'\n'+diagnostics).toEqual([{name:'computer_shell',args:{command:'printf fixture'}}])
    await expect(access(join(home,'host-escape.txt'))).rejects.toMatchObject({code:'ENOENT'})
    expect(requests.flatMap(input=>input.messages).find((message:any)=>message.tool_call_id==='forbidden-native')?.content).toMatch(/not authorized|does not exist/)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    for(const request of requests)expect(request.tools.map((tool:any)=>tool.function.name)).toEqual(['computer_shell'])
  }finally{await worker?.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()});await rm(home,{recursive:true,force:true})}
},60000)

it.skipIf(!process.env.YAOYAO_HERMES_PYTHON||!process.env.YAOYAO_COMPUTER_IMAGE)('runs Bot tasks and team creation through a real Hermes worker and a real isolated computer',async()=>{
  const {writeFile,mkdir,readFile}=await import('node:fs/promises')
  const {createApplication}=await import('../../src/server/app')
  const {loadServerConfig}=await import('../../src/server/config')
  const {RunnerAgent}=await import('../../src/runner/agent')
  const request=(await import('supertest')).default
  const home=await mkdtemp(join(tmpdir(),'yaoyao-worker-platform-'))
  const hermesHome=join(home,'hermes'),webHome=join(home,'web')
  let runnerHome=join(home,'runner')
  await Promise.all([hermesHome,runnerHome,webHome].map(path=>mkdir(path,{recursive:true})))
  const commands:any[]=[]
  let configuredCwd='/projects/worker-fixture'
  const upstream=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    const path=new URL(req.url!,'http://fixture').pathname
    res.setHeader('Content-Type','application/json')
    if(path==='/api/config'){res.end(JSON.stringify({terminal:{cwd:configuredCwd}}));return}
    if(path==='/api/profiles'){res.end(JSON.stringify({profiles:[{name:'default'}]}));return}
    if(req.method==='GET'){res.end(JSON.stringify(path.startsWith('/v1')?{data:[{id:'fixture-model',context_length:65536}]}:{ok:true}));return}
    const input=JSON.parse(body||'{}')
    if(!input.messages){res.statusCode=404;res.end('{}');return}
    if(req.headers.authorization!=='Bearer fixture-private-key'){res.statusCode=401;res.end('{}');return}
    commands.push(input)
    const user=input.messages.filter((message:any)=>message.role==='user').at(-1)?.content??''
    const helper=/fixture:helper ([0-9a-f-]{36})/.exec(String(user)),team=String(user).includes('fixture:team'),slow=String(user).includes('fixture:slow'),control=String(user).includes('fixture:control')
    const current=input.messages.slice(input.messages.findLastIndex((message:any)=>message.role==='user')+1)
    const called=current.some((message:any)=>message.role==='tool')
    const exported=current.some((message:any)=>message.role==='tool'&&message.name==='computer_export')
    const message=called&&!team&&!helper&&!exported?{role:'assistant',content:null,tool_calls:['result.txt','bulk.bin'].map(path=>({id:randomUUID(),type:'function',function:{name:'computer_export',arguments:JSON.stringify({path})}}))}:called?{role:'assistant',content:'隔离任务完成'}:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:helper?'workspace_create_helper':team?'workspace_create_agent':'computer_shell',arguments:JSON.stringify(helper?{requestId:randomUUID(),goalId:helper[1],name:'临时核验助手',title:'临时核验',brief:'在隔离电脑完成 fixture:helper-work 并导出结果'}:team?{requestId:randomUUID(),name:'隔离创建成员',profile:'default'}:{command:String(user).includes('fixture:shared-write')?'sleep 6; printf shared-proof > result.txt; head -c 10 /dev/zero > bulk.bin':String(user).includes('fixture:shared-read')?'cat result.txt':control?'sleep 2; printf paused > pause-proof.txt':slow?'sleep 30; printf forbidden > late-write.txt':(process.env.YAOYAO_WORKER_PUBLIC_NETWORK==='1'?'curl --fail --silent --show-error --max-time 20 https://example.com > public.html; ':'')+'printf worker-proof > result.txt; head -c 2100000 /dev/zero > bulk.bin; id -u; pwd'})}}]}
    if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((tool:any,index:number)=>({...tool,index}))}:{})},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')}
    else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const upstreamURL=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`
  await writeFile(join(hermesHome,'config.yaml'),`model:\n  provider: custom\n  default: fixture-model\n  base_url: ${upstreamURL}/v1\n  api_key: \${WORKER_FIXTURE_KEY}\n  api_mode: chat_completions\nterminal:\n  cwd: /projects/worker-fixture\n`,{mode:0o600})
  await writeFile(join(hermesHome,'.env'),'WORKER_FIXTURE_KEY=fixture-private-key\n',{mode:0o600})
  const app=createApplication({config:loadServerConfig({HERMES_YAOYAO_HOME:webHome,HERMES_YAOYAO_UPSTREAM:upstreamURL})})
  const server=createServer(app.app.callback());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));app.config.port=(server.address() as {port:number}).port
  const address=`http://127.0.0.1:${app.config.port}`,abort=new AbortController();let running:Promise<void>|undefined
  try{
    const bootstrap=await request(address).get('/api/app/bootstrap').set('Host',`127.0.0.1:${app.config.port}`).expect(200)
    const setup=await request(address).post('/api/app/setup').set('Host',`127.0.0.1:${app.config.port}`).set('Origin',address).set('Cookie',bootstrap.headers['set-cookie'].map((cookie:string)=>cookie.split(';')[0]).join('; ')).set('X-CSRF-Token',bootstrap.body.csrfToken).send({username:'worker-fixture',password:'worker-fixture-password'}).expect(200)
    const owner=setup.body.user.id,registered=app.runners.enroll(owner,{name:'Worker 验收节点',allowedProfiles:['default']})
    const runnerConfig={protocol:1,serverURL:address,runnerId:registered.runner.id,token:registered.token,hermesURL:upstreamURL,allowedProfiles:['default'],artifactRoots:[],computers:{network:process.env.YAOYAO_WORKER_PUBLIC_NETWORK==='1'?'public-proxy':'none',runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python:process.env.YAOYAO_HERMES_PYTHON!,hermesSource:process.env.YAOYAO_HERMES_SOURCE!,hermesHome}}
    if(process.env.YAOYAO_WORKER_RUNNER_BUNDLE){
      const {spawn}=await import('node:child_process')
      const path=join(home,'runner-config.json');await writeFile(path,JSON.stringify(runnerConfig),{mode:0o600})
      runnerHome=join(home,'state',registered.runner.id)
      const child=spawn(process.execPath,[process.env.YAOYAO_WORKER_RUNNER_BUNDLE,'--config',path],{stdio:'ignore'})
      const stop=()=>{child.kill('SIGTERM')};abort.signal.addEventListener('abort',stop,{once:true})
      running=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{abort.signal.removeEventListener('abort',stop);code===0?resolve():reject(new Error(`Runner bundle exited ${code}`))})})
    }else{const runner=new RunnerAgent(runnerConfig as any,runnerHome);running=runner.run(abort.signal)}
    void running.catch(()=>{})
    await expect.poll(()=>app.runners.summary(app.runners.records()[0]!).online).toBe(true)
    const vmCookies=setup.headers['set-cookie'].map((cookie:string)=>cookie.split(';')[0]).join('; ')
    const vmBootstrap=await request(address).get('/api/app/bootstrap').set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',vmCookies).expect(200)
    const vmGet=async()=>(await request(address).get('/api/app/admin/local-vm').set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',vmCookies).expect(200)).body
    const prepareId=randomUUID()
    await request(address).post('/api/app/admin/local-vm/prepare').set('Host',`127.0.0.1:${app.config.port}`).set('Origin',address).set('Cookie',vmCookies).set('X-CSRF-Token',vmBootstrap.body.csrfToken).send({requestId:prepareId}).expect(200)
    await expect.poll(async()=>(await vmGet()).job?.state,{timeout:90000}).toBe('complete')
    expect((await vmGet()).image).toBe(true)


    const worker=app.workspace.createAgent(owner,{name:'隔离执行成员',profile:'default',execution:'computer'})
    const direct=app.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===worker.id)!
    const run=app.workspaceRuntime.send(owner,direct.id,{requestId:randomUUID(),content:'在电脑里执行 fixture:shell 并汇报。'})
    await expect.poll(()=>app.workspace.require<any>(owner,'run',run.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',run.id).status,JSON.stringify(app.workspace.messages(owner,direct.id))).toBe('complete')
    expect(await readFile(join(runnerHome,'computer-workspaces',worker.id,'result.txt'),'utf8')).toBe('worker-proof')
    if(process.env.YAOYAO_WORKER_PUBLIC_NETWORK==='1')expect(await readFile(join(runnerHome,'computer-workspaces',worker.id,'public.html'),'utf8')).toContain('Example Domain')
    const message=app.workspace.messages(owner,direct.id).find(message=>message.role==='assistant')!
    expect(message.attachments).toHaveLength(2)
    const report=message.attachments.find(file=>file.name==='result.txt')!
    expect(report).toBeDefined()
    const download=await request(address).get(`/api/app/files/${report.id}/download`).set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',setup.headers['set-cookie'].map((cookie:string)=>cookie.split(';')[0]).join('; ')).expect(200)
    expect(download.text).toBe('worker-proof')
    const files=app.workspace.list<any>(owner,'file');expect(await readFile(files.find(file=>file.name==='result.txt').path,'utf8')).toBe('worker-proof')
    const bulk=files.find(file=>file.name==='bulk.bin');expect((await readFile(bulk.path)).length).toBe(2100000)
    const toolMessages=commands.flatMap(input=>input.messages.filter((message:any)=>message.role==='tool'))
    expect(JSON.parse(toolMessages[0].content).stdout).toBe('1000\n/projects/worker-fixture\n')
    configuredCwd='/projects/changed-fixture'
    const configuration=await readFile(join(hermesHome,'config.yaml'),'utf8');await writeFile(join(hermesHome,'config.yaml'),configuration.replace('/projects/worker-fixture',configuredCwd))
    const next=app.workspaceRuntime.send(owner,direct.id,{requestId:randomUUID(),content:'再次执行并使用新的工作目录。'})
    await expect.poll(()=>app.workspace.require<any>(owner,'run',next.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',next.id).status).toBe('complete')
    expect(commands.flatMap(input=>input.messages).some((message:any)=>message.role==='tool'&&String(message.content).includes('/projects/changed-fixture'))).toBe(true)
    const controlled=app.workspaceRuntime.send(owner,direct.id,{requestId:randomUUID(),content:'fixture:control'})
    await expect.poll(()=>app.workspace.messages(owner,direct.id).some(message=>message.runId===controlled.id&&message.tools.some(tool=>tool.name==='computer_shell')),{timeout:30000}).toBe(true)
    const cookies=setup.headers['set-cookie'].map((cookie:string)=>cookie.split(';')[0]).join('; ')
    const fresh=await request(address).get('/api/app/bootstrap').set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',cookies).expect(200)
    const endpoint=`/api/app/agents/${worker.id}/computer`
    const api=(path:string,data:unknown)=>request(address).post(endpoint+path).set('Host',`127.0.0.1:${app.config.port}`).set('Origin',address).set('Cookie',cookies).set('X-CSRF-Token',fresh.body.csrfToken).send(data)
    const taken=await api('/take',{requestId:randomUUID()}).expect(200),ticket={controlId:taken.body.controlId,token:taken.body.token}
    const status=async()=>(await request(address).get(endpoint).set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',cookies)).body
    await expect.poll(async()=>(await status()).mode,{timeout:30000}).toBe('human')
    expect(app.workspace.require<any>(owner,'run',controlled.id).status).toBe('waiting')
    const capture=async()=>(await request(address).get(endpoint+'/frame').set('Host',`127.0.0.1:${app.config.port}`).set('Cookie',cookies)).body
    let frame:any
    await expect.poll(async()=>{frame=await capture();return frame.width},{timeout:20000}).toBeGreaterThan(0)
    const click=await api('/input',{...ticket,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'click',x:568,y:875}}).expect(200)
    expect(click.body.ok).toBe(true)
    await new Promise(resolve=>setTimeout(resolve,1200));frame=await capture()
    await mkdir('test-results/control',{recursive:true});await writeFile('test-results/control/after-click.png',Buffer.from(frame.data,'base64'))
    const typed=await api('/input',{...ticket,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'text',text:'printf control-proof > /projects/changed-fixture/manual.txt'}}).expect(200)
    await api('/input',{...ticket,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'key',key:'Return'}}).expect(200)
    frame=await capture();await writeFile('test-results/control/after-text.png',Buffer.from(frame.data,'base64'))
    await expect.poll(async()=>readFile(join(runnerHome,'computer-workspaces',worker.id,'manual.txt'),'utf8').catch(()=>''),{timeout:10000}).toBe('control-proof')
    await api('/input',{...ticket,token:'x'.repeat(40),requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'key',key:'Return'}}).expect(403)
    await api('/giveback',{...ticket,notes:'用户已在终端完成验证，请继续并核对结果。'}).expect(200)
    await expect.poll(()=>app.workspace.require<any>(owner,'run',controlled.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',controlled.id).status).toBe('complete')
    const cancelling=app.workspaceRuntime.send(owner,direct.id,{requestId:randomUUID(),content:'fixture:slow'})
    await expect.poll(()=>app.workspace.messages(owner,direct.id).some(message=>message.runId===cancelling.id&&message.tools.some(tool=>tool.name==='computer_shell')),{timeout:30000}).toBe(true)
    await app.workspaceRuntime.stop(owner,cancelling.id)
    await expect.poll(()=>app.workspace.require<any>(owner,'run',cancelling.id).status,{timeout:20000}).toBe('interrupted')
    await expect(access(join(runnerHome,'computer-workspaces',worker.id,'late-write.txt'))).rejects.toMatchObject({code:'ENOENT'})
    const second=app.workspace.createAgent(owner,{name:'共享核验成员',profile:'default',execution:'computer'})
    const secondChat=app.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===second.id)!
    const sharedAPI=(method:'post'|'delete',path:string,data:unknown)=>request(address)[method](path).set('Host',`127.0.0.1:${app.config.port}`).set('Origin',address).set('Cookie',cookies).set('X-CSRF-Token',fresh.body.csrfToken).send(data)
    const shared=await sharedAPI('post','/api/app/computers/shared',{requestId:randomUUID(),name:'真实共享电脑',memberIds:[worker.id,second.id],trusted:true}).expect(201)
    const sharedWrite=app.workspaceRuntime.send(owner,direct.id,{requestId:randomUUID(),content:'fixture:shared-write'})
    await expect.poll(()=>app.workspace.messages(owner,direct.id).some(message=>message.runId===sharedWrite.id&&message.tools.some(tool=>tool.name==='computer_shell')),{timeout:30000}).toBe(true)
    const sharedRead=app.workspaceRuntime.send(owner,secondChat.id,{requestId:randomUUID(),content:'fixture:shared-read'})
    await expect.poll(()=>app.workspace.require<any>(owner,'run',sharedRead.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',sharedWrite.id).status).toBe('complete')
    expect(app.workspace.require<any>(owner,'run',sharedRead.id).status,JSON.stringify(app.workspace.messages(owner,secondChat.id))).toBe('complete')
    expect(await readFile(join(runnerHome,'computer-workspaces',shared.body.computer.id,'result.txt'),'utf8')).toBe('shared-proof')
    expect(await readFile(join(runnerHome,'computer-workspaces',worker.id,'result.txt'),'utf8')).toBe('worker-proof')
    const sharedReaderRequests=commands.filter(input=>String(input.messages.filter((message:any)=>message.role==='user').at(-1)?.content).includes('fixture:shared-read'))
    expect(sharedReaderRequests.length).toBeGreaterThan(0)
    expect(sharedReaderRequests.some(input=>input.messages.some((message:any)=>message.role==='user'&&String(message.content).includes('fixture:shared-write')))).toBe(false)
    expect(sharedReaderRequests.some(input=>input.messages.some((message:any)=>message.role==='tool'&&String(message.content).includes('shared-proof')))).toBe(true)
    const sharedTake=await api('/take',{requestId:randomUUID()}).expect(200)
    await sharedAPI('post',`/api/app/agents/${second.id}/computer/take`,{requestId:randomUUID()}).expect(409)
    await sharedAPI('delete',`/api/app/computers/shared/${shared.body.computer.id}`,{}).expect(409)
    await api('/giveback',{controlId:sharedTake.body.controlId,token:sharedTake.body.token,notes:''}).expect(200)
    await sharedAPI('delete',`/api/app/computers/shared/${shared.body.computer.id}`,{}).expect(200)
    expect(app.workspace.require<any>(owner,'agent',worker.id).computerEnvironmentId).toBeUndefined()
    await sharedAPI('post',`/api/app/admin/local-vm/instances/${shared.body.computer.id}/stop`,{requestId:randomUUID()}).expect(200)
    const manager=app.workspace.createAgent(owner,{name:'隔离组队者',profile:'default',execution:'computer',canManageTeam:true})
    const managerChat=app.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===manager.id)!
    const managed=app.workspaceRuntime.send(owner,managerChat.id,{requestId:randomUUID(),content:'fixture:team'})
    await expect.poll(()=>app.workspace.require<any>(owner,'run',managed.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',managed.id).status,JSON.stringify(app.workspace.messages(owner,managerChat.id))).toBe('complete')
    expect(app.workspace.list<any>(owner,'agent').find(agent=>agent.name==='隔离创建成员')).toMatchObject({execution:'computer',canManageTeam:true,createdByAgentId:manager.id})
    const group=app.workspace.createGroup(owner,{name:'临时助手验收团队',memberIds:[manager.id,worker.id],administratorId:manager.id})
    const task=app.workspace.tasks(owner,group.id)[0]!
    const goal=app.workspaceRuntime.tasks.begin(owner,task,manager,'临时助手必须完成隔离工作并回传文件',{conversationId:managerChat.id,runId:managed.id,agentId:manager.id})
    const helperRun=app.workspaceRuntime.send(owner,managerChat.id,{requestId:randomUUID(),content:`fixture:helper ${goal.id}`})
    await expect.poll(()=>app.workspace.require<any>(owner,'run',helperRun.id).status,{timeout:45000}).toMatch(/complete|failed/)
    expect(app.workspace.require<any>(owner,'run',helperRun.id).status).toBe('complete')
    const temporary=app.workspace.list<any>(owner,'agent').find(agent=>agent.temporaryGoalId===goal.id)!
    expect(temporary).toMatchObject({execution:'computer',canManageTeam:false,helperRunnerId:registered.runner.id})
    expect(app.workspace.list<any>(owner,'conversation').some(conversation=>conversation.kind==='direct'&&conversation.memberIds.includes(temporary.id))).toBe(false)
    await expect.poll(()=>app.workspaceRuntime.tasks.assignments(owner,goal.id)[0]?.status,{timeout:45000}).toMatch(/review|failed|blocked/)
    const assignment=app.workspaceRuntime.tasks.assignments(owner,goal.id)[0]!
    expect(assignment.status,assignment.result).toBe('review')
    expect(assignment.artifactIds.length).toBeGreaterThan(0)
    app.workspaceRuntime.tasks.reviewAssignment(owner,manager.id,{requestId:randomUUID(),assignmentId:assignment.id,decision:'accept',review:'已核对隔离执行和真实产物'})
    app.workspaceRuntime.tasks.finish(owner,manager.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'临时助手执行与产物均已核验',checks:[{criterion:0,passed:true,evidence:'隔离执行返回了真实文件，文件已保存到当前任务'}]})
    await expect.poll(()=>app.workspace.require<any>(owner,'agent',temporary.id).cleanupState,{timeout:45000}).toBe('complete')
    expect(app.workspace.require<any>(owner,'agent',temporary.id).archived).toBe(true)
    await expect(access(join(runnerHome,'computer-workspaces',temporary.id))).rejects.toMatchObject({code:'ENOENT'})
    expect(app.workspace.list<any>(owner,'file').filter(file=>assignment.artifactIds.includes(file.id)).length).toBe(assignment.artifactIds.length)

  }finally{abort.abort();await running?.catch(()=>{});app.close();await Promise.all([server,upstream].map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})));await rm(home,{recursive:true,force:true})}
},420000)
