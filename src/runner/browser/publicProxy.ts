import {randomBytes,timingSafeEqual} from 'node:crypto'
import {createServer,request,type Server,type OutgoingHttpHeaders} from 'node:http'
import {connect,type Socket} from 'node:net'
import {publicDestination,type AddressLookup} from '../network/publicDestination.js'

/** Resolve and pin the destination before connecting, including HTTPS CONNECT.
 * Route interception alone cannot prevent DNS rebinding. This private authenticated
 * proxy is the browser's only configured HTTP transport; it exposes no CDP API. */
export class BrowserPublicProxy {
  private server:Server
  private sockets=new Set<Socket>()
  private stopped=false
  private connectionEpoch=0
  private authorizationTimer:ReturnType<typeof setInterval>
  readonly username='yaoyao'
  readonly password=randomBytes(32).toString('hex')
  serverURL=''
  private constructor(private authorize:()=>void|Promise<void>,private resolve?:AddressLookup,revalidateIntervalMs=2000){
    const expected=Buffer.from('Basic '+Buffer.from(`${this.username}:${this.password}`).toString('base64'))
    const authenticated=(header:unknown)=>{const actual=Buffer.from(typeof header==='string'?header:'');return actual.length===expected.length&&timingSafeEqual(actual,expected)}
    this.server=createServer(async(req,res)=>{
      if(!authenticated(req.headers['proxy-authorization'])){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="yaoyao"'});res.end();return}
      const epoch=this.connectionEpoch,assertCurrent=()=>{if(this.stopped||epoch!==this.connectionEpoch||req.socket.destroyed)throw new Error('浏览器网络连接已结束')}
      try{
        await this.authorize();assertCurrent()
        const url=publicBrowserURL(req.url??'')
        if(url.protocol!=='http:')throw new Error('HTTPS 必须使用 CONNECT')
        const destination=await publicDestination(url.hostname,Number(url.port||80),this.resolve)
        assertCurrent();await this.authorize();assertCurrent()
        const headers:OutgoingHttpHeaders={...req.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection']
        const upstream=request({hostname:destination.address,family:destination.family,port:destination.port,method:req.method,path:url.pathname+url.search,headers},response=>{
          res.writeHead(response.statusCode??502,response.headers);response.pipe(res)
        })
        upstream.on('socket',socket=>this.track(socket,epoch));upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
        req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream)
      }catch{res.writeHead(403);res.end('Public HTTP(S) destinations only')}
    })
    this.server.on('connect',async(req,client,head)=>{
      if(!authenticated(req.headers['proxy-authorization'])){client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="yaoyao"\r\n\r\n');return}
      const epoch=this.connectionEpoch,assertCurrent=()=>{if(this.stopped||epoch!==this.connectionEpoch||client.destroyed)throw new Error('浏览器网络连接已结束')}
      try{
        await this.authorize();assertCurrent()
        const url=publicBrowserURL('https://'+req.url)
        if(url.pathname!=='/'||url.search||url.hash)throw new Error('无效目标')
        const destination=await publicDestination(url.hostname,Number(url.port||443),this.resolve)
        assertCurrent();await this.authorize();assertCurrent()
        const upstream=connect({host:destination.address,family:destination.family,port:destination.port})
        this.track(upstream,epoch)
        upstream.once('connect',()=>{try{assertCurrent()}catch{upstream.destroy();return}client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)})
        upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy())
      }catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')}
    })
    this.server.on('connection',socket=>this.track(socket))
    this.server.on('clientError',(_error,socket)=>socket.destroy())
    this.server.headersTimeout=10000;this.server.requestTimeout=30000
    // HTTP keep-alive / HTTPS CONNECT streams outlive individual commands.
    // Revalidate their current task/control grant even when no new request is
    // arriving. Keep the listener so a later authorized handoff can reconnect.
    let checking=false
    this.authorizationTimer=setInterval(()=>{
      if(checking||this.stopped||!this.sockets.size)return
      const epoch=this.connectionEpoch
      checking=true;void Promise.resolve().then(()=>this.authorize()).catch(()=>{if(epoch===this.connectionEpoch)this.disconnect()}).finally(()=>{checking=false})
    },revalidateIntervalMs);this.authorizationTimer.unref()
  }
  private track(socket:Socket,epoch=this.connectionEpoch){
    if(this.stopped||epoch!==this.connectionEpoch||this.sockets.size>=128){socket.destroy();return}
    this.sockets.add(socket);socket.setTimeout(120000,()=>socket.destroy());socket.once('close',()=>this.sockets.delete(socket))
  }
  static async start(authorize:()=>void|Promise<void>,resolve?:AddressLookup,revalidateIntervalMs=2000){
    const proxy=new BrowserPublicProxy(authorize,resolve,revalidateIntervalMs)
    try{await new Promise<void>((yes,no)=>{proxy.server.once('error',no);proxy.server.listen(0,'127.0.0.1',()=>{proxy.server.off('error',no);yes()})})}
    catch(error){await proxy.close();throw error}
    const address=proxy.server.address();if(!address||typeof address==='string')throw new Error('浏览器代理启动失败')
    proxy.serverURL=`http://127.0.0.1:${address.port}`;return proxy
  }
  /** End existing requests immediately while retaining the authenticated listener. */
  disconnect(){this.connectionEpoch++;for(const socket of this.sockets)socket.destroy()}
  async close(){
    if(this.stopped)return;this.stopped=true;clearInterval(this.authorizationTimer)
    this.disconnect()
    await new Promise<void>(resolve=>this.server.close(()=>resolve()))
  }
}

export function publicBrowserURL(value:string):URL {
  if(value.length>8192)throw new Error('网址过长')
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&url.port!=='80'&&url.port!=='443'))throw new Error('浏览器仅允许公网 HTTP(S)')
  return url
}
