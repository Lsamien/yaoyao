// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {DesktopEnvironments,DESKTOP_ENVIRONMENT_TOOLS,DESKTOP_FILE_TOOL_IDS} from '../../src/server/desktopEnvironments'
import type {WorkspaceAgent} from '../../src/shared/workspace'
import {saveHostTools} from '../../src/server/hostToolSettings'
import {HttpError} from '../../src/server/errors'
import {acquireServiceInstance} from '../../src/server/serviceInstance'
let home:string,store:WorkspaceStore,service:DesktopEnvironments,agent:WorkspaceAgent,version:number,host:any,poller:ReturnType<typeof setInterval>|undefined
const auth={require:(ctx:any)=>({id:ctx.get('x-user')||'owner'}),requireAdmin:(ctx:any)=>{if(ctx.get('x-user'))throw new HttpError(403,'仅限管理员','admin_required')},pushAuthorizationVersion:()=>version} as any
const nodes={localNodeID:'local-node',requireSource:()=>{}} as any
const ownerKey=(owner:string)=>createHash('sha256').update('local-node:'+owner).digest('hex')
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'desktop-env-'));store=new WorkspaceStore(home);service=new DesktopEnvironments(store,auth,nodes);version=1;agent=store.createAgent('owner',{name:'Desktop',nodeId:'local',profile:'default',computer:'local'});host={id:randomUUID(),name:'测试 Mac',platform:'darwin',screen:true,accessibility:true,approved:[ownerKey('owner')]}})
const pollers=new Set<ReturnType<typeof setInterval>>()
afterEach(()=>{clearInterval(poller);for(const p of pollers)clearInterval(p);pollers.clear();service.close();store.close();rmSync(home,{recursive:true,force:true});vi.useRealTimers()})
const app=()=>{const a=new Koa();a.use(async(ctx,next)=>{try{await next()}catch(e:any){ctx.status=e.status??500;ctx.body={error:e.message,code:e.code}}});a.use(bodyParser());a.use(service.router().routes());return a.callback()}
const base=()=>'/api/app/agents/'+agent.id
it('uses global desktop capabilities for legacy, modern and temporary Bots',async()=>{
 drive()
 for(const patch of [{computer:'off',envs:undefined},{computer:'vm',execution:'computer'},{envs:{}},{temporaryGoalId:randomUUID()}]){
  const candidate={...agent,...patch} as WorkspaceAgent
  expect(service.selected('owner',candidate)).toBe('local')
  expect(service.envTools('owner',candidate).view).toBe(true)
 }
 saveHostTools(home,{scriptMachine:false,serverComputer:false})
 expect(service.envTools('owner',agent).view).toBe(false)
 await expect(service.call('owner',agent.id,'desktop_environment_view',{host:'server'},new AbortController().signal,()=>{},'local',service.epoch)).rejects.toMatchObject({code:'desktop_host_disabled'})
})

function drive(handle:(c:any)=>unknown=c=>c.operation==='view'?{data:Buffer.from('fixture frame').toString('base64'),width:1280,height:800}:{ok:true}){let results:any[]=[];service.exchange({host,results});const p=setInterval(()=>{const value=service.exchange({host,results});results=value.commands.map(c=>({id:c.id,value:handle(c)}))},5);pollers.add(p);poller=p}
const HOST_A='11111111-aaaa-4bbb-8ccc-111111111111',HOST_B='22222222-aaaa-4bbb-8ccc-222222222222'
function driveRemote(id:string,hostInfo:any,handle:(c:any)=>unknown=c=>c.operation==='view'?{data:Buffer.from('remote frame').toString('base64'),width:1280,height:800}:{ok:true}){let results:any[]=[];service.remoteExchange(id,{host:hostInfo,results});const p=setInterval(()=>{const value=service.remoteExchange(id,{host:hostInfo,results});results=value.commands.map(c=>({id:c.id,value:handle(c)}))},5);pollers.add(p);poller=p}
it('defaults bot work to the customer machine and uses that binding while the server desktop is also online',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',desktopHost:HOST_A})
 const remoteHost={...host,name:'客厅 Mac Pro'}
 driveRemote(HOST_A,remoteHost)
 drive()
 const state=(await request(app()).get(base()+'/desktop-environment')).body
 expect(state.hostName??state.host?.name).toBe('客厅 Mac Pro')
 const named=(await request(app()).get(base()+'/computer?backend=desktop&host='+encodeURIComponent('客厅 Mac Pro'))).body
 expect(named.hostName).toBe('客厅 Mac Pro')
 vi.useFakeTimers()
 clearInterval(poller)
 vi.advanceTimersByTime(9000)
 const fallback=(await request(app()).get(base()+'/desktop-environment')).body
 expect(fallback.hostName??fallback.host?.name).toBe('客厅 Mac Pro')
 const epoch=service.hostEpoch('owner',agent)
 expect(epoch).toBe(remoteHost.id)
 const result=await service.call('owner',agent.id,'desktop_environment_view',{},new AbortController().signal,()=>{},'local',epoch,HOST_A)
 expect(result.content[0].type).toBe('image')
 expect(JSON.parse(result.content[1].text).host).toBe('客厅 Mac Pro')
 vi.useRealTimers()
 const hosts=(await request(app()).get(base()+'/desktop-environment')).body
 expect(hosts.hosts.map((h:any)=>h.id)).toEqual(['local',HOST_A])
 expect(hosts.hosts.find((h:any)=>h.id===HOST_A)).toMatchObject({name:'客厅 Mac Pro',online:true})
})
it('keeps 本机 on the computer running YaoYao when another Mac is online',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local'})
 drive()
 driveRemote(HOST_A,{...host,name:'客厅 Mac'})
 const state=(await request(app()).get(base()+'/desktop-environment')).body
 expect(state.host.id).toBe('local')
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:'本机'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')
 expect(JSON.parse(view.content[1].text).host).toBe('测试 Mac')
})
it('requires an explicit binding when several remote hosts are connected',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local'})
 service.remoteExchange(HOST_A,{host:{...host,name:'书房'},results:[]})
 service.remoteExchange(HOST_B,{host:{...host,name:'客厅'},results:[]})
 const state=(await request(app()).get(base()+'/desktop-environment')).body
 expect(state.online).toBe(false)
 expect(state.hosts).toHaveLength(2)
 await request(app()).get(base()+'/computer/frame').expect(409)
 agent=store.updateAgent('owner',agent.id,{desktopHost:HOST_B})
 driveRemote(HOST_B,{...host,name:'客厅'})
 const status=(await request(app()).get(base()+'/computer')).body
 expect(status.hostName).toBe('客厅')
 const ticket=await take()
 await request(app()).post(base()+'/computer/giveback').send(ticket).expect(200)
})
it('lets the manual viewer take over any connected host via the host parameter',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',desktopHost:HOST_B})
 driveRemote(HOST_A,{...host,name:'书房'},c=>c.operation==='view'?{data:Buffer.from('study frame').toString('base64'),width:1280,height:800}:{ok:true})
 driveRemote(HOST_B,{...host,name:'客厅'},c=>c.operation==='view'?{data:Buffer.from('living frame').toString('base64'),width:1280,height:800}:{ok:true})
 const study='?backend=desktop&host='+encodeURIComponent(HOST_A)
 const status=(await request(app()).get(base()+'/computer'+study)).body
 expect(status.hostName).toBe('书房');expect(status.mode).toBe('idle')
 const ticket=(await request(app()).post(base()+'/computer/take'+study).send({requestId:randomUUID()}).expect(200)).body
 expect(ticket.hostName).toBe('书房')
 const bound=(await request(app()).get(base()+'/computer?backend=desktop')).body
 expect(bound.hostName).toBe('客厅');expect(bound.mode).toBe('idle')
 const frame=await request(app()).get(base()+'/computer/frame'+study).expect(200)
 expect(Buffer.from(frame.body.data,'base64').toString()).toBe('study frame')
 await request(app()).post(base()+'/computer/giveback'+study).send({controlId:ticket.controlId,token:ticket.token}).expect(200)
 const response=await request(app()).get(base()+'/computer?backend=desktop&host=nope').expect(409)
 expect(response.body.code).toBe('desktop_host_unknown')
})
it('revoking a computer fences only its dispatched commands',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',desktopHost:HOST_A})
 service.remoteExchange(HOST_A,{host,results:[]})
 const call=service.call('owner',agent.id,'desktop_environment_view',{},new AbortController().signal,()=>{},'local',service.hostEpoch('owner',agent),HOST_A)
 await vi.waitFor(()=>{expect(service.remoteExchange(HOST_A,{host,results:[]}).commands).toHaveLength(1)})
 service.dropHost(HOST_A)
 await expect(call).rejects.toMatchObject({code:'desktop_disconnected'})
})
it('gates file and shell tools behind the separate full grant',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local'})
 service.exchange({host,results:[]})
 expect(service.fileTools('owner',agent)).toBe(false)
 await expect(service.call('owner',agent.id,'desktop_file_read',{host:'server',path:'notes.txt'},new AbortController().signal,()=>{},'local',service.hostEpoch('owner',agent))).rejects.toMatchObject({code:'desktop_full_required'})
 await expect(service.call('owner',agent.id,'desktop_shell',{host:'server',command:'ls'},new AbortController().signal,()=>{},'local',service.hostEpoch('owner',agent))).rejects.toMatchObject({code:'desktop_full_required'})
 const seen:any[]=[]
 drive(c=>{seen.push(c);return c.operation==='view'?{data:'Zm9v',width:1280,height:800}:{op:'list',entries:[]}})
 host.full=[ownerKey('owner')]
 service.exchange({host,results:[]})
 expect(service.fileTools('owner',agent)).toBe(true)
 const listing=await service.call('owner',agent.id,'desktop_file_list',{host:'server',path:'Documents'},new AbortController().signal,()=>{},'local',service.hostEpoch('owner',agent))
 expect(listing.entries).toEqual([])
 expect(seen.find(c=>c.operation==='file')?.action).toMatchObject({op:'list',path:'Documents'})
 await expect(service.call('owner',agent.id,'desktop_file_write',{host:'server',path:'a.txt',data:'!!!not base64!!!'},new AbortController().signal,()=>{},'local',service.hostEpoch('owner',agent))).rejects.toMatchObject({status:400})
})
it('passes the authorize scope through to the computer',async()=>{
 const seen:any[]=[]
 drive(c=>{seen.push(c);return {ok:true}})
 await request(app()).post(base()+'/desktop-environment/authorize').send({scope:'full'}).expect(200)
 expect(seen.find(c=>c.operation==='authorize')?.scope).toBe('full')
})
it('copies files between the explicitly named hosts and server without chat attachments or model payloads',async()=>{
 const bytes=Buffer.alloc(300_000);for(let i=0;i<bytes.length;i++)bytes[i]=i%256
 const seen:Array<{host:string;action:any}>=[]
 const handle=(id:string)=>(c:any)=>{seen.push({host:id,action:c.action});return c.action.op==='read'?{path:c.action.path,size:bytes.length,data:bytes.toString('base64')}:{path:c.action.path,size:Buffer.from(c.action.data,'base64').length,sha256:createHash('sha256').update(Buffer.from(c.action.data,'base64')).digest('hex')}}
 host.full=[ownerKey('owner')]
 drive(handle('server'))
 driveRemote(HOST_A,{...host,id:randomUUID(),name:'mac1'},handle('mac1'))
 driveRemote(HOST_B,{...host,id:randomUUID(),name:'mac2'},handle('mac2'))
 for(const [sourceHost,targetHost,targetId] of [['mac1','mac2',HOST_B],['mac1','server','local'],['server','本机',HOST_A]]){
  const result=await service.call('owner',agent.id,'desktop_file_copy',{sourceHost,sourcePath:'Desktop/a.txt',targetHost,targetPath:'Desktop/a.txt'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)
  expect(result).toMatchObject({copied:true,target:{host:targetId,path:'Desktop/a.txt'},size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  expect(JSON.stringify(result).length).toBeLessThan(700)
 }
 expect(seen.map(({host,action})=>[host,action.op])).toEqual([['mac1','read'],['mac2','receive'],['mac1','read'],['server','receive'],['server','read'],['mac1','receive']])
 for(const {action} of seen.filter(item=>item.action.op==='receive')){expect(action.overwrite).toBe(false);expect(Buffer.from(action.data,'base64')).toEqual(bytes)}
 expect(store.list('owner','file')).toEqual([])
 expect(DESKTOP_FILE_TOOL_IDS.has('desktop_file_copy')).toBe(true)
 expect(DESKTOP_ENVIRONMENT_TOOLS.some(tool=>tool.id==='desktop_file_copy')).toBe(true)
})
it('serializes opposing transfers without deadlocking or changing the target',async()=>{
 host.full=[ownerKey('owner')]
 const handle=(c:any)=>c.action.op==='read'?{size:1,data:'YQ=='}:{path:c.action.path,size:1,sha256:c.action.sha256}
 driveRemote(HOST_A,{...host,name:'mac1'},handle);driveRemote(HOST_B,{...host,id:randomUUID(),name:'mac2'},handle)
 const copy=(sourceHost:string,targetHost:string)=>service.call('owner',agent.id,'desktop_file_copy',{sourceHost,sourcePath:'Desktop/a',targetHost,targetPath:'Desktop/b'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))
 const values=await Promise.all([copy('mac1','mac2'),copy('mac2','mac1'),copy('mac1','mac1')])
 expect(values.map(value=>value.target.host)).toEqual([HOST_B,HOST_A,HOST_A])
})
it('requires both host grants and never falls back for missing or ambiguous hosts',async()=>{
 host.full=[ownerKey('owner')];drive()
 driveRemote(HOST_A,{...host,id:randomUUID(),name:'mac1',full:[]})
 const copy=(sourceHost:string,targetHost:string)=>service.call('owner',agent.id,'desktop_file_copy',{sourceHost,sourcePath:'Desktop/a',targetHost,targetPath:'Desktop/a'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))
 await expect(copy('server','mac1')).rejects.toMatchObject({code:'desktop_full_required'})
 await expect(copy('mac1','server')).rejects.toMatchObject({code:'desktop_full_required'})
 await expect(copy('server','本机')).rejects.toMatchObject({code:'desktop_source_required'})
 await expect(copy('missing','server')).rejects.toMatchObject({code:'desktop_host_unknown'})
 driveRemote(HOST_B,{...host,id:randomUUID(),name:'mac1'})
 await expect(copy('mac1','server')).rejects.toMatchObject({code:'desktop_host_ambiguous'})
})
it.each(['disconnect','cancel','revoke','corrupt','oversized'])('does not write the target when the source transfer is %s',async failure=>{
 host.full=[ownerKey('owner')];const controller=new AbortController(),writes:any[]=[]
 driveRemote(HOST_A,{...host,name:'mac1'},()=>{
  if(failure==='disconnect')service.dropHost(HOST_B)
  if(failure==='cancel')controller.abort()
  if(failure==='revoke')version++
  return {size:failure==='oversized'?10*1024*1024+1:failure==='corrupt'?2:1,data:'YQ=='}
 })
 driveRemote(HOST_B,{...host,id:randomUUID(),name:'mac2'},c=>{writes.push(c);return {}})
 await expect(service.call('owner',agent.id,'desktop_file_copy',{sourceHost:'mac1',sourcePath:'Desktop/a',targetHost:'mac2',targetPath:'Desktop/a'},controller.signal,()=>{},'local',service.hostEpochs('owner',agent))).rejects.toThrow()
 expect(writes).toEqual([])
})
it('reports a failed destination receipt without claiming success or retrying',async()=>{
 host.full=[ownerKey('owner')];const receives:any[]=[]
 driveRemote(HOST_A,{...host,name:'mac1'},()=>({size:0,data:''}))
 driveRemote(HOST_B,{...host,id:randomUUID(),name:'mac2'},c=>{receives.push(c);return {path:c.action.path,size:0,sha256:'wrong'}})
 await expect(service.call('owner',agent.id,'desktop_file_copy',{sourceHost:'mac1',sourcePath:'Desktop/a',targetHost:'mac2',targetPath:'Desktop/a',overwrite:true},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))).rejects.toMatchObject({code:'desktop_transfer_unconfirmed'})
 expect(receives).toHaveLength(1);expect(receives[0].action.overwrite).toBe(true)
})
it('waits for a target taken over during the source read and resumes after giveback',async()=>{
 host.full=[ownerKey('owner')]
 const source={...host,name:'mac1'},target={...host,id:randomUUID(),name:'mac2'},writes:any[]=[]
 service.remoteExchange(HOST_A,{host:source,results:[]})
 driveRemote(HOST_B,target,c=>{if(c.operation!=='file')return {ok:true};writes.push(c);return {path:c.action.path,size:1,sha256:c.action.sha256}})
 const copying=service.call('owner',agent.id,'desktop_file_copy',{sourceHost:'mac1',sourcePath:'Desktop/a',targetHost:'mac2',targetPath:'Desktop/a'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))
 let read:any
 await vi.waitFor(()=>{read=service.remoteExchange(HOST_A,{host:source,results:[]}).commands[0];expect(read).toBeDefined()})
 const query='?backend=desktop&host='+HOST_B
 const ticket=(await request(app()).post(base()+'/computer/take'+query).send({requestId:randomUUID()}).expect(200)).body
 service.remoteExchange(HOST_A,{host:source,results:[{id:read.id,value:{size:1,data:'YQ=='}}]})
 await new Promise(resolve=>setTimeout(resolve,180));expect(writes).toEqual([])
 await request(app()).post(base()+'/computer/giveback'+query).send({controlId:ticket.controlId,token:ticket.token,notes:'已交还 mac2'}).expect(200)
 expect(await copying).toMatchObject({copied:true,handoffNotes:['mac2：已交还 mac2']});expect(writes).toHaveLength(1)
})
it('routes parallel desktop tools to the host named in the call',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',envs:{desktop:true,cloud:true}})
 const study={...host,name:'书房 iMac'},living={...host,id:randomUUID(),name:'客厅 Mac mini'}
 driveRemote(HOST_A,study)
 let resultsB:any[]=[]
 service.remoteExchange(HOST_B,{host:living,results:[]})
 const pollerB=setInterval(()=>{const value=service.remoteExchange(HOST_B,{host:living,results:resultsB});resultsB=value.commands.map(c=>({id:c.id,value:c.operation==='view'?{data:Buffer.from('living-room').toString('base64'),width:1280,height:800}:{ok:true}}))},5)
 try{
  expect(service.envTools('owner',agent)).toEqual({view:true,browser:false,file:false})
  const frame=await service.call('owner',agent.id,'desktop_environment_view',{host:'客厅 Mac mini'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))
  expect(Buffer.from(frame.content[0].data,'base64').toString()).toBe('living-room')
  await expect(service.call('owner',agent.id,'desktop_environment_view',{host:'书房 iMac'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))).resolves.toMatchObject({content:[{type:'image'},{type:'text'}]})
  await expect(service.call('owner',agent.id,'desktop_environment_view',{host:'地下室 MacBook'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))).rejects.toMatchObject({code:'desktop_host_unknown'})
  expect(service.onlineHostsLine('owner')).toContain('书房 iMac')
 }finally{clearInterval(pollerB)}
})
it('ignores a stored browser environment and keeps desktop tools',async()=>{
 agent=store.updateAgent('owner',agent.id,{envs:{vm:true,desktop:true,browser:true,cloud:false}})
 drive()
 expect(service.selected('owner',agent)).toBe('local')
 expect(service.envTools('owner',agent)).toEqual({view:true,browser:false,file:false})
 await expect(service.call('owner',agent.id,'desktop_browser',{kind:'navigate',url:'https://example.test/both'},new AbortController().signal,()=>{},'browser',service.epoch)).rejects.toMatchObject({status:404,code:'tool_not_found'})
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:'server'},new AbortController().signal,()=>{},'local',service.epoch)
 expect(view.content[0].type).toBe('image')
})
it('degrades envs desktop tools when no host is ready or online',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'off',envs:{desktop:true,browser:true}})
 expect(service.envTools('owner',agent)).toEqual({view:false,browser:false,file:false})
 service.exchange({host,results:[]})
 expect(service.envTools('owner',agent)).toEqual({view:true,browser:false,file:false})
 host.full=[ownerKey('owner')]
 service.exchange({host,results:[]})
 expect(service.envTools('owner',agent)).toEqual({view:true,browser:false,file:true})
})
it('keeps manual takeover scoped per computer',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',desktopHost:HOST_A})
 const second=store.createAgent('owner',{name:'Second',nodeId:'local',profile:'default',computer:'local',desktopHost:HOST_B})
 driveRemote(HOST_A,{...host,name:'书房'})
 let resultsB:any[]=[]
 const pollerB=setInterval(()=>{const value=service.remoteExchange(HOST_B,{host:{...host,name:'客厅'},results:resultsB});resultsB=value.commands.map(c=>({id:c.id,value:{ok:true}}))},5)
 try{
  const ticketA=await take()
  const ticketB=(await request(app()).post('/api/app/agents/'+second.id+'/computer/take').send({requestId:randomUUID()}).expect(200)).body
  expect(ticketB.hostName).toBe('客厅')
  const records=store.list<any>('_system','computer-control')
  expect(records).toHaveLength(2)
  expect(new Set(records.map(r=>r.environmentId.split(':')[1])).size).toBe(2)
  await request(app()).post(base()+'/computer/renew').send(ticketA).expect(200)
  await request(app()).post(base()+'/computer/giveback').send(ticketA).expect(200)
  await request(app()).post('/api/app/agents/'+second.id+'/computer/giveback').send(ticketB).expect(200)
 }finally{clearInterval(pollerB)}
})
async function take(){return (await request(app()).post(base()+'/computer/take').send({requestId:randomUUID()}).expect(200)).body}
async function frame(){return (await request(app()).get(base()+'/computer/frame').expect(200)).body}
it('keeps capability private and refuses origins before parsing native commands',async()=>{const instance=acquireServiceInstance(home,'0.4.3'),a=new Koa().use(instance.middleware(async()=>{},()=>true,ctx=>service.bridge(ctx)));try{await request(a.callback()).post('/desktop/environment').send({host,results:[]}).expect(403);await request(a.callback()).post('/desktop/environment').set('x-yaoyao-desktop-token',instance.record.token).set('Origin','http://evil.test').send({host,results:[]}).expect(403);await request(a.callback()).post('/desktop/environment').set('x-yaoyao-desktop-token',instance.record.token).send({host,results:[]}).expect(200);expect(service.online).toBe(true)}finally{instance.release()}})
it('auto selects only an approved and ready local host; observing never opens a browser',async()=>{agent=store.updateAgent('owner',agent.id,{computer:'auto'});expect(service.selected('owner',agent)).toBe('local');expect(service.exchange({host:{...host,approved:[]},results:[]}).commands).toEqual([]);expect(service.selected('owner',agent)).toBe('local');service.exchange({host,results:[]});expect(service.selected('owner',agent)).toBe('local');host.screen=false;service.exchange({host,results:[]});expect(service.selected('owner',agent)).toBe('local');await request(app()).get(base()+'/desktop-environment').set('x-user','other').expect(404)})
it('shares the physical desktop across owners and robots but scopes manual tokens to their owner and robot',async()=>{agent=store.updateAgent('owner',agent.id,{computer:'local'});const other=store.createAgent('other',{name:'Other',nodeId:'local',profile:'default',computer:'local'});host.approved.push(ownerKey('other'));drive();const ticket=await take();await request(app()).post('/api/app/agents/'+other.id+'/computer/take').set('x-user','other').send({requestId:randomUUID()}).expect(409);await request(app()).post('/api/app/agents/'+other.id+'/computer/renew').set('x-user','other').send(ticket).expect(410);const state=(await request(app()).get('/api/app/agents/'+other.id+'/computer').set('x-user','other')).body;expect(state.controlId).toBeUndefined();await request(app()).post(base()+'/computer/giveback').send(ticket).expect(200)})
it('rejects stale frames and replays an input result exactly once',async()=>{const calls:any[]=[];drive(c=>{calls.push(c);return c.operation==='view'?{data:'Zm9v',width:1280,height:800}:{ok:true}});const t=await take(),f=await frame(),body={controlId:t.controlId,token:t.token,requestId:randomUUID(),generation:f.generation,frameId:f.id,action:{kind:'click',x:10,y:10}};await request(app()).post(base()+'/computer/input').send({...body,frameId:randomUUID()}).expect(409);await request(app()).post(base()+'/computer/input').send(body).expect(200);await request(app()).post(base()+'/computer/input').send(body).expect(200);expect(calls.filter(c=>c.operation==='input')).toHaveLength(1);await request(app()).post(base()+'/computer/input').send({...body,action:{kind:'text',text:'different'}}).expect(409);await request(app()).put(base()+'/browser-profile').send({profile:'temporary'}).expect(409)})
it('expired control remains paused until a new takeover is explicitly returned',async()=>{drive();const t=await take();const original=Date.now;const time=vi.spyOn(Date,'now').mockImplementation(()=>original()+31000);service.exchange({host,results:[]});await request(app()).post(base()+'/computer/renew').send(t).expect(410);expect((await request(app()).get(base()+'/computer')).body.mode).toBe('error');time.mockRestore();const next=await take();await request(app()).post(base()+'/computer/giveback').send({...next,notes:'已完成登录'}).expect(200);expect((await request(app()).get(base()+'/computer')).body.mode).toBe('idle')})
it('pins tool calls to the host epoch and does not dispatch after permissions change',async()=>{drive();const epoch=service.epoch,signal=new AbortController().signal;await service.call('owner',agent.id,'desktop_environment_view',{host:'server'},signal,()=>{},'local',epoch);host.id=randomUUID();service.exchange({host,results:[]});await expect(service.call('owner',agent.id,'desktop_environment_action',{host:'server',kind:'text',text:'no'},signal,()=>{},'local',epoch)).rejects.toThrow('连接已改变');version++;const t=await take();version++;await request(app()).post(base()+'/computer/renew').send(t).expect(410)})
it('waits for human release before the robot runs and forwards handoff notes',async()=>{drive();const t=await take();let complete=false;const call=service.call('owner',agent.id,'desktop_environment_view',{host:'server'},new AbortController().signal,()=>{},'local',service.epoch).then(value=>{complete=true;return value});await new Promise(resolve=>setTimeout(resolve,30));expect(complete).toBe(false);await request(app()).post(base()+'/computer/giveback').send({...t,notes:'已登录测试账号'}).expect(200);const value=await call;expect(JSON.stringify(value)).toContain('已登录测试账号')})
it('refuses dangerous navigation and prevents changing profile during active work',async()=>{drive();const t=await take(),f=await frame();await request(app()).post(base()+'/computer/browser').send({controlId:t.controlId,token:t.token,requestId:randomUUID(),generation:f.generation,frameId:f.id,action:{kind:'navigate',url:'file:///etc/passwd'}}).expect(409);await request(app()).post(base()+'/computer/giveback').send(t).expect(200);store.put('owner','turn','turn',{agentId:agent.id,status:'running'});await request(app()).put(base()+'/browser-profile').send({profile:'temporary'}).expect(409)})

it('resolves 本机 to the messaging device when deviceHost is a computer',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local'})
 drive()
 driveRemote(HOST_A,{...host,name:'客厅 Mac'})
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:'本机'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)
 expect(JSON.parse(view.content[1].text).host).toBe('客厅 Mac')
 const omitted=await service.call('owner',agent.id,'desktop_environment_view',{},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)
 expect(JSON.parse(omitted.content[1].text).host).toBe('客厅 Mac')
})
it('keeps 本机 on the server when deviceHost is local even if a computer is bound',async()=>{
 agent=store.updateAgent('owner',agent.id,{computer:'local',desktopHost:HOST_A})
 drive()
 driveRemote(HOST_A,{...host,name:'客厅 Mac'})
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:'本机'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')
 expect(JSON.parse(view.content[1].text).host).toBe('测试 Mac')
})
it('deviceContextLine names the messaging host',()=>{
 drive()
 driveRemote(HOST_A,{...host,name:'客厅 Mac'})
 expect(service.deviceContextLine('owner',HOST_A)).toContain('客厅 Mac')
 expect(service.deviceContextLine('owner',HOST_A)).toContain('本机')
 expect(service.onlineHostsLine('owner',HOST_A)).toContain('本机')
})

it('never falls back when the sending computer is unknown, disconnected or disabled',async()=>{
 drive()
 driveRemote(HOST_A,{...host,id:randomUUID(),name:'发送电脑'})
 for(const args of [{},{host:'本机'},{host:'local'}]){
  await expect(service.call('owner',agent.id,'desktop_environment_view',args,new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent))).rejects.toMatchObject({code:'desktop_source_required'})
 }
 service.dropHost(HOST_A)
 for(const args of [{},{host:'本机'}])await expect(service.call('owner',agent.id,'desktop_environment_view',args,new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)).rejects.toMatchObject({code:'desktop_offline'})
 driveRemote(HOST_A,{...host,id:randomUUID(),name:'发送电脑'})
 saveHostTools(home,{scriptMachine:false,serverComputer:true})
 await expect(service.call('owner',agent.id,'desktop_environment_view',{},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)).rejects.toMatchObject({code:'desktop_host_disabled'})
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:'服务器'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A)
 expect(JSON.parse(view.content[1].text).host).toBe('测试 Mac')
})
it('can use files and commands without screen or accessibility authorization',async()=>{
 host.screen=false;host.accessibility=false;host.approved=[];host.full=[ownerKey('owner')]
 const seen:any[]=[];drive(c=>{seen.push(c);return {ok:true}})
 expect(service.envTools('owner',agent)).toEqual({view:false,browser:false,file:true})
 for(const [id,args] of [['desktop_file_read',{path:'notes.txt'}],['desktop_shell',{command:'pwd'}]] as const){
  await expect(service.call('owner',agent.id,id,args,new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')).resolves.toEqual({ok:true})
 }
 expect(seen.map(c=>c.operation)).toEqual(['file','shell'])
 await expect(service.call('owner',agent.id,'desktop_environment_view',{},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')).rejects.toMatchObject({code:'desktop_permission_required'})
})
it('keeps concurrent message origins separate and lets explicit targets override them',async()=>{
 drive();driveRemote(HOST_A,{...host,id:randomUUID(),name:'电脑 A'});driveRemote(HOST_B,{...host,id:randomUUID(),name:'电脑 B'})
 const view=(source:string,args:object={})=>service.call('owner',agent.id,'desktop_environment_view',args,new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),source).then(v=>JSON.parse(v.content[1].text).host)
 expect(await Promise.all([view(HOST_A),view(HOST_B),view(HOST_A,{host:'server'})])).toEqual(['电脑 A','电脑 B','测试 Mac'])
})

it('rejects malformed or ambiguous explicit targets instead of using the message source',async()=>{
 drive();driveRemote(HOST_A,{...host,id:randomUUID(),name:'重复名称'});driveRemote(HOST_B,{...host,id:randomUUID(),name:'重复名称'})
 for(const target of [17,null,''])await expect(service.call('owner',agent.id,'desktop_environment_view',{host:target},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')).rejects.toMatchObject({status:400})
 await expect(service.call('owner',agent.id,'desktop_environment_view',{host:'重复名称'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')).rejects.toMatchObject({code:'desktop_host_ambiguous'})
 const view=await service.call('owner',agent.id,'desktop_environment_view',{host:HOST_A},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),'local')
 expect(JSON.parse(view.content[1].text).host).toBe('重复名称')
})

it('routes chunk copies from any connected computer to the Bot VM and snapshots the configured limit',async()=>{
 host.full=[ownerKey('owner')];host.fileTransferVersion=1
 const bytes=Buffer.alloc(524289,9),sha256=createHash('sha256').update(bytes).digest('hex'),actions:any[]=[]
 driveRemote(HOST_A,{...host,name:'书房'},c=>{
  const a=c.action;actions.push(a)
  if(a.op==='transfer-read-open'){saveHostTools(home,{fileTransferMaxMiB:1});return {size:bytes.length,sha256,path:a.path}}
  if(a.op==='transfer-read')return {offset:a.offset,data:bytes.subarray(a.offset,a.offset+524288).toString('base64')}
  return {ok:true}
 })
 saveHostTools(home,{fileTransferMaxMiB:2})
 const received:Buffer[]=[],vmActions:any[]=[]
 const vm=async(a:Record<string,any>)=>{
  vmActions.push(a)
  if(a.op==='transfer-write-open')return {}
  if(a.op==='transfer-append'){received.push(Buffer.from(a.data,'base64'));return {received:Buffer.concat(received).length}}
  if(a.op==='transfer-finish')return {complete:true,path:'target.bin',size:bytes.length,sha256}
  return {ok:true}
 }
 const result=await service.call('owner',agent.id,'desktop_file_copy',{sourceHost:HOST_A,sourcePath:'source.bin',targetHost:'vm',targetPath:'target.bin'},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A,vm)
 expect(result).toMatchObject({copied:true,target:{host:'vm'}})
 expect(vmActions[0]).toMatchObject({maxBytes:2*1024*1024,path:'target.bin',overwrite:false})
 expect(Buffer.concat(received).equals(bytes)).toBe(true)
 expect(actions.filter(a=>a.op==='transfer-read')).toHaveLength(2)
 expect(actions.at(-1).op).toBe('transfer-abort')
 await expect(service.call('owner',agent.id,'desktop_file_copy',{sourceHost:HOST_A,sourcePath:'source.bin',targetHost:'vm',targetPath:'target.bin',maxBytes:100*1024*1024},new AbortController().signal,()=>{},'local',service.hostEpochs('owner',agent),HOST_A,vm)).rejects.toThrow()
})

it('lists stable tool targets and separate per-host capabilities without claiming browser availability', () => {
 const filesOnly = { ...host, id: randomUUID(), name: '同名电脑', screen: false, accessibility: false, approved: [], full: [ownerKey('owner')] }
 service.exchange({ host: { ...host, name: '同名电脑' }, results: [] })
 service.remoteExchange(HOST_A, { host: filesOnly, results: [] })
 service.remoteExchange(HOST_B, { host: { ...host, id: randomUUID(), name: 'Linux', platform: 'linux', full: [ownerKey('owner')] }, results: [] })
 const text = service.onlineHostsLine('owner', HOST_A)
 expect(text).toContain('host="server"')
 expect(text).toContain(`host="${HOST_A}"`)
 expect(text).toContain('电脑·本机')
 expect(text).toContain('屏幕控制=就绪；文件与命令=未授权')
 expect(text).toContain('屏幕控制=未授权；文件与命令=就绪')
 expect(text).toContain('屏幕控制=不支持；文件与命令=不支持')
 expect(text).not.toContain('浏览器可用')
 const ungranted = service.onlineHostsLine('other', HOST_A)
 expect(ungranted).not.toContain('=就绪')
 saveHostTools(home, { scriptMachine: false })
 expect(service.snapshot('owner', agent, HOST_A).hosts.find(host => host.id === HOST_A)?.capabilities.shell.status).toBe('disabled')
 expect(service.onlineHostsLine('owner', HOST_A)).toContain('host="server"')
})

const environmentMetadata={version:1 as const,osRelease:'25.0.0',arch:'arm64',shell:'/bin/zsh',homeDirectory:'/Users/fixture',defaultCwd:'/Users/fixture',fileRoots:['/Users/fixture'],shellScope:'user' as const,timezone:'Asia/Shanghai'}
it('snapshots negotiated host facts per owner without inventing paths for old clients',()=>{
 const result=service.exchange({host:{...host,full:[ownerKey('owner')],fileTransferVersion:1,environment:environmentMetadata},results:[]})
 expect(result.capabilities).toEqual({environmentMetadata:1})
 service.remoteExchange(HOST_A,{host:{...host,id:randomUUID(),name:'旧客户端'},results:[]})
 const snapshot=service.snapshot('owner',agent,'local'),server=snapshot.hosts.find(host=>host.id==='local')!
 expect(server.metadata).toEqual(environmentMetadata)
 expect(server.capabilities.shell).toEqual({enabled:true,status:'ready'})
 expect(server.transfer).toEqual({protocol:'chunked',readMaxMiB:25,writeMaxMiB:25})
 expect(snapshot.hosts.find(host=>host.id===HOST_A)?.metadata).toBeUndefined()
 expect(JSON.stringify(service.snapshot('other',agent,'local'))).not.toContain('/Users/fixture')
 expect(JSON.stringify(snapshot)).not.toContain(ownerKey('owner'))
 server.metadata!.fileRoots!.push('/changed')
 expect(service.snapshot('owner',agent).hosts.find(host=>host.id==='local')?.metadata?.fileRoots).toEqual(['/Users/fixture'])
})

it('keeps offline and disabled registered computers visible with actionable reasons',()=>{
 store.put('_system','desktop-host',HOST_B,{id:HOST_B,name:'尚未连接',enabled:false,tokenHash:'private',createdAt:1})
 service.remoteExchange(HOST_A,{host:{...host,id:randomUUID(),name:'连接电脑',full:[ownerKey('owner')],environment:environmentMetadata},results:[]})
 const saved=service.snapshot('owner',agent,HOST_A)
 vi.useFakeTimers();vi.advanceTimersByTime(16000)
 const offline=service.snapshot('owner',agent,HOST_A)
 expect(offline.hosts.find(host=>host.id===HOST_A)).toMatchObject({source:true,online:false,capabilities:{shell:{enabled:false,status:'offline'}}})
 expect(offline.hosts.find(host=>host.id===HOST_A)?.metadata).toBeUndefined()
 expect(offline.hosts.find(host=>host.id===HOST_B)).toMatchObject({name:'尚未连接',open:false,capabilities:{view:{enabled:false,status:'disabled'}}})
 expect(saved.hosts.find(host=>host.id===HOST_A)?.capabilities.shell.status).toBe('ready')
 expect(service.deviceContextLine('owner',HOST_A)).toContain('不能回退到服务器')
 expect(JSON.stringify(offline)).not.toContain('private')
})

it('distinguishes human takeover from grants and rechecks revocation after collecting a snapshot',async()=>{
 host.full=[ownerKey('owner')];drive()
 const ticket=await take(),snapshot=service.snapshot('owner',agent,'local'),server=snapshot.hosts[0]!
 expect(server.capabilities.shell).toEqual({enabled:true,status:'human_control'})
 await request(app()).post(base()+'/computer/giveback').send({controlId:ticket.controlId,token:ticket.token}).expect(200)
 expect(service.snapshot('owner',agent).hosts[0]?.capabilities.shell.status).toBe('ready')
 host.full=[];service.exchange({host,results:[]})
 const epochs=Object.fromEntries(snapshot.hosts.map(host=>[host.id,host.epoch!]))
 await expect(service.call('owner',agent.id,'desktop_file_list',{host:'server',path:'.'},new AbortController().signal,()=>{},'local',epochs,'local')).rejects.toMatchObject({code:'desktop_full_required'})
 expect(snapshot.hosts[0]?.capabilities.shell.enabled).toBe(true)
 expect(service.snapshot('owner',agent).hosts[0]?.capabilities.shell).toEqual({enabled:false,status:'not_authorized'})
})

it('rejects malformed metadata without replacing the last admitted host state',()=>{
 service.exchange({host,results:[]})
 expect(()=>service.exchange({host:{...host,environment:{...environmentMetadata,homeDirectory:'bad\npath'}},results:[]})).toThrow()
 expect(service.snapshot('owner',agent).hosts[0]?.epoch).toBe(host.id)
 expect(service.snapshot('owner',agent).hosts[0]?.metadata).toBeUndefined()
})

it('does not dispatch to a newly connected target outside the captured host set',async()=>{
 drive()
 const snapshot=service.snapshot('owner',agent,'local'),epochs=Object.fromEntries(snapshot.hosts.map(host=>[host.id,host.epoch!]))
 const commands:unknown[]=[]
 driveRemote(HOST_A,{...host,id:randomUUID()},command=>{commands.push(command);return {ok:true}})
 await expect(service.call('owner',agent.id,'desktop_environment_view',{host:HOST_A},new AbortController().signal,()=>{},'local',epochs,'local')).rejects.toMatchObject({code:'desktop_context_changed'})
 expect(commands).toEqual([])
})
