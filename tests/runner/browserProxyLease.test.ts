// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {createServer,request,type IncomingMessage,type ServerResponse} from 'node:http'
const target=vi.hoisted(()=>({port:0,resolve:undefined as undefined|(()=>Promise<void>)}))
vi.mock('../../src/runner/network/publicDestination.js',async importOriginal=>({
  ...await importOriginal<object>(),publicDestination:async()=>{await target.resolve?.();return {host:'fixture.test',address:'127.0.0.1',family:4,port:target.port}},
}))
import {BrowserPublicProxy} from '../../src/runner/browser/publicProxy.js'
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

it.each(['expired','parked'])('disconnects an existing response stream when %s and allows an authorized reconnect',async mode=>{
  const server=createServer((req,res)=>{res.writeHead(200);if(req.url==='/once')res.end('ok');else res.write('stream-start')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));target.port=(server.address() as {port:number}).port
  let allowed=true
  const proxy=await BrowserPublicProxy.start(async()=>{if(!allowed)throw new Error('grant expired')},undefined,mode==='parked'?60000:20)
  const headers={'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}
  try{
    let interrupted!:()=>void;const ended=new Promise<void>(resolve=>{interrupted=resolve})
    await new Promise<void>((resolve,reject)=>{
      const req=request(proxy.serverURL,{path:'http://fixture.test/stream',headers},res=>{res.once('data',()=>resolve());res.once('aborted',interrupted);res.on('error',()=>{})})
      req.on('error',reject);req.end()
    })
    allowed=false
    if(mode==='parked')proxy.disconnect()
    await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new Error('expired stream stayed connected')),1000))])
    allowed=true
    const status=await new Promise<number>((resolve,reject)=>{const req=request(proxy.serverURL,{path:'http://fixture.test/once',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!))});req.on('error',reject);req.end()})
    expect(status).toBe(200)
  }finally{await proxy.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

it.each([
  ['http','authorization'],['connect','authorization'],['http','destination'],['connect','destination'],
] as const)('does not create an upstream for an old %s request resumed after parking during %s',async(protocol,stage)=>{
  let connections=0,authorizations=0,allowed=true
  const server=createServer((_req,res)=>res.end('new grant'))
  server.on('connection',()=>{connections++})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));target.port=(server.address() as {port:number}).port
  const entered=deferred(),release=deferred()
  let resolveOnce=true
  if(stage==='destination')target.resolve=async()=>{if(resolveOnce){resolveOnce=false;entered.resolve();await release.promise}}
  const proxy=await BrowserPublicProxy.start(async()=>{
    if(!allowed)throw new Error('parked')
    if(++authorizations===2&&stage==='authorization'){entered.resolve();await release.promise}
  },undefined,60000)
  const headers={'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}
  const options={path:protocol==='connect'?'fixture.test:443':'http://fixture.test/old-request',method:protocol==='connect'?'CONNECT':'GET',headers,agent:false as const}
  const stale=request(proxy.serverURL,options)
  stale.on('error',()=>{});stale.on('response',response=>response.resume());stale.on('connect',(_response,socket)=>socket.destroy())
  const staleClosed=new Promise<void>(resolve=>stale.once('close',resolve))
  try{
    stale.end();await entered.promise
    allowed=false;proxy.disconnect();await staleClosed
    // A new task has acquired this Bot's browser before the old async check
    // returns. Current authorization alone cannot identify the stale request.
    allowed=true;release.resolve()
    const result=await new Promise<number>((resolve,reject)=>{
      const fresh=request(proxy.serverURL,{...options,path:protocol==='connect'?'fixture.test:443':'http://fixture.test/new-request'},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!))})
      fresh.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode!)})
      fresh.on('error',reject);fresh.end()
    })
    expect(result).toBe(200)
    expect(connections).toBe(1)
  }finally{
    release.resolve();target.resolve=undefined;stale.destroy()
    await proxy.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

it('keeps a new stream connected when a previous epoch timer check fails late',async()=>{
  let freshResponse:ServerResponse|undefined,delayNextCheck=false
  const server=createServer((req,res)=>{res.writeHead(200);if(req.url==='/new')freshResponse=res;res.write('started')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));target.port=(server.address() as {port:number}).port
  const entered=deferred()
  let rejectOld!:(error:Error)=>void
  const delayed=new Promise<void>((_resolve,reject)=>{rejectOld=reject})
  void delayed.catch(()=>{})
  const proxy=await BrowserPublicProxy.start(async()=>{
    if(delayNextCheck){delayNextCheck=false;entered.resolve();await delayed}
  },undefined,20)
  const headers={'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}
  const stream=(path:string)=>new Promise<IncomingMessage>((resolve,reject)=>{
    const req=request(proxy.serverURL,{path:'http://fixture.test'+path,headers,agent:false},res=>{res.on('error',()=>{});res.once('data',()=>resolve(res))})
    req.on('error',reject);req.end()
  })
  try{
    const old=await stream('/old')
    delayNextCheck=true;await entered.promise
    const oldClosed=new Promise<void>(resolve=>old.once('close',resolve))
    proxy.disconnect();await oldClosed
    const fresh=await stream('/new')
    let timer:ReturnType<typeof setTimeout>|undefined
    const survives=new Promise<string>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('new stream stopped receiving data')),1000)
      fresh.once('data',chunk=>{clearTimeout(timer);resolve(String(chunk))})
      fresh.once('aborted',()=>{clearTimeout(timer);reject(new Error('old timer revoked the new stream'))})
    })
    void survives.catch(()=>{})
    rejectOld(new Error('old task expired'))
    await new Promise<void>(resolve=>setImmediate(resolve))
    freshResponse!.write('new epoch survives')
    expect(await survives).toBe('new epoch survives')
    fresh.destroy()
  }finally{
    rejectOld(new Error('test finished'))
    await proxy.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
