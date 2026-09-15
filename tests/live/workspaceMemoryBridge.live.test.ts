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

const available=['YAOYAO_HERMES_PYTHON','YAOYAO_HERMES_SOURCE','YAOYAO_COMPUTER_IMAGE'].every(key=>!!process.env[key])
it.skipIf(!available)('runs the production WorkspaceRuntime create, bind, prompt and resume chain with isolated memory and context files on real Hermes',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-memory-bridge-live-')),webHome=join(home,'web'),python=process.env.YAOYAO_HERMES_PYTHON!,source=process.env.YAOYAO_HERMES_SOURCE!
  const profileMemory='PROFILE_PRIVATE_MEMORY_MUST_NOT_REACH_BOT',botMemory='BOT_SCOPED_MEMORY_MUST_REACH_MODEL'
  await mkdir(join(home,'memories'));await mkdir(join(home,'plugins'))
  await writeFile(join(home,'memories','MEMORY.md'),profileMemory)
  await writeFile(join(home,'memories','USER.md'),'PROFILE_PRIVATE_USER_MUST_NOT_REACH_BOT')
  const contextFiles={'SOUL.md':'PROFILE_SOUL_MUST_NOT_REACH_BOT','AGENTS.md':'HOST_AGENTS_MUST_NOT_REACH_BOT','CLAUDE.md':'HOST_CLAUDE_MUST_NOT_REACH_BOT','.cursorrules':'HOST_CURSOR_RULES_MUST_NOT_REACH_BOT'}
  for(const [file,marker] of Object.entries(contextFiles))await writeFile(join(home,file),marker)
  await writeFile(join(home,'.env'),'')
  await cp(resolve('integrations/hermes-bots-bridge'),join(home,'plugins','yaoyao-bot-bridge'),{recursive:true})
  const modelCalls:any[]=[]
  const model=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'memory-fixture-model',context_length:64000}]}));return}
    let raw='';for await(const chunk of req)raw+=chunk
    const input=JSON.parse(raw);modelCalls.push(input)
    const message={role:'assistant',content:'BOT_MEMORY_BRIDGE_OK'}
    if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'memory-fixture-model',choices:[{index:0,delta:message,finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')}
    else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'memory-fixture-model',choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}))
  })
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done))
  const modelURL=`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`
  const config={model:{provider:'custom',default:'memory-fixture-model',base_url:modelURL,api_key:'fixture',context_length:64000},terminal:{cwd:home},memory:{memory_enabled:true,user_profile_enabled:true},plugins:{enabled:['yaoyao-bot-bridge']},tools:{tool_search:{enabled:'off'}},dashboard:{turn_isolation:false},compression:{enabled:false}}
  await writeFile(join(home,'config.yaml'),JSON.stringify(config))
  const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done))
  const port=(reservation.address() as {port:number}).port;await new Promise<void>(done=>reservation.close(()=>done()))
  const url=new URL(`http://127.0.0.1:${port}`)
  let logs=''
  const child=spawn(python,['-m','hermes_cli.main','serve','--host','127.0.0.1','--port',String(port),'--skip-build','--isolated'],{cwd:home,env:{PATH:process.env.PATH,HOME:process.env.HOME,HERMES_HOME:home,PYTHONPATH:source,HERMES_YOLO_MODE:'1',HERMES_DASHBOARD_SESSION_TOKEN:'fixture-memory-bridge-local-token',NO_PROXY:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',c=>{logs=(logs+String(c)).slice(-8000)});child.stderr.on('data',c=>{logs=(logs+String(c)).slice(-8000)})
  const client=new UpstreamClient(url),session=new UpstreamServiceSession(client,()=>undefined),target={url,client,session}
  const store=new WorkspaceStore(webHome),uploads=new UploadStore(webHome),db=new DatabaseSync(':memory:')
  const computer=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:url.href,hermesURL:url.href,token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python:'/must-not-run',hermesSource:'/must-not-read',hermesHome:'/must-not-read',network:'none'}},webHome,resolve('src/runner/worker/hermes_worker.py'),undefined,target)
  const owner='fixture-owner',agent=store.createAgent(owner,{name:'production-pipeline-fixture',profile:'default',execution:'computer',computer:'vm',vmExecution:'worker'}),gateways:ComputerGateway[]=[],grants:boolean[]=[],rpc:any[]=[]
  let current:ComputerGateway
  const bridged:GatewayTarget={...target,runner:{id:computer.config.runtime,computer:true,hermesComputer:true,
    open:async(onEvent,onDisconnect,scope)=>{
      current=new ComputerGateway(computer,{agentId:agent.id,environmentId:agent.id,ownerKey:owner,hermesRuntime:true},scope!.workId,async()=>scope!.authorize(),async()=>({}),target)
      gateways.push(current);current.onEvent=onEvent;current.onDisconnect=onDisconnect;await current.connect()
      const gateway=current
      return {rpc:(method,params)=>{rpc.push({method,params});return gateway.rpc(method,params)},close:()=>{void gateway.close()} }
    },
    lease:async(input)=>{
      const gateway=current;grants.push(input.workspaceMemory===true)
      gateway.installTeamLease(input.workId,input.catalog(),async(name,args,id)=>input.call(name,args,id),input.workspaceMemory===true)
      return {bind:async()=>{},dispose:async()=>gateway.removeTeamLease(input.workId)}
    },
  }}
  const nodes={requireSource(){},target:()=>bridged,targetForAgent:()=>bridged} as unknown as WorkspaceNodes
  const runtime=new WorkspaceRuntime(store,nodes,uploads)
  try{
    await expect.poll(async()=>{if(child.exitCode!==null)throw new Error(logs);try{return(await fetch(new URL('/api/status',url))).status}catch{return 0}},{timeout:45000}).toBe(200)
    runtime.knowledge.writeMemory(owner,{requestId:randomUUID(),scope:'agent',agentId:agent.id,content:botMemory,tier:'profile'})
    const conversation=store.list<any>(owner,'conversation').find(c=>c.memberIds[0]===agent.id)!
    for(const content of ['验证首次发言','验证恢复会话']){
      const run=runtime.send(owner,conversation.id,{requestId:randomUUID(),content})
      await expect.poll(()=>store.require<any>(owner,'run',run.id).status,{timeout:45000}).toMatch(/^(complete|failed|interrupted)$/)
      const saved=store.require<any>(owner,'run',run.id);expect(saved.status,saved.error+'\n'+logs).toBe('complete')
      expect(store.list<any>(owner,'message').find(m=>m.runId===run.id&&m.role==='assistant')?.content).toBe('BOT_MEMORY_BRIDGE_OK')
    }
    expect(grants).toEqual([true,true])
    expect(rpc.filter(r=>r.method==='session.create')).toHaveLength(1)
    expect(rpc.filter(r=>r.method==='session.resume')).toHaveLength(1)
    for(const row of rpc.filter(r=>r.method==='session.create')){
      expect(row.params).not.toHaveProperty('skip_memory');expect(row.params).not.toHaveProperty('workspace_memory')
      expect(row.params).toMatchObject({hidden:true,room_plumbing:true,source:'yaoyao_workspace'})
    }
    const sent=JSON.stringify(modelCalls)
    expect(sent).toContain(botMemory);expect(sent).not.toContain(profileMemory);expect(sent).not.toContain('PROFILE_PRIVATE_USER_MUST_NOT_REACH_BOT')
    for(const [file,marker] of Object.entries(contextFiles)){
      expect(sent).not.toContain(marker)
      expect(await readFile(join(home,file),'utf8')).toBe(marker)
    }
    const resumed=modelCalls.find(c=>JSON.stringify(c.messages).includes('验证恢复会话'))
    expect(JSON.stringify(resumed?.messages)).toContain('验证首次发言')
    expect(JSON.stringify(resumed?.messages)).toContain('BOT_MEMORY_BRIDGE_OK')
    expect(sent).toContain('production-pipeline-fixture')
    expect(modelCalls.flatMap(c=>c.tools??[]).some(t=>t.function?.name==='memory')).toBe(false)
    expect(await readFile(join(home,'memories','MEMORY.md'),'utf8')).toBe(profileMemory)
    expect(JSON.parse(await readFile(join(home,'config.yaml'),'utf8')).memory).toEqual(config.memory)
  }finally{
    runtime.close();await Promise.all(gateways.map(g=>g.close().catch(()=>{})));await computer.controls.close();await computer.pool.close()
    db.close();uploads.close();store.close();client.close()
    child.kill('SIGTERM');await new Promise<void>(done=>{if(child.exitCode!==null){done();return}const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);done()})})
    await new Promise<void>(done=>{model.close(()=>done());model.closeAllConnections()});await rm(home,{recursive:true,force:true})
  }
},120000)
