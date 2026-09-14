// @vitest-environment node
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {ChatCacheStore,ChatCacheCoordinator} from '../../src/server/chatCache.js'
import type {UpstreamServiceSession} from '../../src/server/localAuth.js'
const fixtures:Array<{home:string;store:ChatCacheStore;coordinator:ChatCacheCoordinator}>=[]
function setup(){const home=mkdtempSync(join(tmpdir(),'ordinary-local-')),store=new ChatCacheStore(home),request=vi.fn();const coordinator=new ChatCacheCoordinator(store,{request} as unknown as UpstreamServiceSession);fixtures.push({home,store,coordinator});return{store,coordinator,request,home}}
afterEach(()=>{for(const f of fixtures.splice(0)){f.coordinator.close();if(!f.store.isClosed)f.store.close();rmSync(f.home,{recursive:true,force:true})}})
function json(r:{response:{body:Buffer}}){return JSON.parse(r.response.body.toString())}
describe('ordinary chat authoritative local reads',()=>{
 it('persists a complete streaming turn without upstream reads, including repeated chunks',()=>{
  const {store,coordinator,request}=setup();store.recordCommand('o','p','s','session.create',{source:'ios'})
  store.recordCommand('o','p','s','prompt.submit',{text:'问题',_delivery_id:'submit-1'})
  const send=(type:string,payload:object,delivery_id:string)=>coordinator.observe('o','p','s',{type,payload,delivery_id})
  send('message.start',{message_id:'a'},'1');send('reasoning.delta',{delta:'思考'},'2')
  send('message.delta',{delta:'哈'},'3');send('message.delta',{delta:'哈'},'4');send('message.delta',{delta:'哈'},'4')
  send('tool.start',{tool_id:'t',name:'read',arguments:{path:'a'}},'5');send('tool.complete',{tool_id:'t',result:'ok'},'6')
  send('message.complete',{},'7')
  const page=json(coordinator.readLocal('o','messages','p','s',{limit:20}))
  expect(page.messages).toHaveLength(2);expect(page.messages[1]).toMatchObject({content:'哈哈',reasoning:'思考',status:'complete',tool_calls:[{id:'t',result:'ok'}]})
  expect(json(coordinator.readLocal('o','list','p',undefined,{})).sessions[0].message_count).toBe(2)
  expect(request).not.toHaveBeenCalled()
  store.close();const reopened=new ChatCacheStore(fixtures.at(-1)!.home);expect(JSON.parse(reopened.messagePage('o','p','s',0,20)!.response.body.toString()).messages).toEqual(page.messages);reopened.close()
 })
 it('keeps sequence-less identical deltas and interim segments independently',()=>{
  const {store,coordinator}=setup();store.recordCommand('o','p','s','session.create',{})
  for(const [type,payload] of [['message.delta',{text:'ha'}],['message.delta',{text:'ha'}],['message.interim',{}],['message.delta',{text:'done'}],['message.complete',{}]] as const)coordinator.observe('o','p','s',{type,payload})
  const page=json(coordinator.readLocal('o','messages','p','s',{}));expect(page.messages.map((m:any)=>m.content)).toEqual(['haha','done'])
 })
 it('isolates preferences and clamps monotonic read cursors locally',()=>{
  const {store,coordinator,request}=setup();store.recordCommand('o','p','s','session.create',{});coordinator.observe('o','p','s',{type:'message.delta',payload:{text:'a'}})
  store.patchLocal('o','p','s',{pinned:true,title:'标题'});expect(store.pins('o','p')).toEqual(['s']);expect(store.pins('other','p')).toEqual([])
  expect(store.unread('o','p').total_unread).toBe(1);store.markRead('o','p','s',900);store.markRead('o','p','s',0);expect(store.unread('o','p').total_unread).toBe(0)
  expect(()=>coordinator.readLocal('other','messages','p','s',{})).toThrow('会话不存在');expect(request).not.toHaveBeenCalled()
 })
 it('returns cached data immediately and reports a missing page without awaiting repair',()=>{
  const {store,coordinator,request}=setup();store.recordRoute('o','p','legacy','r')
  expect(json(coordinator.readLocal('o','list','p',undefined,{})).sessions).toHaveLength(1)
  expect(()=>coordinator.readLocal('o','messages','p','legacy',{})).toThrow('历史正在后台补齐')
  expect(request).not.toHaveBeenCalled()
 })
 it('keeps newer local pin settings when remote metadata is ingested',()=>{
  const {store}=setup();store.recordCommand('o','p','s','session.create',{});store.patchLocal('o','p','s',{pinned:true})
  store.putSnapshot('o','d','detail','p','s',{status:200,headers:new Headers(),body:Buffer.from(JSON.stringify({id:'s',pinned:false,message_count:0}))})
  expect(store.pins('o','p')).toEqual(['s']);expect(JSON.parse(store.localList('o','p',{}).body.toString()).sessions[0].pinned).toBe(true)
 })
})

describe('ordinary chat migration and bounded recovery',()=>{
 it('refreshes invalidated remote titles in the background without refetching complete message history',async()=>{
   const {store,coordinator,request}=setup()
   store.recordCommand('o','p','s','session.create',{})
   store.recordCommand('other','p','private','session.create',{})
   request.mockResolvedValue({status:200,headers:new Headers(),body:Buffer.from(JSON.stringify({id:'s',title:'远端自动标题',message_count:0,messages:[{id:'unrelated',role:'assistant',content:'do not import a metadata response as history'}]}))})
   coordinator.observeGlobal('o','sessions.changed',true)
   expect(json(coordinator.readLocal('o','list','p',undefined,{})).sessions).toHaveLength(1)
   expect(request).not.toHaveBeenCalled()
   await vi.waitFor(()=>expect(json(coordinator.readLocal('o','list','p',undefined,{})).sessions[0].title).toBe('远端自动标题'))
   expect(request).toHaveBeenCalledTimes(1)
   expect(request.mock.calls[0]![0]).toBe('/api/sessions/s')
   expect(store.db.prepare('SELECT * FROM chat_messages').all()).toHaveLength(0)
   store.patchLocal('o','p','s',{title:'本地手动标题'})
   coordinator.observeGlobal('o','sessions.changed',true)
   await vi.waitFor(()=>expect(store.db.prepare('SELECT * FROM chat_recovery_jobs').all()).toHaveLength(0))
   expect(json(coordinator.readLocal('o','list','p',undefined,{})).sessions[0].title).toBe('本地手动标题')
   const reads=request.mock.calls.length
   coordinator.observeGlobal('o','sessions.changed')
   coordinator.readLocal('o','list','p',undefined,{})
   await new Promise(resolve=>setTimeout(resolve,10))
   expect(request).toHaveBeenCalledTimes(reads)
 })
 it('preserves local messages and pins when a live session becomes a compressed tip',()=>{
   const {store,coordinator}=setup();store.recordRoute('o','p','old','runtime');store.recordCommand('o','p','old','session.create',{})
   coordinator.observe('o','p','old',{type:'message.delta',payload:{text:'kept'},delivery_id:'one'})
   store.patchLocal('o','p','old',{pinned:true,title:'local'})
   store.recordRoute('o','p','new','runtime')
   expect(store.canonicalSessionID('o','p','old')).toBe('new')
   expect(json(coordinator.readLocal('o','messages','p','old',{})).messages[0].content).toBe('kept')
   expect(store.pins('o','p')).toEqual(['new'])
   expect(store.canonicalSessionID('other','p','old')).toBe('old')
 })
 it('limits background repair to two concurrent conversations',async()=>{
   const {store,coordinator,request}=setup();let active=0,maximum=0
   request.mockImplementation(async(path:string)=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,10));active--;
     return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(path.endsWith('/messages')?{messages:[],pagination:{total:0,has_more:false}}:{id:path.split('/').at(-1),message_count:0}))}})
   for(let i=0;i<5;i++){store.recordRoute('o','p',`legacy-${i}`,`r-${i}`);coordinator.schedule('o','p',`legacy-${i}`)}
   await vi.waitFor(()=>expect(store.db.prepare('SELECT * FROM chat_recovery_jobs').all()).toHaveLength(0))
   expect(maximum).toBe(2)
 })
 it('promotes an assistant identity without creating a second history row',()=>{
   const {store,coordinator}=setup();store.recordCommand('o','p','s','session.create',{})
   coordinator.observe('o','p','s',{type:'message.delta',payload:{text:'hello'},delivery_id:'delta'})
   const stableID=store.transcripts.all('o','p','s')[0]!.id
   coordinator.observe('o','p','s',{type:'message.complete',payload:{message_id:'canonical',text:'hello'},delivery_id:'done'})
   const page=json(coordinator.readLocal('o','messages','p','s',{}));expect(page.messages).toHaveLength(1);expect(page.messages[0]).toMatchObject({id:stableID,source_message_id:'canonical'})
 })
})
