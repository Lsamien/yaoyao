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
    const coverage=store.db.prepare('SELECT complete FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,id)
    if(!coverage?.complete||store.needsListMetadata(owner,profile)||store.localDetail(owner,profile,id)?.state==='gap')cache.schedule(owner,profile,id)
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
    transcripts.seed(owner,profile,id)
    const epoch=transcripts.epochFor(owner,profile,id)
    if(parts.length!==2||parts[0]!==epoch||!Number.isSafeInteger(cursor)||cursor<0||cursor>transcripts.cursor(owner,profile,id))throw new HttpError(409,'聊天事件需要重新同步','transcript_reset')
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
      if(transcripts.epochFor(owner,profile,id)!==epoch){write('event: reset\ndata: {}\n\n');close();return}
      const events=transcripts.events(owner,profile,id,cursor)
      for(const event of events){if(event.epoch!==epoch){write('event: reset\ndata: {}\n\n');close();return}if(!write(`id: ${epoch}:${event.cursor}\nevent: transcript\ndata: ${JSON.stringify(event)}\n\n`))return;cursor=event.cursor}
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
    const control=()=>({epoch,cursor:transcripts.cursor(owner,profile,id),...transcripts.control(owner,profile,id)})
    flush();write(`event: ready\ndata: ${JSON.stringify(control())}\n\n`)
    heartbeat=setInterval(()=>{
      if(!valid()){close();return}
      if(transcripts.epochFor(owner,profile,id)!==epoch){write('event: reset\ndata: {}\n\n');close();return}
      write(`event: state\ndata: ${JSON.stringify(control())}\n\n`)
    },5_000);heartbeat.unref()
  })
  return router
}
