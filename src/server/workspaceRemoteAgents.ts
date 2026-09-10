import type Koa from 'koa'
import { Readable } from 'node:stream'
import { HttpError } from './errors.js'
import type { LocalAuthStore } from './localAuth.js'
import type { NodePairingStore } from './pairing.js'
import type { WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceNodes, GatewayTarget } from './workspaceGateway.js'
import type { WorkspaceAgent } from '../shared/workspace.js'

export interface AgentExportContext {
  id: string
  target: GatewayTarget
  valid(): boolean
  transform(frame: Record<string, any>): Record<string, any>
}
const allowedCommands = new Set(['session.create','session.resume','session.close','session.usage','session.interrupt','prompt.submit','session.steer','image.attach_bytes','file.attach','approval.respond','clarify.respond'])

/** A paired device sees only Agents owned by the account that issued its QR grant. */
export function remoteAgentExports(store: WorkspaceStore, nodes: WorkspaceNodes, pairings: NodePairingStore, auth: LocalAuthStore): Koa.Middleware {
  return async (ctx,next) => {
    const match = /^\/node\/([0-9a-f-]{36})\/api\/workspace-agents(?:\/([0-9a-f-]{36})(?:\/gateway(\/api\/.*))?)?$/.exec(ctx.path)
    if (!match) return next()
    const device=match[1]!, agentId=match[2], path=match[3], token=ctx.get('authorization').match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
    const owner=pairings.workspaceOwner(device,token,path ? 'sessions.execute' : 'agents.read')
    if (!auth.isUserActive(owner)) throw new HttpError(403,'远端授权账号已停用','remote_owner_unavailable')
    const valid = () => {
      try { return pairings.workspaceOwner(device,token,'sessions.execute')===owner && auth.isUserActive(owner)
        && (!agentId || store.get<WorkspaceAgent>(owner,'agent',agentId)?.archived === false) }
      catch { return false }
    }
    ctx.set('Cache-Control','no-store')
    if (!agentId) {
      if (ctx.method!=='GET') throw new HttpError(405,'只允许读取远端机器人','method_not_allowed')
      const agents=store.list<WorkspaceAgent>(owner,'agent').filter(a=>!a.archived)
      for(const value of agents) if(value.remoteAgentId) void nodes.refreshRemoteAgent(owner,value).catch(()=>{})
      ctx.body={agents:agents.map(a=>store.agentSummary(a))};return
    }
    let agent=store.require<WorkspaceAgent>(owner,'agent',agentId)
    if (agent.archived) throw new HttpError(410,'远端机器人已归档','remote_agent_archived')
    if (agent.remoteAgentId) agent=await nodes.refreshRemoteAgent(owner,agent)
    if (!path) {
      if (ctx.method!=='GET') throw new HttpError(405,'远端配置只读','method_not_allowed')
      ctx.body={agent:store.agentSummary(agent)};return
    }
    const hops=Number(ctx.get('x-yaoyao-agent-hops')||0)
    if (!Number.isInteger(hops) || hops<0 || hops>=8) throw new HttpError(508,'远端机器人引用链过长或循环','agent_reference_loop')
    const target=nodes.targetForAgent(owner,agent), scope=`${device}:${agentId}`
    const bindingKey=(id:string)=>`${scope}:${id}`
    const requireBinding=(id:string)=>{
      const binding=store.get<{profile:string}>(owner,'agent-export-binding',bindingKey(id))
      if (!binding || binding.profile!==agent.profile) throw new HttpError(403,'会话不属于这个机器人引用','agent_session_forbidden')
    }
    const transform=(frame:Record<string,any>)=>{
      if (!allowedCommands.has(frame.method)) throw new HttpError(403,'不能通过引用修改远端配置','remote_agent_read_only')
      const params={...frame.params}
      if (frame.method==='session.create' || frame.method==='session.resume') {
        if(frame.method==='session.resume') requireBinding(String(params.session_id))
        params.profile=agent.profile
        for (const key of ['model','provider','config','cwd','reasoning_effort','fast','messages']) delete params[key]
      }
      if ((frame.method==='prompt.submit'||frame.method==='session.steer') && !agent.remoteAgentId) {
        if (typeof params.text!=='string') throw new HttpError(400,'消息内容无效','invalid_prompt')
        params.text=`你是 ${agent.name}。远端机器人的角色与规则（版本 ${agent.revision}）：\n${agent.instructions}\n\n${params.text}`
      }
      const id=ctx.get('idempotency-key')
      if (id) store.put(owner,'agent-export-command',bindingKey(id),{method:frame.method,profile:agent.profile})
      return {...frame,params}
    }
    const remember=(receipt:any)=>{
      const id=ctx.get('idempotency-key') || /^\/api\/realtime\/commands\/([^/]+)$/.exec(path)?.[1]
      const command=id ? store.get<{method:string}>(owner,'agent-export-command',bindingKey(id)) : undefined
      if (!id || !command || !['session.create','session.resume'].includes(command.method)) return
      const result=receipt?.state==='confirmed' ? receipt.response?.result : undefined
      const stored=result?.stored_session_id ?? result?.session_key ?? result?.info?.stored_session_id ?? result?.session_id
      if (typeof stored==='string' && stored.length<=256) {
        store.put(owner,'agent-export-binding',bindingKey(stored),{profile:agent.profile})
      }
    }
    if (path==='/api/profiles' && ctx.method==='GET') { ctx.body={profiles:[{name:agent.profile,display_name:agent.name}]};return }
    if (path.startsWith('/api/realtime/')) {
      const selectedChannel=/^\/api\/realtime\/channels\/([0-9a-f-]{36})/.exec(path)?.[1]
      if (selectedChannel && !store.get(owner,'agent-export-channel',bindingKey(selectedChannel)))
        throw new HttpError(403,'通道不属于这个机器人引用','agent_channel_forbidden')
      const receiptID=/^\/api\/realtime\/commands\/([^/]+)$/.exec(path)?.[1]
      if (receiptID && !store.get(owner,'agent-export-command',bindingKey(receiptID)))
        throw new HttpError(403,'命令不属于这个机器人引用','agent_command_forbidden')
      const rememberChannel=(body:any)=>{
        if(ctx.method==='POST' && path==='/api/realtime/channels' && typeof body?.id==='string')
          store.put(owner,'agent-export-channel',bindingKey(body.id),{createdAt:Date.now()})
      }
      if (!target.pairedToken) {
        ctx.state.workspaceAgentExport={id:agentId,target,valid,transform} satisfies AgentExportContext
        const previous=ctx.url
        ctx.url=`/node/${device}${path}${ctx.search}`
        try { await next(); rememberChannel(ctx.body); remember(ctx.body) } finally { ctx.url=previous }
        return
      }
      const allowed=/^\/api\/realtime\/(capabilities|channels(?:\/[0-9a-f-]{36}(?:\/(events|commands))?)?|commands\/[A-Za-z0-9:_-]{1,200})$/.test(path)
      if (!allowed) throw new HttpError(404,'机器人实时路径不存在','not_found')
      let body: any
      if (ctx.method==='POST') {
        let size=0;const parts:Buffer[]=[]
        for await(const part of ctx.req) {size+=part.length;if(size>36*1024*1024) throw new HttpError(413,'请求过大','body_too_large');parts.push(Buffer.from(part))}
        try {body=JSON.parse(Buffer.concat(parts).toString())} catch {throw new HttpError(400,'JSON 无效','invalid_json')}
        if(path.endsWith('/commands')) body=transform(body)
        else if(body.channel!=='chat') throw new HttpError(403,'机器人仅支持聊天通道','invalid_channel')
      }
      const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),30_000)
      ctx.res.once('close',()=>abort.abort())
      let response: Response
      try {response=await target.client.fetchImpl(new URL(`${target.url.href.replace(/\/$/,'')}${path}${ctx.search}`),{
        method:ctx.method,redirect:'error',signal:abort.signal,
        headers:{Authorization:`Bearer ${target.pairedToken}`,'Content-Type':'application/json','Last-Event-ID':ctx.get('last-event-id'),'Idempotency-Key':ctx.get('idempotency-key'),'x-yaoyao-agent-hops':String(hops+1)},
        ...(body!==undefined ? {body:JSON.stringify(body)} : {}),
      })} finally {clearTimeout(timer)}
      ctx.status=response.status
      ctx.set('Content-Type',response.headers.get('content-type')||'application/json')
      if(response.headers.get('content-type')?.startsWith('text/event-stream') && response.body) {
        const interval=setInterval(()=>{if(!valid())abort.abort()},5000);interval.unref()
        ctx.res.once('close',()=>clearInterval(interval))
        const stream=Readable.fromWeb(response.body as any)
        stream.once('close',()=>clearInterval(interval));stream.once('error',()=>clearInterval(interval))
        ctx.body=stream
      }
      else if(response.status!==204) {ctx.body=await response.json();rememberChannel(ctx.body);remember(ctx.body)}
      return
    }
    if (ctx.method!=='GET') throw new HttpError(405,'机器人引用只允许读取文件与会话','method_not_allowed')
    pairings.authorize(device,token,'history.read')
    const history=/^\/api\/sessions\/([^/]+)\/messages$/.exec(path)
    if (history) requireBinding(decodeURIComponent(history[1]!))
    else if(path!=='/api/files/download') throw new HttpError(403,'路径不属于机器人引用','agent_path_forbidden')
    const query=new URLSearchParams(ctx.querystring);query.set('profile',agent.profile)
    const response=await target.session.request(path,{search:query,maxResponseBytes:25*1024*1024})
    ctx.status=response.status
    for(const name of ['content-type','content-disposition']) {const value=response.headers.get(name);if(value)ctx.set(name,value)}
    ctx.body=response.body
  }
}
