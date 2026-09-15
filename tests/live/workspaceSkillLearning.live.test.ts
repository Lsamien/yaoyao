// @vitest-environment node
import {it,expect} from 'vitest'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import {UploadStore} from '../../src/server/uploads'
import {UpstreamClient} from '../../src/server/upstream'
import {UpstreamServiceSession} from '../../src/server/localAuth'
import {ComputerRuntime,ComputerGateway} from '../../src/runner/worker/gateway'
import type {WorkspaceNodes,GatewayTarget} from '../../src/server/workspaceGateway'
import type {WorkspaceAgent} from '../../src/shared/workspace'

const available=['YAOYAO_HERMES_PYTHON','YAOYAO_HERMES_SOURCE','YAOYAO_COMPUTER_IMAGE'].every(key=>!!process.env[key])
it.skipIf(!available).each([false,true])('automatically saves a shared Profile skill after the Bot turn and another Bot reuses it (routed review: %s)',async(routed)=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-skill-learning-live-')),webHome=join(home,'web')
  const python=process.env.YAOYAO_HERMES_PYTHON!,source=process.env.YAOYAO_HERMES_SOURCE!
  const skillName='shared-fixture-skill',skillBody='---\nname: shared-fixture-skill\ndescription: Use when verifying a fixture command result.\n---\n# Shared fixture workflow\n\nRun the requested command, inspect the actual output, and report success only when it matches. SHARED_SKILL_PROOF\n'
  const protectedFiles={'SOUL.md':'PRIVATE_SOUL_NOT_FOR_SKILL_REVIEW','AGENTS.md':'PRIVATE_CONTEXT_NOT_FOR_SKILL_REVIEW','memories/MEMORY.md':'PRIVATE_MEMORY_NOT_FOR_SKILL_REVIEW','memories/USER.md':'PRIVATE_USER_NOT_FOR_SKILL_REVIEW'}
  await mkdir(join(home,'memories'));await mkdir(join(home,'plugins'))
  for(const [file,content] of Object.entries(protectedFiles))await writeFile(join(home,file),content)
  await writeFile(join(home,'.env'),'')
  await cp(resolve('integrations/hermes-bots-bridge'),join(home,'plugins','yaoyao-bot-bridge'),{recursive:true})
  let releaseReview!:()=>void,reviewCreated=false,reviewRead=false,reviewPatched=false,reviewRequests=0,reviewDone=false,reviewFailure=''
  const reviewRelease=new Promise<void>(done=>{releaseReview=done}),requests:any[]=[]
  const model=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'skill-fixture-model',context_length:64000}]}));return}
    let raw='';for await(const part of req)raw+=part
    const input=JSON.parse(raw);requests.push(input)
    const names=(input.tools??[]).map((t:any)=>t.function.name),messages=JSON.stringify(input.messages)
    const review=names.length>0&&names.every((name:string)=>['skills_list','skill_view','skill_manage'].includes(name))
    let tool:string|undefined,args:any,content='SKILL_WORK_DONE'
    if(review){
      reviewRequests++;await reviewRelease
      const result=input.messages.at(-1)
      if(result?.role==='tool'&&typeof result.content==='string'){try{const body=JSON.parse(result.content);if(body.error)reviewFailure=result.content}catch{}}
      if(!reviewCreated){reviewCreated=true;tool='skill_manage';args={operations:[{action:'create',name:skillName,content:routed?skillBody.replace('SHARED_SKILL_PROOF','SHARED_SKILL_OLD'):skillBody}]}}
      else if(routed&&!reviewRead){reviewRead=true;tool='skill_view';args={name:skillName}}
      else if(routed&&!reviewPatched){reviewPatched=true;tool='skill_manage';args={operations:[{action:'patch',name:skillName,old_string:'SHARED_SKILL_OLD',new_string:'SHARED_SKILL_PROOF'}]}}
      else {content='SKILL_REVIEW_FINISHED';reviewDone=true}
    }else if(messages.includes('复用同伴技能')){
      if(!input.messages.some((m:any)=>m.role==='tool'&&JSON.stringify(m.content).includes('SHARED_SKILL_PROOF'))){tool='skill_view';args={name:skillName}}
      else content='SECOND_BOT_REUSED_SKILL'
    }else if(!input.messages.some((m:any)=>m.role==='tool'&&JSON.stringify(m.content).includes('SKILL_LEARNING_COMMAND_OK'))){
      tool=names.find((name:string)=>name.startsWith('yaoyao_computer_shell_'));args={command:'printf SKILL_LEARNING_COMMAND_OK'}
    }
    const message=tool?{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content}
    const finish_reason=tool?'tool_calls':'stop'
    if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:input.model,choices:[{index:0,delta:message,finish_reason}]})+'\n\ndata: [DONE]\n\n')}
    else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:input.model,choices:[{index:0,message,finish_reason}],usage:{prompt_tokens:30,completion_tokens:8,total_tokens:38}}))
  })
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done))
  const modelURL=`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`
  const config={model:{provider:'custom',default:'skill-fixture-model',base_url:modelURL,api_key:'fixture',context_length:64000},terminal:{cwd:home},memory:{memory_enabled:true,user_profile_enabled:true},skills:{creation_nudge_interval:1,write_approval:false},auxiliary:{background_review:{enabled:true,...(routed?{provider:'custom',model:'review-fixture-model',base_url:modelURL,api_key:'fixture'}:{})}},plugins:{enabled:['yaoyao-bot-bridge']},tools:{tool_search:{enabled:'off'}},dashboard:{turn_isolation:false},compression:{enabled:false}}
  await writeFile(join(home,'config.yaml'),JSON.stringify(config))
  const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done))
  const port=(reservation.address() as {port:number}).port;await new Promise<void>(done=>reservation.close(()=>done()))
  const url=new URL(`http://127.0.0.1:${port}`);let logs=''
  const child=spawn(python,['-m','hermes_cli.main','serve','--host','127.0.0.1','--port',String(port),'--skip-build','--isolated'],{cwd:home,env:{PATH:process.env.PATH,HOME:process.env.HOME,HERMES_HOME:home,PYTHONPATH:source,HERMES_YOLO_MODE:'1',HERMES_DASHBOARD_SESSION_TOKEN:'fixture-skill-learning-local-token',NO_PROXY:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',c=>{logs=(logs+String(c)).slice(-12000)});child.stderr.on('data',c=>{logs=(logs+String(c)).slice(-12000)})
  const client=new UpstreamClient(url),session=new UpstreamServiceSession(client,()=>undefined),target={url,client,session}
  const store=new WorkspaceStore(webHome),uploads=new UploadStore(webHome),db=new DatabaseSync(':memory:')
  const computer=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:url.href,hermesURL:url.href,token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python:'/must-not-run',hermesSource:'/must-not-read',hermesHome:'/must-not-read',network:'none'}},webHome,resolve('src/runner/worker/hermes_worker.py'),undefined,target)
  const owner='fixture-owner',gateways:ComputerGateway[]=[]
  const forAgent=(agent:WorkspaceAgent):GatewayTarget=>{
    let current:ComputerGateway
    return {...target,runner:{id:'fixture-runner',computer:true,hermesComputer:true,
      open:async(onEvent,onDisconnect,scope)=>{
        current=new ComputerGateway(computer,{agentId:agent.id,environmentId:agent.id,ownerKey:owner,hermesRuntime:true},scope!.workId,async()=>scope!.authorize(),async()=>({}),target)
        gateways.push(current);current.onEvent=onEvent;current.onDisconnect=onDisconnect;await current.connect()
        const gateway=current;return {rpc:(method,params)=>gateway.rpc(method,params),close:()=>{void gateway.close()}}
      },
      lease:async(input)=>{const gateway=current;gateway.installTeamLease(input.workId,input.catalog(),async(name,args,id)=>input.call(name,args,id),input.workspaceMemory===true);return {bind:async()=>{},dispose:async()=>gateway.removeTeamLease(input.workId)}},
    }}
  }
  const nodes={requireSource(){},target:()=>target,targetForAgent:(_owner:string,agent:WorkspaceAgent)=>forAgent(agent)} as unknown as WorkspaceNodes
  const runtime=new WorkspaceRuntime(store,nodes,uploads)
  const send=async(agent:WorkspaceAgent,content:string)=>{
    const conversation=store.list<any>(owner,'conversation').find(c=>c.memberIds[0]===agent.id)!
    const run=runtime.send(owner,conversation.id,{requestId:randomUUID(),content})
    await expect.poll(()=>store.require<any>(owner,'run',run.id).status,{timeout:45000}).toMatch(/^(complete|failed|interrupted)$/)
    const saved=store.require<any>(owner,'run',run.id);expect(saved.status,saved.error+'\n'+logs).toBe('complete')
    return store.list<any>(owner,'message').find(m=>m.runId===run.id&&m.role==='assistant')?.content
  }
  try{
    await expect.poll(async()=>{if(child.exitCode!==null)throw new Error(logs);try{return(await fetch(new URL('/api/status',url))).status}catch{return 0}},{timeout:45000}).toBe(200)
    const first=store.createAgent(owner,{name:'skill-learner',profile:'default',execution:'computer',computer:'vm',vmExecution:'worker'})
    expect(await send(first,'执行演示命令并核对输出')).toBe('SKILL_WORK_DONE')
    // Learning must survive the foreground lease being revoked after delivery.
    releaseReview()
    await expect.poll(()=>reviewDone||!!reviewFailure,{timeout:45000,message:logs}).toBe(true)
    expect(reviewFailure).toBe('')
    expect(await readFile(join(home,'skills',skillName,'SKILL.md'),'utf8')).toContain('SHARED_SKILL_PROOF')
    const second=store.createAgent(owner,{name:'skill-consumer',profile:'default',execution:'computer',computer:'vm',vmExecution:'worker'})
    expect(await send(second,'复用同伴技能')).toBe('SECOND_BOT_REUSED_SKILL')
    expect(reviewRequests).toBeGreaterThan(0)
    const reviewCalls=requests.filter(r=>(r.tools??[]).length>0&&r.tools.every((t:any)=>['skills_list','skill_view','skill_manage'].includes(t.function.name)))
    expect(reviewCalls.length).toBeGreaterThan(0)
    if(routed)expect(reviewCalls.some(r=>r.model==='review-fixture-model')).toBe(true)
    const sent=JSON.stringify(requests)
    for(const [file,marker] of Object.entries(protectedFiles)){expect(sent).not.toContain(marker);expect(await readFile(join(home,file),'utf8')).toBe(marker)}
    const native=new DatabaseSync(join(home,'state.db'),{readOnly:true})
    try{expect((native.prepare("SELECT count(*) AS n FROM messages WHERE content LIKE '%SKILL_REVIEW_FINISHED%'").get() as {n:number}).n).toBe(0)}finally{native.close()}
    expect(JSON.parse(await readFile(join(home,'config.yaml'),'utf8')).memory).toEqual(config.memory)
  }finally{
    releaseReview();runtime.close();await Promise.all(gateways.map(g=>g.close().catch(()=>{})));await computer.controls.close();await computer.pool.close()
    db.close();uploads.close();store.close();client.close()
    child.kill('SIGTERM');await new Promise<void>(done=>{if(child.exitCode!==null){done();return}const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);done()})})
    await new Promise<void>(done=>{model.close(()=>done());model.closeAllConnections()});await rm(home,{recursive:true,force:true})
  }
},120000)
