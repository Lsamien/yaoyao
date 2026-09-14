// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatCacheStore, ChatCacheCoordinator } from '../../src/server/chatCache'
import { applyTranscriptEvent, type TranscriptSnapshot } from '../../src/shared/chatTranscript'
import type { UpstreamServiceSession } from '../../src/server/localAuth'

const fixtures:Array<{home:string;store:ChatCacheStore;cache:ChatCacheCoordinator}>=[]
function fixture(){const home=mkdtempSync(join(tmpdir(),'ordinary-transcript-')),store=new ChatCacheStore(home),cache=new ChatCacheCoordinator(store,{request:vi.fn()} as unknown as UpstreamServiceSession);fixtures.push({home,store,cache});return {home,store,cache}}
afterEach(()=>{for(const f of fixtures.splice(0)){f.cache.close();if(!f.store.isClosed)f.store.close();rmSync(f.home,{recursive:true,force:true})}})
function snapshot(store:ChatCacheStore,id='s',owner='owner'):TranscriptSnapshot {
  store.transcripts.seed(owner,'p',id)
  const detail=store.localDetail(owner,'p',id)!
  return store.transcripts.snapshot(owner,'p',id,JSON.parse(detail.response.body.toString()),detail.state)
}
describe('ordinary server-owned transcript',()=>{
  it('preserves interim text, reasoning, tool results and final text as separate records',()=>{
    const {store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    store.recordCommand('owner','p','s','prompt.submit',{text:'问题',_delivery_id:'ios:prompt:user-one'})
    let n=0
    const send=(type:string,payload:object)=>cache.observe('owner','p','s',{type,payload,delivery_id:`event-${++n}`})
    send('message.start',{})
    send('reasoning.delta',{text:'先思考'})
    send('message.interim',{text:'先检查文件'})
    send('tool.start',{tool_id:'tool-one',name:'read_file'})
    send('tool.complete',{tool_id:'tool-one',result:'完整工具输出'})
    send('message.delta',{text:'最终答案'})
    send('message.complete',{text:'最终答案'})
    const value=snapshot(store)
    expect(value.messages.map(m=>m.content)).toEqual(['问题','先检查文件','最终答案'])
    expect(value.messages[1]!.reasoning).toBe('先思考')
    expect(value.messages[2]!.tool_calls).toMatchObject([{id:'tool-one',result:'完整工具输出'}])
    expect(new Set(value.messages.map(m=>m.id)).size).toBe(3)
    expect(value.messages.map(m=>m.seq)).toEqual([1,2,3])
  })
  it('keeps a queued prompt from detaching the currently streaming assistant',()=>{
    const {store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    store.recordCommand('owner','p','s','prompt.submit',{text:'第一问',_delivery_id:'ios:prompt:first'})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'前半'},delivery_id:'one'})
    const assistant=snapshot(store).messages.find(m=>m.role==='assistant')!
    store.recordCommand('owner','p','s','prompt.submit',{text:'排队的第二问',_delivery_id:'ios:prompt:second'})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'后半'},delivery_id:'two'})
    expect(snapshot(store).messages.find(m=>m.id===assistant.id)?.content).toBe('前半后半')
    expect(snapshot(store).messages.filter(m=>m.role==='assistant')).toHaveLength(1)
  })
  it('commits replayable append patches and ignores duplicate deliveries',()=>{
    const {store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'中文'},delivery_id:'one'})
    const base=snapshot(store),id=base.messages[0]!.id
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'🙂'},delivery_id:'two'})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'🙂'},delivery_id:'two'})
    const events=store.transcripts.events('owner','p','s',base.cursor)
    expect(events).toHaveLength(1);expect(events[0]!.type).toBe('message.patch')
    const replay=events.reduce(applyTranscriptEvent,base.messages)
    expect(replay).toEqual(snapshot(store).messages)
    expect(replay[0]).toMatchObject({id,content:'中文🙂',revision:base.messages[0]!.revision+1})
    expect(applyTranscriptEvent(replay,events[0]!)).toEqual(replay)
  })
  it('retains stable message identity when an upstream row ID becomes known',()=>{
    const {store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'回复'},delivery_id:'one'})
    const before=snapshot(store).messages[0]!
    cache.observe('owner','p','s',{type:'message.complete',payload:{message_id:'upstream-42',text:'完整回复'},delivery_id:'two'})
    expect(snapshot(store).messages).toHaveLength(1)
    expect(snapshot(store).messages[0]).toMatchObject({id:before.id,seq:before.seq,source_message_id:'upstream-42',content:'完整回复',status:'complete'})
  })
  it('rolls back content and event log together when durable event storage fails',async()=>{
    const {store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    const listener=vi.fn();store.transcripts.subscribe(listener)
    store.db.exec("CREATE TRIGGER fail_transcript_event BEFORE INSERT ON chat_transcript_events BEGIN SELECT RAISE(ABORT,'disk full'); END")
    expect(()=>cache.observe('owner','p','s',{type:'message.delta',payload:{text:'不能发布'},delivery_id:'fail'})).toThrow('disk full')
    await Promise.resolve()
    expect(store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get()!.n).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) n FROM chat_transcript_messages').get()!.n).toBe(0)
    expect(store.transcripts.events('owner','p','s',0)).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })
  it('replays committed events after server restart without resubmitting prompts',()=>{
    const {home,store,cache}=fixture();store.recordCommand('owner','p','s','session.create',{})
    cache.observe('owner','p','s',{type:'message.delta',payload:{text:'开始'},delivery_id:'one'})
    const before=snapshot(store)
    cache.observe('owner','p','s',{type:'message.complete',payload:{text:'结束'},delivery_id:'two'})
    const after=snapshot(store);cache.close();store.close()
    const reopened=new ChatCacheStore(home)
    try{expect(reopened.transcripts.epochFor('owner','p','s')).toBe(before.epoch);expect(reopened.transcripts.events('owner','p','s',before.cursor).reduce(applyTranscriptEvent,before.messages)).toEqual(after.messages)}finally{reopened.close()}
  })
  it('keeps owner/session scopes and history pagination independent',()=>{
    const {store,cache}=fixture()
    for(const owner of ['owner','other'])for(const id of ['s','t']){
      store.recordCommand(owner,'p',id,'session.create',{})
      for(let i=0;i<5;i++)store.recordCommand(owner,'p',id,'prompt.submit',{text:`${owner}:${id}:${i}`,_delivery_id:`${owner}:${id}:${i}`})
    }
    snapshot(store)
    const detail=store.localDetail('owner','p','s')!
    const tail=store.transcripts.snapshot('owner','p','s',{},detail.state,Number.MAX_SAFE_INTEGER,2)
    const old=store.transcripts.snapshot('owner','p','s',{},detail.state,tail.messages[0]!.seq,2)
    expect(tail.messages.map(m=>m.content)).toEqual(['owner:s:3','owner:s:4'])
    expect(old.messages.map(m=>m.content)).toEqual(['owner:s:1','owner:s:2'])
    expect(store.transcripts.events('unknown','p','s',0)).toEqual([])
    cache.close()
  })
})
