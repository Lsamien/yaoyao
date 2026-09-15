// @vitest-environment node
import {expect,it} from 'vitest'
import {WebSocketServer,type WebSocket} from 'ws'
import {WorkspaceGateway,type GatewayFrame,type GatewayTarget} from '../../src/server/workspaceGateway'

it('adapts Hermes server requests, scopes answers, restores pending cards and withdraws cancelled requests',async()=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'})
  await new Promise<void>(done=>server.once('listening',done))
  const received:any[]=[],events:GatewayFrame[]=[]
  let socket:WebSocket
  server.on('connection',connection=>{
    socket=connection
    connection.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    connection.on('message',raw=>{
      const value=JSON.parse(String(raw));received.push(value)
      if(value.method==='session.resume')connection.send(JSON.stringify({id:value.id,result:{session_id:'session',open_requests:[
        {id:'srq-replay',method:'clarify',params:{session_id:'session',question:'下一步做什么？'}},
      ]}}))
    })
  })
  const target={url:new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`),
    client:{directAgent:undefined},session:{webSocketCredential:async()=>({name:'ticket',value:'fixture'})}} as unknown as GatewayTarget
  const gateway=new WorkspaceGateway(target);gateway.onEvent=frame=>events.push(frame)
  const send=(value:unknown)=>socket.send(JSON.stringify(value))
  try{
    await gateway.connect()
    send({id:'srq-approve',method:'approval',params:{session_id:'session',request_id:'queue-id',description:'需要读取授权文件',choices:['once','deny']}})
    await expect.poll(()=>events.some(e=>e.type==='approval.requested')).toBe(true)
    expect(events.at(-1)).toMatchObject({session_id:'session',payload:{request_id:'srq-approve',message:'需要读取授权文件'}})
    await expect(gateway.rpc('approval.respond',{session_id:'another',request_id:'srq-approve',choice:'once'})).rejects.toMatchObject({code:'gateway_rejected'})
    await gateway.rpc('approval.respond',{session_id:'session',request_id:'srq-approve',choice:'deny'})
    await expect.poll(()=>received.some(r=>r.id==='srq-approve')).toBe(true)
    expect(received.find(r=>r.id==='srq-approve')).toEqual({jsonrpc:'2.0',id:'srq-approve',result:{choice:'deny'}})
    await expect(gateway.rpc('approval.respond',{session_id:'session',request_id:'srq-approve',choice:'once'})).rejects.toMatchObject({code:'gateway_rejected'})
    await gateway.rpc('session.resume',{session_id:'session'})
    await expect.poll(()=>events.some(e=>e.type==='clarify.requested')).toBe(true)
    send({method:'event',params:{type:'request.cancel',session_id:'session',payload:{id:'srq-replay',method:'clarify',reason:'interrupted'}}})
    await expect.poll(()=>events.some(e=>e.type==='interaction.cancelled')).toBe(true)
    await expect(gateway.rpc('clarify.respond',{session_id:'session',request_id:'srq-replay',answer:'late'})).rejects.toMatchObject({code:'gateway_rejected'})
    send({id:'srq-unknown',method:'unsupported.prompt',params:{session_id:'session'}})
    await expect.poll(()=>received.some(r=>r.id==='srq-unknown')).toBe(true)
    expect(received.find(r=>r.id==='srq-unknown').error.code).toBe(-32601)
  }finally{
    gateway.close();for(const client of server.clients)client.terminate()
    await new Promise<void>(done=>server.close(()=>done()))
  }
})
