// @vitest-environment node
import {expect,it,vi} from 'vitest'
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

it('ignores frames and closes from the previous socket after a reconnect', async () => {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'})
  await new Promise<void>(resolve => server.once('listening', resolve))
  let current!: WebSocket, pending: any
  server.on('connection', socket => {
    current = socket
    socket.send(JSON.stringify({method: 'event', params: {type: 'gateway.ready'}}))
    socket.on('message', raw => { pending = JSON.parse(String(raw)) })
  })
  const target = {url: new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`), client: {},
    session: {webSocketCredential: async () => ({name: 'ticket', value: 'fixture'})}} as unknown as GatewayTarget
  const gateway = new WorkspaceGateway(target), events = vi.fn(), disconnect = vi.fn()
  gateway.onEvent = events; gateway.onDisconnect = disconnect
  try {
    await gateway.connect()
    const previous = (gateway as any).socket as WebSocket
    current.terminate()
    await expect.poll(() => disconnect.mock.calls.length).toBe(1)
    await gateway.connect()
    const reply = gateway.rpc('session.resume', {session_id: 'stored'})
    await expect.poll(() => pending?.method).toBe('session.resume')
    previous.emit('message', Buffer.from(JSON.stringify({method: 'event', params: {type: 'message.complete', session_id: 'stale'}})))
    previous.emit('close')
    expect(gateway.connected).toBe(true)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(events.mock.calls.some(([frame]) => frame.session_id === 'stale')).toBe(false)
    current.send(JSON.stringify({id: pending.id, result: {session_id: 'current'}}))
    await expect(reply).resolves.toEqual({session_id: 'current'})
  } finally {
    gateway.close(); for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('detects a half-open connection when Hermes stops answering pings', async () => {
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']})
  const server = new WebSocketServer({port: 0, host: '127.0.0.1', autoPong: false})
  await new Promise<void>(resolve => server.once('listening', resolve))
  const ping = vi.fn()
  server.on('connection', socket => {
    socket.on('ping', ping)
    socket.send(JSON.stringify({method: 'event', params: {type: 'gateway.ready'}}))
  })
  const target = {url: new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}`), client: {},
    session: {webSocketCredential: async () => ({name: 'ticket', value: 'fixture'})}} as unknown as GatewayTarget
  const gateway = new WorkspaceGateway(target), disconnect = vi.fn()
  gateway.onDisconnect = disconnect
  try {
    await gateway.connect()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect.poll(() => ping.mock.calls.length).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect.poll(() => disconnect.mock.calls.length).toBe(1)
    expect(gateway.connected).toBe(false)
  } finally {
    gateway.close(); for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.useRealTimers()
  }
})
