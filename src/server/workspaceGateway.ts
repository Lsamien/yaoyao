import WebSocket from 'ws'
import {requireSharedComputer} from './sharedComputers.js'
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UpstreamClient, CookieJar } from './upstream.js'
import { nodeJSON, nodeServiceURL, parseWorkspacePairCode, verifyNode, WorkspacePairedChannel } from './workspacePairedNode.js'
import { UpstreamServiceSession } from './localAuth.js'
import { WorkspaceStore, agentInput, parse } from './workspaceStore.js'
import { HttpError } from './errors.js'
import type { ServerConfig } from './config.js'
import type { WorkspaceSource, WorkspaceAgent, WorkspaceConversation } from '../shared/workspace.js'

export interface WorkspaceNode {
  id: string
  name: string
  url: string
  secret: string
  transport?: 'paired-web'
  remoteNodeId?: string
  fingerprint?: string
  deviceId?: string
}
export interface GatewayExecutionScope {workId:string;cleanupOnly?:boolean;sessionId?:string;authorize():void;publishArtifact?(name:string,bytes:Buffer):Promise<unknown>}
export interface GatewayTarget {
  url: URL
  client: UpstreamClient
  session: Pick<UpstreamServiceSession, 'request' | 'webSocketCredential'>
  pairedToken?: string
  runner?: {
    id: string
    computer?:boolean
    helperRetirement?:boolean
    open(onEvent:(frame:GatewayFrame)=>void,onDisconnect:()=>void,scope?:GatewayExecutionScope):Promise<{rpc(method:string,params:Record<string,unknown>):Promise<any>;close():void}>
    lease(input:import('./workspaceToolLease.js').LeaseInput):Promise<import('./workspaceToolLease.js').WorkspaceToolLease>
  }
}
export interface GatewayFrame {
  type: string
  session_id?: string
  payload?: Record<string, any>
}
export class WorkspaceNodes {
  runnerTarget?: (owner:string,nodeId:string,computer?:{environmentId:string;ownerKey:string;agentId:string})=>GatewayTarget|undefined
  sourceAllowed: (owner: string, nodeId: string, profile: string) => boolean = () => true
  requireSource(owner: string, agent: { id?:string;nodeId: string; profile: string;computerEnvironmentId?:string }): void {
    requireSharedComputer(this.store,owner,agent)
    if (!this.sourceAllowed(owner, agent.nodeId, agent.profile)) throw new HttpError(403, '基础 Agent 未分配给当前账号', 'agent_source_forbidden')
  }
  private readonly key: Buffer
  private targets = new Map<string, GatewayTarget>()
  private remoteCatalogs = new Map<string,{expires:number; value?:WorkspaceAgent[]; pending?:Promise<WorkspaceAgent[]>}>()
  private remoteRefreshes = new Map<string,Promise<WorkspaceAgent>>()
  constructor(
    readonly store: WorkspaceStore,
    readonly config: ServerConfig,
    readonly local: GatewayTarget,
    readonly localNodeID?: string,
  ) {
    const path = join(config.home, 'workspace-key.bin')
    try {
      this.key = readFileSync(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.key = randomBytes(32)
      writeFileSync(path, this.key, { mode: 0o600, flag: 'wx' })
    }
    if (this.key.length !== 32) throw new Error('Invalid workspace encryption key')
  }
  seal(value: unknown): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, 'base64'),
      cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12))
    cipher.setAuthTag(b.subarray(12, 28))
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
    ) as T
  }
  target(owner: string, id: string): GatewayTarget {
    const runner=this.runnerTarget?.(owner,id)
    if(runner)return runner
    if (id === 'local') return this.local
    const node = this.store.require<WorkspaceNode>(owner, 'node', id),
      key = `${owner}:${id}`
    let target = this.targets.get(key)
    if (!target) {
      if (node.transport === 'paired-web') {
        const { token } = this.open<{ token: string }>(node.secret)
        const url = new URL(`node/${node.deviceId}`, node.url), client = new UpstreamClient(url, this.local.client.fetchImpl)
        target = { url, client, pairedToken: token, session: {
          request: (path, options = {}) => client.request(path, new CookieJar(), { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }),
          webSocketCredential: async () => { throw new Error('Paired Web nodes use HTTP+SSE') },
        } }
        this.targets.set(key, target)
        return target
      }
      const credentials = this.open<{ username: string; password: string }>(node.secret)
      const url = new URL(node.url),
        client = new UpstreamClient(url)
      target = { url, client, session: new UpstreamServiceSession(client, () => credentials) }
      this.targets.set(key, target)
    }
    return target
  }
  targetForAgent(owner: string, agent: { id?:string;nodeId: string; remoteAgentId?: string;execution?:string;helperRunnerId?:string;computerEnvironmentId?:string }): GatewayTarget {
    if(agent.execution==='computer'){
      if(!agent.id||agent.remoteAgentId)throw new HttpError(409,'隔离电脑需要当前服务器管理的 Agent','computer_agent_required')
      const target=this.runnerTarget?.(owner,agent.nodeId,{environmentId:agent.computerEnvironmentId??agent.id,agentId:agent.id,ownerKey:createHash('sha256').update(owner).digest('hex')})
      if(agent.computerEnvironmentId&&this.store.require<import('./sharedComputers.js').SharedComputer>(owner,'shared-computer',agent.computerEnvironmentId).runnerId!==target?.runner?.id)throw new HttpError(409,'共享电脑的原执行节点已变化，请先恢复原节点','shared_runner_changed')
      if(agent.helperRunnerId&&target?.runner?.id!==agent.helperRunnerId)throw new HttpError(409,'临时助手的原执行节点已变化，请创建新助手','helper_runner_changed')
      if(!target)throw new HttpError(409,'隔离电脑需要连接执行节点','computer_runner_required')
      return target
    }
    const base = this.target(owner, agent.nodeId)
    if (!agent.remoteAgentId) return base
    if (!base.pairedToken) throw new HttpError(409, '引用远端 Agent 需要扫码子节点', 'paired_node_required')
    const key = `${owner}:${agent.nodeId}:agent:${agent.remoteAgentId}`
    let target = this.targets.get(key)
    if (!target) {
      const token = base.pairedToken, url = new URL(`${base.url.href.replace(/\/$/, '')}/api/workspace-agents/${encodeURIComponent(agent.remoteAgentId)}/gateway`)
      const client = new UpstreamClient(url, base.client.fetchImpl)
      target = {url,client,pairedToken:token,session:{
        request:(path, options={})=>client.request(path,new CookieJar(),{...options,headers:{...options.headers,Authorization:`Bearer ${token}`}}),
        webSocketCredential:async()=>{throw new Error('Remote Agent uses HTTP/SSE')},
      }}
      this.targets.set(key,target)
    }
    return target
  }
  async remoteAgents(owner: string, nodeId: string, fresh = false): Promise<WorkspaceAgent[]> {
    const key=`${owner}:${nodeId}`, cached=this.remoteCatalogs.get(key)
    if (!fresh && cached?.value && cached.expires>Date.now()) return cached.value
    if (cached?.pending) return cached.pending
    const state:{expires:number;value?:WorkspaceAgent[];pending?:Promise<WorkspaceAgent[]>}={expires:0}
    const pending=(async()=>{
      const target=this.target(owner,nodeId)
      if (!target.pairedToken) throw new HttpError(409,'请先扫码添加远程子节点','paired_node_required')
      const response=await target.session.request('/api/workspace-agents')
      if (response.status!==200) throw new HttpError(409,'远端需升级并重新扫码授权，才能添加 Bot 模式 Agent','remote_agents_unavailable')
      const payload=JSON.parse(response.body.toString())
      const agents:Array<WorkspaceAgent>=Array.isArray(payload.agents) ? payload.agents.filter((a:WorkspaceAgent)=>!a.archived).map((a:WorkspaceAgent)=>{
        if(typeof a.id!=='string'||!/^[0-9a-f-]{36}$/.test(a.id)) throw new HttpError(502,'远端 Agent 标识无效','invalid_remote_agent')
        const fields=parse(agentInput,{name:a.name,avatar:a.avatar,instructions:a.instructions,nodeId:a.nodeId,profile:a.profile})
        return {...a,...fields}
      }) : []
      state.value=agents;state.expires=Date.now()+3000;return agents
    })()
    state.pending=pending;this.remoteCatalogs.set(key,state)
    try { return await pending } finally {state.pending=undefined}
  }
  private uniqueRemoteName(owner: string, remoteName: string, nodeId: string, excludeId?: string): string {
    const names = new Set(this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>a.id!==excludeId).map(a=>a.name.toLocaleLowerCase()))
    let name = remoteName, index = 1
    const node = this.store.require<WorkspaceNode>(owner,'node',nodeId)
    const nodeName=node.name.replace(/[@\u0000-\u001f]/g,' ').trim().slice(0,20) || '远程'
    while (names.has(name.toLocaleLowerCase())) {
      name=`${remoteName.slice(0,60)} · ${nodeName}${index===1 ? '' : ' '+index}`;index++
    }
    return name
  }
  async importRemoteAgent(owner: string, nodeId: string, remoteAgentId: string): Promise<WorkspaceAgent> {
    const remote = (await this.remoteAgents(owner,nodeId,true)).find(a=>a.id===remoteAgentId)
    if (!remote) throw new HttpError(404,'远端 Agent 不存在或已归档','remote_agent_not_found')
    const existing = this.store.list<WorkspaceAgent>(owner,'agent').find(a=>a.nodeId===nodeId && a.remoteAgentId===remoteAgentId)
    if (existing) {
      const current=existing.archived ? this.store.updateAgent(owner,existing.id,{archived:false}) : existing
      return this.refreshRemoteAgent(owner,current)
    }
    const created = this.store.createAgent(owner,{name:this.uniqueRemoteName(owner,remote.name,nodeId),avatar:remote.avatar,instructions:remote.instructions,nodeId,profile:remote.profile})
    created.remoteAgentId = remote.id
    this.store.put(owner,'agent',created.id,created)
    this.store.event(owner,'agent.changed',created)
    return created
  }
  refreshRemoteAgent(owner: string, agent: WorkspaceAgent): Promise<WorkspaceAgent> {
    const key=`${owner}:${agent.id}`, pending=this.remoteRefreshes.get(key)
    if (pending) return pending
    const next=this.readRemoteAgent(owner,agent).finally(()=>this.remoteRefreshes.delete(key))
    this.remoteRefreshes.set(key,next);return next
  }
  private async readRemoteAgent(owner: string, agent: WorkspaceAgent): Promise<WorkspaceAgent> {
    if (!agent.remoteAgentId) return agent
    const remote = (await this.remoteAgents(owner,agent.nodeId)).find(a=>a.id===agent.remoteAgentId)
    if (!remote) throw new HttpError(404,'引用的远端 Agent 不存在或已归档','remote_agent_unavailable')
    agent=this.store.require<WorkspaceAgent>(owner,'agent',agent.id)
    const latest = {...agent,name:this.uniqueRemoteName(owner,remote.name,agent.nodeId,agent.id),avatar:remote.avatar,instructions:remote.instructions,profile:remote.profile}
    if (latest.name!==agent.name || latest.avatar!==agent.avatar || latest.instructions!==agent.instructions || latest.profile!==agent.profile) {
      latest.revision++; latest.updatedAt=Date.now()
      this.store.put(owner,'agent',agent.id,latest)
      this.store.event(owner,'agent.changed',latest)
      for (const c of this.store.list<WorkspaceConversation>(owner,'conversation').filter(c=>c.kind==='direct'&&c.memberIds[0]===agent.id)) {
        Object.assign(c,{name:latest.name,avatar:latest.avatar});this.store.put(owner,'conversation',c.id,c)
      }
    }
    return latest
  }
  private invalidateNode(owner: string, id: string): void {
    this.remoteCatalogs.delete(`${owner}:${id}`)
    for (const [key,target] of this.targets) if (key===`${owner}:${id}` || key.startsWith(`${owner}:${id}:agent:`)) {
      target.client.close(); this.targets.delete(key)
    }
  }
  async pair(owner: string, input: { qrPayload: string; name: string; nodeId?: string }): Promise<void> {
    const code = parseWorkspacePairCode(input.qrPayload), fetchImpl = this.local.client.fetchImpl
    if (code.nodeId === this.localNodeID) throw new HttpError(400, '不能把当前服务器添加为自己的子节点', 'self_node')
    const capabilities=await verifyNode(fetchImpl, code.url, code.nodeId, code.fingerprint)
    const replaced = input.nodeId ? this.store.require<WorkspaceNode>(owner,'node',input.nodeId) : undefined
    if (replaced && !capabilities.features?.includes('pair-renewal'))
      throw new HttpError(409,'请先升级远端，再更新扫码授权','node_upgrade_required')
    if (replaced && (replaced.remoteNodeId !== code.nodeId || replaced.fingerprint !== code.fingerprint))
      throw new HttpError(409,'请扫描同一个子节点的配对码','node_identity_mismatch')
    if (!replaced && this.store.list<WorkspaceNode>(owner, 'node').some(n => n.remoteNodeId === code.nodeId))
      throw new HttpError(409, '子节点已经连接，请在节点管理中修改地址', 'node_already_paired')
    const claim = await nodeJSON(fetchImpl, new URL('api/pair/v1/claim', code.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(replaced ? {Authorization:`Bearer ${this.open<{token:string}>(replaced.secret).token}`} : {}) },
      body: JSON.stringify({ pairingId: code.pairingId, secret: code.secret, deviceName: input.name || '夭夭 Bot 主节点', ...(replaced ? {existingDeviceId:replaced.deviceId} : {}) }),
    })
    if (claim.protocolVersion !== 1 || claim.serviceType !== 'yaoyao-web' || claim.nodeId !== code.nodeId || claim.fingerprint !== code.fingerprint
      || (replaced && claim.deviceId !== replaced.deviceId)
      || typeof claim.token !== 'string' || !claim.token || !/^[0-9a-f-]{36}$/.test(claim.deviceId ?? '')
      || !Array.isArray(claim.scopes) || !['agents.read', 'sessions.execute', 'history.read'].every(scope => claim.scopes.includes(scope)))
      throw new HttpError(409, '子节点授权或身份不匹配，请重新扫码并授权 Agent 与会话访问', 'invalid_node_claim')
    const expected = new URL(`node/${claim.deviceId}`, code.url)
    if (claim.serverUrl !== expected.href) throw new HttpError(409, '子节点配对地址与二维码不一致', 'node_identity_mismatch')
    const id = replaced?.id ?? randomUUID()
    this.invalidateNode(owner,id)
    this.store.put(owner, 'node', id, { id, name: input.name.trim() || replaced?.name || code.url.hostname, url: code.url.href,
      transport: 'paired-web', remoteNodeId: code.nodeId, fingerprint: code.fingerprint, deviceId: claim.deviceId, secret: this.seal({ token: claim.token }) })
    this.store.event(owner, 'nodes.changed', {})
  }
  async update(owner: string, id: string, input: { name: string; url: string }): Promise<void> {
    const node = this.store.require<WorkspaceNode>(owner, 'node', id)
    if (node.transport !== 'paired-web' || !node.remoteNodeId || !node.fingerprint)
      throw new HttpError(409, '旧节点请使用 15300 子节点二维码重新连接', 'node_pairing_required')
    const url = nodeServiceURL(input.url)
    await verifyNode(this.local.client.fetchImpl, url, node.remoteNodeId, node.fingerprint)
    this.store.put(owner, 'node', id, { ...node, name: input.name, url: url.href })
    this.invalidateNode(owner,id)
    this.store.event(owner, 'nodes.changed', {})
  }
  remove(owner: string, id: string): void {
    this.store.require(owner, 'node', id)
    this.store.remove(owner, 'node', id)
    this.invalidateNode(owner,id)
    this.store.event(owner, 'nodes.changed', {})
  }
  async sources(owner: string): Promise<{ sources: WorkspaceSource[]; errors: string[] }> {
    const sources: WorkspaceSource[] = [],
      errors: string[] = []
    await Promise.all(
      ['local', ...this.store.list<WorkspaceNode>(owner, 'node').map((n) => n.id)].map(
        async (nodeId) => {
          try {
            const response = await this.target(owner, nodeId).session.request('/api/profiles')
            if (response.status !== 200) throw new Error('节点不可用')
            const payload = JSON.parse(response.body.toString())
            for (const p of Array.isArray(payload.profiles) ? payload.profiles : []) {
              const profile = typeof p === 'string' ? p : p.name
              if (typeof profile === 'string' && profile && this.sourceAllowed(owner, nodeId, profile))
                sources.push({
                  nodeId,
                  profile,
                  name: p.ui_meta?.['hermes-bots']?.title || p.display_name || p.label || profile,
                })
            }
          } catch {
            errors.push(nodeId)
          }
        },
      ),
    )
    return { sources, errors }
  }
  close(): void {
    for (const t of this.targets.values()) t.client.close()
    this.targets.clear()
  }
}

/** One server-owned transport per execution binding, never tied to a browser. */
export class WorkspaceGateway {
  private socket?: WebSocket
  private paired?: WorkspacePairedChannel
  private runner?: {rpc(method:string,params:Record<string,unknown>):Promise<any>;close():void}
  private pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  onEvent: (frame: GatewayFrame) => void = () => {}
  onDisconnect: () => void = () => {}
  constructor(readonly target: GatewayTarget,readonly scope?:GatewayExecutionScope) {}
  async connect(): Promise<void> {
    if(this.target.runner){this.runner=await this.target.runner.open(frame=>this.onEvent(frame),()=>this.onDisconnect(),this.scope);return}
    if (this.target.pairedToken) {
      this.paired = new WorkspacePairedChannel(this.target.url, this.target.pairedToken, this.target.client.fetchImpl,
        frame => this.onEvent(frame), () => this.onDisconnect())
      await this.paired.connect()
      return
    }
    const credential = await this.target.session.webSocketCredential(),
      url = new URL(this.target.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`
    url.search = ''
    url.searchParams.set(credential.name, credential.value)
    const socket = new WebSocket(url, {
      agent: this.target.client.directAgent,
      headers: { Origin: this.target.url.origin },
      maxPayload: 36 * 1024 * 1024,
    })
    this.socket = socket
    let ready!: () => void
    let failed!: (e: Error) => void
    const handshake = new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    })
    const handshakeTimer = setTimeout(() => {
      socket.terminate()
      failed(new Error('Hermes gateway readiness timed out'))
    }, 20_000)
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString()),
          waiter = this.pending.get(String(frame.id))
        if (waiter) {
          clearTimeout(waiter.timer)
          this.pending.delete(String(frame.id))
          if (frame.error)
            waiter.reject(
              new HttpError(502, frame.error.message || 'Hermes 请求失败', 'gateway_rejected'),
            )
          else waiter.resolve(frame.result)
        } else if (frame.method === 'event' && frame.params) {
          if (frame.params.type === 'gateway.ready') {
            clearTimeout(handshakeTimer)
            ready()
          }
          this.onEvent(frame.params)
        }
      } catch {
        /* Malformed frames cannot mutate an execution. */
      }
    })
    socket.on('error', (error) => {
      clearTimeout(handshakeTimer)
      failed(error)
    })
    socket.on('close', () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Hermes connection closed'))
      }
      this.pending.clear()
      this.onDisconnect()
      clearTimeout(handshakeTimer)
      failed(new Error('Hermes connection closed'))
    })
    await handshake
  }
  rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if(this.runner)return this.runner.rpc(method,params)
    if (this.paired) return this.paired.rpc(method, params)
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Hermes connection unavailable'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Hermes response timed out'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }
  close(): void {
    this.onDisconnect = () => {}
    this.paired?.close()
    this.runner?.close()
    this.socket?.close()
  }
}
