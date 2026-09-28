import {connect,type Socket,isIP} from 'node:net'
import {Agent,request} from 'node:https'
import {connect as tlsConnect} from 'node:tls'
import type {VmProxySettings} from '../../shared/executionEnvironment.js'
import {publicDestination,type AddressLookup} from './publicDestination.js'

/** A bounded handshake reader that does not consume the first application bytes. */
class Reader {
  private buffer=Buffer.alloc(0)
  private wake?:()=>void
  private error?:Error
  private data=(b:Buffer)=>{this.buffer=Buffer.concat([this.buffer,b]);if(this.buffer.length>65536)this.fail(new Error('proxy header limit'));this.wake?.()}
  private fail=(e:Error)=>{this.error=e;this.wake?.()}
  private end=()=>this.fail(new Error('proxy closed'))
  constructor(private socket:Socket){socket.on('data',this.data);socket.on('error',this.fail);socket.on('end',this.end)}
  async bytes(n:number){while(this.buffer.length<n){if(this.error)throw this.error;await new Promise<void>(r=>{this.wake=r})}const b=this.buffer.subarray(0,n);this.buffer=this.buffer.subarray(n);return b}
  async header(){const bytes:Buffer[]=[];for(let n=0;n<32768;n++){bytes.push(await this.bytes(1));if(n>=3&&Buffer.concat(bytes.slice(-4)).equals(Buffer.from('\r\n\r\n')))return Buffer.concat(bytes).toString('latin1')}throw new Error('proxy header limit')}
  close(){this.socket.pause();this.socket.off('data',this.data);this.socket.off('error',this.fail);this.socket.off('end',this.end);if(this.buffer.length)this.socket.unshift(this.buffer)}
}
export async function proxySocket(proxy:VmProxySettings,address:string,port:number):Promise<Socket>{
  if(!proxy.enabled)throw new Error('proxy disabled')
  const socket=connect({host:proxy.host.replace(/^\[|\]$/g,''),port:proxy.port})
  const timer=setTimeout(()=>socket.destroy(new Error('proxy timeout')),10000)
  const reader=new Reader(socket)
  try{
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
    if(proxy.protocol==='http'){
      const authority=`${isIP(address)===6?'['+address+']':address}:${port}`
      const auth=proxy.username||proxy.password?`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password??''}`).toString('base64')}\r\n`:''
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
      if(!/^HTTP\/1\.[01] 200(?: |\r)/.test(await reader.header()))throw new Error('proxy refused')
    }else{
      const authenticated=!!(proxy.username||proxy.password)
      socket.write(Buffer.from([5,1,authenticated?2:0]));const method=await reader.bytes(2)
      if(method[0]!==5||method[1]!== (authenticated?2:0))throw new Error('proxy auth unavailable')
      if(authenticated){const user=Buffer.from(proxy.username),password=Buffer.from(proxy.password??'');if(user.length>255||password.length>255)throw new Error('proxy auth length');socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([password.length]),password]));const auth=await reader.bytes(2);if(auth[0]!==1||auth[1]!==0)throw new Error('proxy auth failed')}
      // A numeric destination pins the address already checked by the broker.
      const host=Buffer.from(address),destination=isIP(address)===4?Buffer.from([1,...address.split('.').map(Number)]):Buffer.concat([Buffer.from([3,host.length]),host])
      const p=Buffer.alloc(2);p.writeUInt16BE(port);socket.write(Buffer.concat([Buffer.from([5,1,0]),destination,p]))
      const reply=await reader.bytes(4);if(reply[0]!==5||reply[1]!==0)throw new Error('proxy refused')
      const length=reply[3]===1?4:reply[3]===4?16:reply[3]===3?(await reader.bytes(1))[0]!:0;if(!length)throw new Error('proxy response');await reader.bytes(length+2)
    }
    reader.close();return socket
  }catch{reader.close();socket.destroy();throw new Error('代理连接或认证失败')}
  finally{clearTimeout(timer)}
}

/** DNS also traverses the configured proxy. No VM hostname is sent to local DNS. */
export const proxyLookup=(proxy:VmProxySettings):AddressLookup=>async host=>{
  const resolve=async(type:number)=>{
    const socket=await proxySocket(proxy,'8.8.8.8',443),agent=new Agent({keepAlive:false})
    agent.createConnection=()=>tlsConnect({socket,servername:'dns.google'})
    try{return await new Promise<Array<{address:string;family:number}>>((done,fail)=>{
      const req=request({hostname:'dns.google',path:`/resolve?name=${encodeURIComponent(host)}&type=${type}`,agent,timeout:10000},res=>{let text='';res.on('data',b=>{text+=b;if(text.length>65536)req.destroy(new Error('DNS response limit'))});res.on('error',fail);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();const data=JSON.parse(text);done((data.Answer??[]).filter((a:any)=>a.type===type&&isIP(a.data)).map((a:any)=>({address:a.data,family:isIP(a.data)})))}catch{fail(new Error('DNS failed'))}})});req.on('timeout',()=>req.destroy(new Error('DNS timeout')));req.on('error',fail);req.end()
    })}finally{agent.destroy();socket.destroy()}
  }
  return (await Promise.all([resolve(1),resolve(28)])).flat()
}
export async function checkProxy(proxy:VmProxySettings){const target=await publicDestination('example.com',443,proxyLookup(proxy));const socket=await proxySocket(proxy,target.address,target.port);socket.destroy();return {ok:true}}
