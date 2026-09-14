import Router from '@koa/router'
import type Koa from 'koa'
import type { ChatCacheCoordinator } from './chatCache.js'
import type { LocalAuthStore } from './localAuth.js'
import { HttpError } from './errors.js'
import { CHAT_TRANSCRIPT_FEATURE } from '../shared/chatTranscript.js'

export function chatTranscriptRouter(cache:ChatCacheCoordinator,auth:LocalAuthStore):Router {
  const router=new Router(),store=cache.store,transcripts=store.transcripts
  const scope=(ctx:Koa.Context)=>{
    const owner=auth.require(ctx).id,profile=String(ctx.query.profile??'default'),requested=ctx.params.id
    if(!profile||profile.length>256||!requested||requested.length>256)throw new HttpError(400,'会话标识无效','invalid_session')
    const id=store.canonicalSessionID(owner,profile,requested)
    store.requireOwned(owner,profile,id)
    if(!auth.canUseSource(owner,'local',profile))throw new HttpError(403,'没有此 Profile 的权限','profile_forbidden')
    ctx.set('Cache-Control','no-store')
    return {owner,profile,id}
  }
  router.get('/api/app/chat/capabilities',ctx=>{auth.require(ctx);ctx.set('Cache-Control','no-store');ctx.body={features:transcripts.enabled?[CHAT_TRANSCRIPT_FEATURE]:[],epoch:transcripts.epoch}})
  router.get('/api/app/chat/sessions/:id/snapshot',ctx=>{
    const {owner,profile,id}=scope(ctx)
    const before=ctx.query.before===undefined?Number.MAX_SAFE_INTEGER:Number(ctx.query.before),limit=ctx.query.limit===undefined?150:Number(ctx.query.limit)
    if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new HttpError(400,'历史分页参数无效','invalid_page')
    const total=Number(JSON.parse(store.localDetail(owner,profile,id)!.response.body.toString()).message_count??0)
    const offset=before===Number.MAX_SAFE_INTEGER?0:Math.max(0,total-(before-1))
    if(!store.messagePage(owner,profile,id,offset,before===Number.MAX_SAFE_INTEGER?limit:Math.min(limit,before-1))){cache.schedule(owner,profile,id,true);throw new HttpError(409,'历史正在后台补齐','CHAT_HISTORY_SYNC_PENDING')}
    cache.readLocal(owner,'messages',profile,id,{limit:1})
    store.db.exec('SAVEPOINT transcript_snapshot')
    try{
      transcripts.seed(owner,profile,id)
      const detail=store.localDetail(owner,profile,id)!
      ctx.body=transcripts.snapshot(owner,profile,id,JSON.parse(detail.response.body.toString()),detail.state,before,limit)
      store.db.exec('RELEASE transcript_snapshot')
    }catch(error){store.db.exec('ROLLBACK TO transcript_snapshot; RELEASE transcript_snapshot');throw error}
  })
  router.get('/api/app/chat/sessions/:id/events',ctx=>{
    const {owner,profile,id}=scope(ctx),version=auth.pushAuthorizationVersion(owner)
    const raw=ctx.get('last-event-id')||String(ctx.query.after??''),parts=raw.split(':')
    let cursor=Number(parts.at(-1)),closed=false,lastFlush=0
    if(parts.length!==2||parts[0]!==transcripts.epoch||!Number.isSafeInteger(cursor)||cursor<0||cursor>transcripts.cursor(owner,profile,id))throw new HttpError(409,'聊天事件需要重新同步','transcript_reset')
    const res=ctx.res
    let timer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,off=()=>{}
    const valid=()=>!store.isClosed&&auth.isUserActive(owner)&&auth.pushAuthorizationVersion(owner)===version&&auth.current(ctx)?.id===owner&&store.ownsSession(owner,profile,id)&&auth.canUseSource(owner,'local',profile)
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);clearInterval(heartbeat);off();if(!res.writableEnded)res.end()}
    const write=(value:string)=>{
      if(closed||res.destroyed||!valid()){close();return false}
      if(res.writableLength+Buffer.byteLength(value)>4*1024*1024){res.write('event: reset\ndata: {}\n\n');close();return false}
      res.write(value);return true
    }
    const flush=()=>{
      clearTimeout(timer);timer=undefined
      if(!valid()){close();return}
      const events=transcripts.events(owner,profile,id,cursor)
      for(const event of events){if(!write(`id: ${transcripts.epoch}:${event.cursor}\nevent: transcript\ndata: ${JSON.stringify(event)}\n\n`))return;cursor=event.cursor}
      if(events.length)lastFlush=Date.now()
      if(events.length===250)timer=setTimeout(flush,0)
    }
    const changed=()=>{
      if(closed)return
      const events=transcripts.events(owner,profile,id,cursor)
      if(!events.length)return
      if(events.some(event=>event.type!=='message.patch')||Date.now()-lastFlush>=33)flush()
      else if(timer===undefined)timer=setTimeout(flush,Math.max(0,33-(Date.now()-lastFlush)))
    }
    ctx.respond=false
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'})
    res.flushHeaders();res.once('close',close);res.once('error',close)
    off=transcripts.subscribe(changed)
    flush();write(`event: ready\ndata: ${JSON.stringify({epoch:transcripts.epoch,cursor})}\n\n`)
    heartbeat=setInterval(()=>{if(valid())write(': heartbeat\n\n');else close()},15_000);heartbeat.unref()
  })
  return router
}
