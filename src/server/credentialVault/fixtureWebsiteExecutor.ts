/** A working, deliberately local-only HTTPS login adapter for dummy integration
 * fixtures. Not wired into the production CLI and not a generic browser login.
 * It never uses global fetch/proxies, redirects, shell, CDP or model form input. */
import { request } from 'node:https'
import type { CredentialExecutorFixture } from './broker.js'
import type { VaultEntry, LeaseInput } from './schema.js'
export class FixtureWebsiteLoginExecutor implements CredentialExecutorFixture {
  private origin: string
  constructor(origin: string, private ca: Buffer) {
    const u=new URL(origin)
    if(u.protocol!=='https:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port)throw new Error('dummy executor requires exact loopback HTTPS origin')
    this.origin=u.origin
  }
  private send(path:string,signal:AbortSignal,body?:string,cookie?:string):Promise<{status:number;cookies:string[];body:string}>{
    return new Promise((resolve,reject)=>{
      signal.throwIfAborted()
      const req=request(new URL(path,this.origin),{method:body?'POST':'GET',ca:this.ca,rejectUnauthorized:true,signal,
        agent:false,headers:{...(body?{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}:{}),...(cookie?{Cookie:cookie}:{})}},res=>{
        let size=0;const chunks:Buffer[]=[]
        res.on('data',chunk=>{size+=chunk.length;if(size>8192)req.destroy(new Error('dummy response limit'));else chunks.push(Buffer.from(chunk))})
        res.on('error',reject);res.on('aborted',()=>reject(new Error('dummy response interrupted')))
        res.on('end',()=>resolve({status:res.statusCode??0,cookies:res.headers['set-cookie']??[],body:Buffer.concat(chunks).toString()}))
      })
      req.setTimeout(3000,()=>req.destroy(new Error('dummy login timeout')));req.on('error',reject);req.end(body)
    })
  }
  async execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal){
    if(input.operation!=='website.login'||entry.target.kind!=='website'||input.target.kind!=='website'||entry.target.origin!==this.origin||input.target.origin!==this.origin)
      throw new Error('dummy login target forbidden')
    const form=new URLSearchParams({username:entry.username,password:entry.secret}).toString()
    const login=await this.send('/login',signal,form)
    if(login.status!==200)throw new Error('dummy login rejected') // Never follow redirects.
    const cookie=login.cookies.map(v=>v.split(';')[0]!).find(v=>/^fixture_auth=[a-f0-9]{64}$/.test(v))
    if(!cookie)throw new Error('dummy authentication receipt missing')
    signal.throwIfAborted()
    const proof=await this.send('/protected',signal,undefined,cookie)
    if(proof.status!==200||proof.body!=='dummy-authenticated')throw new Error('dummy authenticated session unverified')
    signal.throwIfAborted() // No cookies, body, username or password returned to the Bot.
  }
}
