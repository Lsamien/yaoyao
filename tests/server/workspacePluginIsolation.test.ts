// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WebSocketServer} from 'ws'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import {WorkspaceNodes,type GatewayTarget} from '../../src/server/workspaceGateway'
import {WorkspacePlugins} from '../../src/server/botPlugins/workspacePlugins'
import {UploadStore} from '../../src/server/uploads'
import {loadServerConfig} from '../../src/server/config'
import {saveHostTools} from '../../src/server/hostToolSettings'
import type {LocalAuthStore} from '../../src/server/localAuth'
import type {ManagedBrowsers} from '../../src/server/managedBrowsers'
import type {WorkspaceConversation,WorkspaceRun} from '../../src/shared/workspace'

const owner='plugin-isolation-user'

async function fixture(failure:'initialize'|'tools/list'){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-plugin-isolation-'))
  const store=new WorkspaceStore(home),uploads=new UploadStore(home)
  saveHostTools(home,{managedBrowser:true,vm:false,serverComputer:false,scriptMachine:false,cloud:false})
  const server=new WebSocketServer({port:0,host:'127.0.0.1'})
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const bindings=new Map<string,{bridge_url:string;token:string}>(),prompts:string[]=[],catalogs:any[][]=[]
  let integrationError:unknown,offline=false
  const target={
    url:new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`),client:{directAgent:undefined},
    session:{webSocketCredential:async()=>({name:'ticket',value:'test'}),request:async(path:string,input?:{body?:any})=>{
      if(path.endsWith('/bind'))bindings.set(input?.body.session_id,input?.body)
      const value=path.startsWith('/api/plugins/yaoyao-bot-bridge/')?{ok:true,version:1,ready:true,in_process:true,native_tools:true}
        :path==='/api/config'?{terminal:{}}:{messages:[]}
      return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(value))}
    }},
  } as unknown as GatewayTarget
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),target)
  const runtime=new WorkspaceRuntime(store,nodes,uploads)
  const browserOpen=vi.fn()
  runtime.managedBrowsers={available:()=>true,openTurn:browserOpen} as unknown as ManagedBrowsers
  const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
  const pluginFetch:typeof fetch=async(input,init)=>{
    const frame=JSON.parse(String(init?.body))
    if(offline&&String(input).includes('offline.example.test')&&frame.method===failure)return response({error:'upstream token must stay private'},503)
    if(frame.method==='notifications/initialized')return new Response(null,{status:202})
    const result=frame.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}
      :frame.method==='tools/list'?{tools:[{name:'echo',description:'fixture',inputSchema:{type:'object'}}]}
      :{content:[{type:'text',text:'healthy tool response'}]}
    return response({jsonrpc:'2.0',id:frame.id,result})
  }
  const auth={isUserActive:()=>true,isAdminActive:()=>true} as unknown as LocalAuthStore
  const plugins=new WorkspacePlugins(store,nodes,auth,runtime,home,pluginFetch)
  runtime.plugins=plugins
  const bot=store.createAgent(owner,{name:'普通聊天 Bot',profile:'default'})
  for(const [name,url] of [['离线服务','https://offline.example.test/mcp'],['健康服务','https://healthy.example.test/mcp']]){
    const plugin=plugins.save(owner,{name,transport:'http',url,agentIds:[bot.id]})
    await plugins.test(owner,plugin.id)
    const entry=store.require<any>(owner,'bot-mcp-plugin',plugin.id)
    store.put(owner,'bot-mcp-plugin',plugin.id,{...entry,enabled:true,revision:entry.revision+1})
  }
  offline=true
  server.on('connection',socket=>{
    socket.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    socket.on('message',data=>{
      const frame=JSON.parse(String(data)),respond=(result:unknown)=>socket.send(JSON.stringify({id:frame.id,result}))
      if(frame.method==='session.create'||frame.method==='session.resume')respond({session_id:randomUUID(),stored_session_id:randomUUID(),running:false,info:{profile_name:frame.params.profile}})
      else if(frame.method==='session.cwd.set')respond({cwd:frame.params.cwd})
      else if(frame.method==='session.usage')respond({context_used:10,context_max:1000})
      else if(frame.method==='prompt.submit'){
        prompts.push(frame.params.text);respond({status:'streaming'})
        void(async()=>{
          try{
            const binding=bindings.get(frame.params.session_id)!
            const reply=await fetch(binding.bridge_url+'/tools/list',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${binding.token}`},body:'{}'})
            expect(reply.status).toBe(200)
            catalogs.push((await reply.json() as any).tools)
          }catch(error){integrationError=error}
          socket.send(JSON.stringify({method:'event',params:{type:'message.complete',session_id:frame.params.session_id,payload:{text:'你好！',status:'complete'}}}))
        })()
      }else respond({ok:true,status:'interrupted'})
    })
  })
  const conversation=store.list<WorkspaceConversation>(owner,'conversation').find(value=>value.kind==='direct'&&value.memberIds[0]===bot.id)!
  return {store,runtime,conversation,prompts,catalogs,browserOpen,getError:()=>integrationError,
    async close(){
      runtime.close();plugins.close();await new Promise(resolve=>setTimeout(resolve,10))
      for(const client of server.clients)client.terminate()
      await new Promise<void>(resolve=>server.close(()=>resolve()))
      nodes.close();uploads.close();store.close();rmSync(home,{recursive:true,force:true})
    },
  }
}

it.each(['initialize','tools/list'] as const)('submits and completes 你好 despite a plugin %s failure, with a visible warning and healthy tool inventory',async failure=>{
  const f=await fixture(failure)
  try{
    const run=f.runtime.send(owner,f.conversation.id,{requestId:randomUUID(),content:'你好'})
    await vi.waitFor(()=>expect(['complete','failed']).toContain(f.store.require<WorkspaceRun>(owner,'run',run.id).status))
    const settled=f.store.require<WorkspaceRun>(owner,'run',run.id)
    expect(settled.status,settled.error).toBe('complete')
    expect(f.getError()).toBeUndefined()
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]).toContain('【本轮用户消息】\n你好')
    const messages=f.store.messages(owner,f.conversation.id),answer=messages.find(message=>message.role==='assistant')!
    expect(messages.find(message=>message.role==='user')?.content).toBe('你好')
    expect(answer).toMatchObject({content:'你好！',status:'complete',visible:true,serviceWarnings:[{
      code:'plugin_initialization_failed',service:'离线服务',message:expect.stringContaining('不可用'),
    }]})
    expect(f.prompts[0]).toContain(JSON.stringify(answer.serviceWarnings))
    expect(f.prompts[0]).toContain('不能宣称已经调用或执行成功')
    expect(f.prompts[0]).toContain('继续处理不依赖这些服务的普通对话')
    expect(JSON.stringify(answer)).not.toContain('upstream token')
    expect(f.catalogs).toHaveLength(1)
    const pluginTools=f.catalogs[0]!.filter(tool=>tool.name.startsWith('plugin_'))
    expect(pluginTools).toHaveLength(1);expect(pluginTools[0].description).toContain('健康服务')
    expect(f.catalogs[0]!.some(tool=>tool.name==='managed_browser_open')).toBe(true)
    expect(f.browserOpen).not.toHaveBeenCalled()
  }finally{await f.close()}
})
