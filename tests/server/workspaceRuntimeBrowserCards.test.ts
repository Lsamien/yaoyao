// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WebSocketServer} from 'ws'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import type {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {UploadStore} from '../../src/server/uploads'
import {saveHostTools} from '../../src/server/hostToolSettings'
import type {ManagedBrowsers,BrowserTurnOptions} from '../../src/server/managedBrowsers'
import type {ManagedBrowserCard} from '../../src/shared/managedBrowser'
import type {WorkspaceConversation,WorkspaceMessage,WorkspaceRun} from '../../src/shared/workspace'

const owner='browser-card-user'
afterEach(()=>vi.restoreAllMocks())

async function fixture(group=false){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-runtime-browser-card-'))
  const store=new WorkspaceStore(home),uploads=new UploadStore(home)
  saveHostTools(home,{managedBrowser:true,vm:false,serverComputer:false,scriptMachine:false})
  const server=new WebSocketServer({port:0,host:'127.0.0.1'})
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const bindings=new Map<string,{bridge_url:string;token:string}>()
  const browserClosures:{retain:boolean|undefined;aborted:boolean}[]=[]
  let toolError:unknown,options:BrowserTurnOptions|undefined,card:ManagedBrowserCard|undefined
  const target={
    url:new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`),
    client:{directAgent:undefined},
    session:{
      webSocketCredential:async()=>({name:'ticket',value:'test'}),
      request:async(path:string,input?:{body?:any})=>{
        if(path.endsWith('/bind'))bindings.set(input?.body.session_id,input?.body)
        return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(path.startsWith('/api/plugins/yaoyao-bot-bridge/')
          ? {ok:true,version:1,ready:true,in_process:true,native_tools:true}
          : path==='/api/config'?{terminal:{}}:{messages:[]}))}
      },
    },
  }
  const nodes={requireSource:()=>{},target:()=>target} as unknown as WorkspaceNodes
  const runtime=new WorkspaceRuntime(store,nodes,uploads)
  runtime.managedBrowsers={available:()=>true,openTurn:(_owner,agent,input)=>{
    options=input
    card={id:input.workId,agentId:agent.id,agentName:agent.name,status:'active',title:'浏览器页面',url:'https://example.com/page',updatedAt:Date.now()}
    return {close:async(value?:{retain?:boolean})=>{browserClosures.push({retain:value?.retain,aborted:input.signal.aborted})},call:async()=>{input.authorize();input.onCard?.(card!);return {ok:true}}}
  }} as ManagedBrowsers
  server.on('connection',socket=>{
    socket.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    socket.on('message',data=>{
      const frame=JSON.parse(String(data)),respond=(result:unknown)=>socket.send(JSON.stringify({id:frame.id,result}))
      if(frame.method==='session.create'||frame.method==='session.resume')respond({session_id:randomUUID(),stored_session_id:randomUUID(),running:false,info:{profile_name:frame.params.profile}})
      else if(frame.method==='session.cwd.set')respond({cwd:frame.params.cwd})
      else if(frame.method==='session.usage')respond({context_used:10,context_max:1000})
      else if(frame.method==='prompt.submit'){
        respond({status:'streaming'})
        void(async()=>{
          try{
            const binding=bindings.get(frame.params.session_id)!
            const toolRequest=async(path:string,body:unknown)=>{
              const response=await fetch(binding.bridge_url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${binding.token}`},body:JSON.stringify(body)})
              expect(response.status).toBe(200);return response.json() as Promise<any>
            }
            const catalog=await toolRequest('/tools/list',{}),tool=catalog.tools.find((entry:any)=>entry.name==='managed_browser_open')
            expect(tool).toBeDefined()
            const result=await toolRequest('/tools/call',{toolId:tool.id,arguments:{url:'https://example.com/page'},callId:'open-browser'})
            expect(result).toMatchObject({structuredContent:{ok:true}})
          }catch(error){toolError=error}
          socket.send(JSON.stringify({method:'event',params:{type:'message.complete',session_id:frame.params.session_id,payload:{text:'',status:'complete'}}}))
        })()
      }else respond({ok:true,status:'interrupted'})
    })
  })
  const bot=store.createAgent(owner,{name:'浏览器 Bot',profile:'default'})
  const conversation=group
    ? store.createGroup(owner,{name:'浏览器群',memberIds:[bot.id,store.createAgent(owner,{name:'群成员',profile:'default'}).id],administratorId:bot.id})
    : store.list<WorkspaceConversation>(owner,'conversation').find(value=>value.kind==='direct'&&value.memberIds[0]===bot.id)!
  return {store,runtime,conversation,browserClosures,
    get browserOptions(){return options},
    async run(){
      const run=runtime.send(owner,conversation.id,{requestId:randomUUID(),content:'打开网页'})
      await vi.waitFor(()=>expect(['complete','failed']).toContain(store.require<WorkspaceRun>(owner,'run',run.id).status))
      expect(toolError).toBeUndefined()
      const settled=store.require<WorkspaceRun>(owner,'run',run.id)
      expect(settled.status,settled.error).toBe('complete')
      const message=store.list<WorkspaceMessage>(owner,'message').find(value=>value.browserCard?.id===card?.id)!
      expect(message).toBeDefined()
      return message
    },
    update(){options!.onCard?.({...card!,status:'closed',message:'本轮浏览器操作已结束',updatedAt:Date.now()})},
    async close(){
      runtime.close();await new Promise(resolve=>setTimeout(resolve,10))
      for(const client of server.clients)client.terminate()
      await new Promise<void>(resolve=>server.close(()=>resolve()))
      uploads.close();store.close();rmSync(home,{recursive:true,force:true})
    },
  }
}

it('retains a successful browser turn before aborting its tools and revokes the finished task authorization',async()=>{
  const f=await fixture()
  try{
    await f.run()
    expect(f.browserClosures).toEqual([{retain:true,aborted:false}])
    expect(f.browserOptions!.signal.aborted).toBe(true)
    expect(()=>f.browserOptions!.authorize()).toThrow('本轮运行已结束')
  }finally{await f.close()}
})

it('persists a card-only native browser tool reply and accepts later human-session updates',async()=>{
  const f=await fixture()
  try{
    const message=await f.run()
    expect(message).toMatchObject({content:'',status:'complete',visible:true,browserCard:{status:'active',title:'浏览器页面'}})
    expect(message.attachments).toEqual([]);expect(message.tools).toEqual([])
    f.update()
    expect(f.store.require<WorkspaceMessage>(owner,'message',message.id)).toMatchObject({content:'',status:'complete',browserCard:{status:'closed'}})
    f.store.saveMessage(owner,{...f.store.require<WorkspaceMessage>(owner,'message',message.id),content:'后来保存的消息内容'})
    f.update()
    expect(f.store.require<WorkspaceMessage>(owner,'message',message.id).content).toBe('后来保存的消息内容')
  }finally{await f.close()}
})

it('does not recreate a deleted task or its messages from a later browser card update',async()=>{
  const f=await fixture(true)
  try{
    const message=await f.run(),taskId=message.conversationTaskId!
    expect(taskId).toBeTruthy()
    f.store.deleteTask(owner,f.conversation.id,taskId)
    const replacementTasks=f.store.tasks(owner,f.conversation.id)
    const save=vi.spyOn(f.store,'saveMessage')
    expect(()=>f.update()).not.toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(f.store.get(owner,'message',message.id)).toBeUndefined()
    expect(f.store.get(owner,'conversation-task',taskId)).toBeUndefined()
    expect(f.store.tasks(owner,f.conversation.id)).toEqual(replacementTasks)
  }finally{await f.close()}
})

it('isolates a card persistence failure from browser cleanup and allows a later update',async()=>{
  const f=await fixture()
  try{
    const message=await f.run()
    const save=vi.spyOn(f.store,'saveMessage').mockImplementationOnce(()=>{throw new Error('card storage unavailable')})
    expect(()=>f.update()).not.toThrow()
    expect(save).toHaveBeenCalledOnce()
    expect(f.store.require<WorkspaceMessage>(owner,'message',message.id).browserCard?.status).toBe('active')
    f.update()
    expect(f.store.require<WorkspaceMessage>(owner,'message',message.id).browserCard?.status).toBe('closed')
  }finally{await f.close()}
})
