// @vitest-environment node
import {expect,it} from 'vitest'
import {WebSocketServer} from 'ws'
import {VmToolSession} from '../../src/server/vmComputer'
import type {GatewayTarget} from '../../src/server/workspaceGateway'

it('connects the virtual computer tool channel before creating its session',async()=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'})
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const methods:string[]=[]
  server.on('connection',socket=>{
    socket.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    socket.on('message',raw=>{
      const frame=JSON.parse(String(raw))
      methods.push(frame.method)
      socket.send(JSON.stringify({id:frame.id,result:frame.method==='session.create'?{session_id:'vm-session'}:{ok:true}}))
    })
  })
  const target={url:new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`),client:{},
    session:{webSocketCredential:async()=>({name:'ticket',value:'fixture'})}} as unknown as GatewayTarget
  const session=new VmToolSession(target,'default','work-id',()=>{})
  try{
    await expect(session.call('computer_shell',{command:'pwd'})).resolves.toEqual({ok:true})
    await expect(session.call('computer_desktop_state',{})).resolves.toEqual({ok:true})
    expect(methods).toEqual(['session.create','computer.invoke','computer.invoke'])
  }finally{
    session.close()
    for(const client of server.clients)client.terminate()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
