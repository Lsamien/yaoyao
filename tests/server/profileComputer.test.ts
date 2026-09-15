// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WebSocketServer,type WebSocket} from 'ws'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'
import {ProfileSkillSession} from '../../src/runner/worker/skills'
import {UpstreamClient} from '../../src/server/upstream'
import {UpstreamServiceSession} from '../../src/server/localAuth'
import type {GatewayFrame} from '../../src/server/workspaceGateway'

async function fixture(hermesManaged=false,bridgeVersion=2){
  const home=await mkdtemp(join(tmpdir(),'yaoyao-profile-computer-')),db=new DatabaseSync(':memory:')
  const calls:Array<{method:string;params:any}>=[],bindings:any[]=[],frames:GatewayFrame[]=[],gateways:ComputerGateway[]=[]
  const sessions=new Map<string,{stored:string;running:boolean}>()
  let socket:WebSocket,interruptStops=true,allowed=true
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    if(req.url?.endsWith('/bind'))bindings.push(JSON.parse(body))
    if(req.url?.endsWith('/computer-file')){res.setHeader('Content-Type','application/json');const data=JSON.parse(body);res.end(JSON.stringify(data.action==='read'?{ok:true,data:Buffer.from('hermes-authorized-file').toString('base64')}:{ok:true}));return}
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify(req.url==='/api/auth/ws-ticket'?{ticket:'test-ticket'}:req.url?.split('?')[0]?.endsWith('/capabilities')?{version:1,ready:true,in_process:true,native_tools:true,computer_runtime_version:bridgeVersion}:{ok:true,native_tools:true,computer_runtime_version:bridgeVersion,workspace_memory:body?JSON.parse(body).workspace_memory===true:false}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`)
  const ws=new WebSocketServer({server})
  const emit=(type:string,payload:Record<string,unknown>={},runtimeId=[...sessions.keys()].at(-1)!)=>socket.send(JSON.stringify({method:'event',params:{type,session_id:runtimeId,payload}}))
  ws.on('connection',connected=>{
    socket=connected;emit('gateway.ready')
    connected.on('message',raw=>{
      const request=JSON.parse(String(raw));calls.push(request)
      let result:any={ok:true}
      if(['session.create','session.resume'].includes(request.method)){
        const id=randomUUID(),stored=request.method==='session.resume'?request.params.session_id:randomUUID()
        sessions.set(id,{stored,running:false})
        result={session_id:id,stored_session_id:stored,running:false,info:{profile_name:request.params.profile,cwd:home}}
      }else if(request.method==='session.active_list')result={sessions:[...sessions].map(([id,s])=>({id,status:s.running?'working':'idle'}))}
      else if(request.method==='session.usage')result={context_used:123,context_max:32000}
      else if(request.method==='image.attach_bytes')result={ref_text:'[image](/hermes/attachments/image.png)'}
      else if(request.method==='file.attach')result={ref_text:`[host attachment](${home}/input.txt)`}
      else if(request.method==='prompt.submit')sessions.get(request.params.session_id)!.running=true
      else if(request.method==='session.interrupt'&&interruptStops){sessions.get(request.params.session_id)!.running=false;emit('message.complete',{status:'interrupted'},request.params.session_id)}
      connected.send(JSON.stringify({id:request.id,result}))
    })
  })
  const client=new UpstreamClient(url),target={url,client,session:new UpstreamServiceSession(client,()=>undefined)}
  const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:url.href,hermesURL:url.href,token:'test',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'/must-not-start-worker',hermesSource:home,hermesHome:home,network:'none'}},home)
  await runtime.ready;runtime.retainDesktops=true
  const resolver=vi.spyOn(runtime,'resolve').mockRejectedValue(new Error('isolated Worker must not be used'))
  vi.spyOn(runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:home})
  vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id:'vm',containerId:'vm',running:true,workspace:'/home/cua/workspace',isolation:'container'})
  vi.spyOn(runtime.provider,'inspect').mockResolvedValue({id:'vm',containerId:'vm',running:true,workspace:'/home/cua/workspace',isolation:'container'})
  vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
  vi.spyOn(runtime.provider,'capture').mockResolvedValue({data:'image',width:100,height:80,capturedAt:Date.now()})
  const execute=vi.spyOn(runtime.provider,'execute').mockResolvedValue({stdout:'vm result',stderr:''})
  const id=randomUUID(),meta={environmentId:id,agentId:id,ownerKey:'owner',profileSession:!hermesManaged,hostAccess:!hermesManaged,...(hermesManaged?{hermesRuntime:true}:{})}
  const gateway=()=>{
    const instance=new ComputerGateway(runtime,meta,randomUUID(),async()=>{if(!allowed)throw new Error('revoked')},async()=>({}),target)
    instance.onEvent=frame=>frames.push(frame);gateways.push(instance);return instance
  }
  const post=async(path:string,body:unknown)=>{
    const binding=bindings.at(-1)
    const response=await fetch(binding.bridge_url+path,{method:'POST',headers:{Authorization:`Bearer ${binding.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  }
  const tool=async(name:string,args:unknown)=>{
    const catalog=await post('/tools/list',{})
    const found=catalog.body.tools.find((t:any)=>t.name===name)
    expect(found,JSON.stringify(catalog)).toBeDefined()
    return post('/tools/call',{toolId:found.id,arguments:args,callId:randomUUID()})
  }
  return {home,runtime,resolver,execute,meta,gateway,calls,frames,bindings,sessions,post,tool,emit,
    setInterruptStops(value:boolean){interruptStops=value},revoke(){allowed=false},
    async close(){
      interruptStops=true;for(const session of sessions.values())session.running=false
      await Promise.all(gateways.map(g=>g.close().catch(()=>{})))
      await runtime.controls.close();await runtime.pool.close();db.close();client.close()
      for(const c of ws.clients)c.terminate()
      await new Promise<void>(resolve=>ws.close(()=>resolve()))
      await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})
      vi.restoreAllMocks();await rm(home,{recursive:true,force:true})
    },
  }
}

it('uses a native Profile session and bridge for VM tools, preserves rotated history and keeps Worker sessions separate',async()=>{
  const f=await fixture()
  try{
    const g=f.gateway();await g.connect();const opened=await g.rpc('session.create',{profile:'default'})
    g.installTeamLease('team',[{id:'team_test',name:'team_test',description:'team fixture',inputSchema:{}}],async()=>({proof:'team-result'}))
    const attached=await g.rpc('file.attach',{session_id:opened.session_id,name:'input.txt',data_url:'data:text/plain;base64,aGk='})
    expect(attached.ref_text).toContain(f.home)
    await g.rpc('prompt.submit',{session_id:opened.session_id,text:'Use the Profile and its local VM'})
    expect(f.resolver).not.toHaveBeenCalled();expect(f.runtime.workers.size).toBe(0)
    expect(f.calls.find(c=>c.method==='session.create')?.params).toMatchObject({profile:'default',close_on_disconnect:false})
    expect(f.calls.find(c=>c.method==='prompt.submit')?.params.text).toContain('本机协作模式')
    expect(f.bindings.at(-1)).toMatchObject({native_tools:true,profile:'default'})
    const catalog=(await f.post('/tools/list',{})).body.tools.map((t:any)=>t.name)
    expect(catalog).toEqual(expect.arrayContaining(['computer_shell','computer_copy_file','team_test']))
    expect(catalog).not.toContain('host_shell')
    const skills=vi.spyOn(ProfileSkillSession.prototype,'call').mockResolvedValue({skills:[{name:'profile-procedure'}]})
    expect((await f.tool('computer_skills_list',{})).body.structuredContent).toEqual({skills:[{name:'profile-procedure'}]})
    expect(skills).toHaveBeenCalledWith('computer_skills_list',{})
    expect(skills.mock.instances[0]?.options.profile).toBe('default')
    expect(skills.mock.instances[0]?.options.agentId).toBe(f.meta.agentId)
    skills.mockRestore()
    expect((await f.tool('computer_shell',{command:'pwd'})).body.structuredContent).toMatchObject({stdout:'vm result'})
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({cwd:'/home/cua/workspace'}),['/bin/bash','-lc','pwd'],expect.anything())
    expect((await f.tool('team_test',{})).body.structuredContent).toEqual({proof:'team-result'})
    await writeFile(join(f.home,'source.bin'),Buffer.from([0,1,255]))
    await f.tool('computer_copy_file',{from:'host',source:'source.bin',destination:'target.bin'})
    expect(f.execute.mock.calls.at(-1)?.[2]?.input).toEqual(Buffer.from([0,1,255]))
    const rotated=randomUUID();f.emit('session.info',{stored_session_id:rotated})
    await vi.waitFor(()=>expect(f.runtime.session(opened.session_id,f.meta,'default').profileSessionId).toBe(rotated))
    expect(f.frames.at(-1)?.payload.stored_session_id).toBe(opened.session_id)
    f.sessions.values().next().value!.running=false;f.emit('message.complete',{text:'Profile finished',status:'complete'})
    await vi.waitFor(()=>expect(f.frames.at(-1)?.payload.text).toBe('Profile finished'))
    expect((await f.runtime.controls.status(f.meta)).mode).toBe('idle')
    expect(await g.rpc('session.usage',{session_id:opened.session_id})).toMatchObject({context_used:123})
    await g.close()
    const resumed=f.gateway();await resumed.connect();await resumed.rpc('session.resume',{profile:'default',session_id:opened.session_id})
    expect(f.calls.findLast(c=>c.method==='session.resume')?.params.session_id).toBe(rotated)
    expect(()=>f.runtime.session(opened.session_id,{...f.meta,profileSession:false},'default')).toThrow('执行方式已改变')
  }finally{await f.close()}
})

it('waits for native termination and VM calls before human takeover, then resumes only after giveback',async()=>{
  const f=await fixture()
  try{
    const g=f.gateway();await g.connect();const session=await g.rpc('session.create',{profile:'default'})
    await g.rpc('prompt.submit',{session_id:session.session_id,text:'Work'})
    let finishTool!:()=>void
    f.execute.mockImplementationOnce(async()=>{await new Promise<void>(done=>{finishTool=done});return {stdout:'finished',stderr:''}})
    const pending=f.tool('computer_shell',{command:'long command'})
    await vi.waitFor(()=>expect(finishTool).toBeTypeOf('function'))
    f.setInterruptStops(false)
    const controlId=randomUUID();await f.runtime.controls.take(f.meta,'default',controlId,async()=>{})
    await vi.waitFor(()=>expect(f.calls.some(c=>c.method==='session.interrupt')).toBe(true))
    expect((await f.runtime.controls.status(f.meta)).mode).toBe('pausing')
    for(const native of f.sessions.values())native.running=false
    f.emit('message.complete',{status:'interrupted'})
    await new Promise(done=>setTimeout(done,150))
    expect((await f.runtime.controls.status(f.meta)).mode).toBe('pausing')
    finishTool();await pending
    await g.takeControl(controlId,()=>{})
    await vi.waitFor(async()=>expect((await f.runtime.controls.status(f.meta)).mode).toBe('human'))
    expect(f.frames.some(frame=>frame.type==='message.complete')).toBe(false)
    expect((await f.tool('computer_shell',{command:'must not execute'})).body.isError).toBe(true)
    expect(f.calls.filter(c=>c.method==='prompt.submit')).toHaveLength(1)
    await f.runtime.controls.giveBack(f.meta,controlId,'已完成登录')
    expect(f.calls.filter(c=>c.method==='prompt.submit')).toHaveLength(2)
    expect(f.calls.at(-1)?.params.text).toContain('已完成登录')
    expect((await f.runtime.controls.status(f.meta)).mode).toBe('agent')
    f.setInterruptStops(true);await g.rpc('session.interrupt',{session_id:session.session_id})
    expect((await f.runtime.controls.status(f.meta)).mode).toBe('off')
    await expect(f.post('/tools/list',{})).rejects.toThrow()
  }finally{await f.close()}
})


it('uses Hermes for an isolated Bot without reading Profile config or running a Worker; native skills and authorized files stay in Hermes',async()=>{
  const f=await fixture(true)
  try{
    const workspace=vi.mocked(f.runtime.resolveWorkspace);workspace.mockRejectedValue(new Error('must not read Profile config'))
    const skills=vi.spyOn(ProfileSkillSession.prototype,'call').mockRejectedValue(new Error('must not launch a skills reader'))
    const g=f.gateway();await g.connect();const session=await g.rpc('session.create',{profile:'default'})
    await g.rpc('image.attach_bytes',{session_id:session.session_id,filename:'image.png',content_base64:'aW1hZ2U='})
    await g.rpc('prompt.submit',{session_id:session.session_id,text:'Use the authorized Profile skill'})
    expect(f.calls.find(c=>c.method==='image.attach_bytes')?.params.content_base64).toBe('aW1hZ2U=')
    expect(f.bindings.at(-1)).toMatchObject({computer_policy:{mode:'isolated',hostAccess:false}})
    expect(f.calls.find(c=>c.method==='prompt.submit')?.params.text).toContain('Hermes 原生 skills_list')
    const catalog=(await f.post('/tools/list',{})).body.tools.map((t:any)=>t.name)
    expect(catalog).toContain('computer_shell');expect(catalog).not.toContain('computer_skill_view');expect(catalog).not.toContain('host_shell')
    await f.tool('computer_copy_file',{from:'host',source:'/only-hermes-can-read/input.txt',destination:'input.txt'})
    expect(f.execute.mock.calls.at(-1)?.[2]?.input?.toString()).toBe('hermes-authorized-file')
    expect(workspace).not.toHaveBeenCalled();expect(f.resolver).not.toHaveBeenCalled();expect(skills).not.toHaveBeenCalled();expect(f.runtime.workers.size).toBe(0)
    expect(f.runtime.session(session.session_id,f.meta,'default')).toMatchObject({hermesRuntime:true,profileSessionId:expect.any(String)})
    f.revoke()
    await expect(g.rpc('prompt.submit',{session_id:session.session_id,text:'must not run'})).rejects.toThrow()
  }finally{await f.close()}
})


it('rejects an old Hermes plugin before prompt submission and never falls back to the Worker',async()=>{
  const f=await fixture(true,1)
  try{
    const g=f.gateway();await g.connect()
    await expect(g.rpc('session.create',{profile:'default'})).rejects.toMatchObject({code:'computer_bridge_upgrade_required'})
    expect(f.runtime.workers.size).toBe(0);expect(f.resolver).not.toHaveBeenCalled()
    expect(f.calls.some(c=>c.method==='prompt.submit')).toBe(false)
  }finally{await f.close()}
})


it('sends workspace memory policy through the private bridge instead of session.create',async()=>{
  const f=await fixture(true)
  try{
    const g=f.gateway();await g.connect();const session=await g.rpc('session.create',{profile:'default',hidden:true,room_plumbing:true})
    g.installTeamLease('memory',[],async()=>({}),true)
    await g.rpc('prompt.submit',{session_id:session.session_id,text:'Use scoped memory'})
    expect(f.calls.find(call=>call.method==='session.create')?.params).not.toHaveProperty('skip_memory')
    expect(f.calls.find(call=>call.method==='session.create')?.params).not.toHaveProperty('workspace_memory')
    expect(f.bindings.at(-1)).toMatchObject({workspace_memory:true})
  }finally{await f.close()}
})
