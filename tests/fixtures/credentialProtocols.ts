// Local, ephemeral dummy protocols only; never contact an external account.
import {createServer} from 'node:https'
import {once} from 'node:events'
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,randomBytes} from 'node:crypto'
import ssh2 from 'ssh2'
import type {Connection,utils} from 'ssh2'
const {Server,utils:keyUtils}=ssh2
export async function websiteFixture(home:string){
  const key=join(home,'dummy-key.pem'),cert=join(home,'dummy-cert.pem'),cnf=join(home,'dummy-openssl.cnf')
  writeFileSync(cnf,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-config',cnf],{stdio:'ignore'})
  const username='dummy-site-user',secret='DUMMY-local-only-password',cookie=randomBytes(32).toString('hex')
  const submitted=Promise.withResolvers<void>()
  const state={logins:0,proofs:0,logouts:0,loginViews:0,formAction:'/login',iframe:false,redirect:'/account',delay:false,requests:[] as string[]}
  const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
    state.requests.push(req.method+' '+req.url)
    if(req.url==='/login'&&req.method==='GET'){state.loginViews++;res.setHeader('Content-Type','text/html');res.end(`<form id="login" method="post" action="${state.formAction}"><input name="username"><input type="password" name="password"><button type="submit">Login</button></form>${state.iframe?'<iframe src="/frame"></iframe>':''}`);return}
    if(req.url==='/login'&&req.method==='POST'){
      let body='';for await(const c of req)body+=c
      const form=new URLSearchParams(body)
      if(form.get('username')!==username||form.get('password')!==secret){res.writeHead(401);res.end();return}
      state.logins++;submitted.resolve();if(state.delay)return
      res.setHeader('Set-Cookie',`fixture_auth=${cookie}; HttpOnly; Secure; SameSite=Strict`);res.writeHead(303,{Location:state.redirect});res.end();return
    }
    if(req.url==='/account'&&req.headers.cookie===`fixture_auth=${cookie}`){state.proofs++;res.setHeader('Content-Type','text/html');res.end('<div id="login-success">Dummy authenticated</div>');return}
    if(req.url==='/logout'&&req.headers.cookie===`fixture_auth=${cookie}`){state.logouts++;res.setHeader('Set-Cookie','fixture_auth=; Max-Age=0; HttpOnly; Secure; SameSite=Strict');res.end('Logged out');return}
    res.writeHead(401);res.end()
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  return {state,submitted:submitted.promise,username,secret,cookie,cert:readFileSync(cert),origin:'https://127.0.0.1:'+(server.address() as any).port,
    usage:{kind:'website.form' as const,loginPath:'/login',submitPath:'/login',successPath:'/account',logoutPath:'/logout',formId:'login',usernameName:'username',passwordName:'password',successSelector:'#login-success'},
    close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}}
}
function dummySshKey(){
  // ssh2 1.17.0 strips leading zero bytes when serializing Ed25519 public
  // material. Validate generated dummy input, never retry an actual operation.
  for(let attempt=0;attempt<8;attempt++){
    const pair=keyUtils.generateKeyPairSync('ed25519')
    if(!(keyUtils.parseKey(pair.private) instanceof Error)&&!(keyUtils.parseKey(pair.public) instanceof Error))return pair
  }
  throw new Error('Unable to generate a valid dummy SSH key')
}
export async function sshFixture(auth: 'privateKey' | 'password' = 'privateKey',port=0){
  const host=dummySshKey(),key=dummySshKey(),parsed=keyUtils.parseKey(key.public) as utils.ParsedKey
  const fingerprint='SHA256:'+createHash('sha256').update((keyUtils.parseKey(host.private) as utils.ParsedKey).getPublicSSH()).digest('base64').replace(/=+$/,'')
  const clients=new Set<Connection>(),files=new Map<string,Buffer>([['/approved/input.txt',Buffer.from('DUMMY-private-file-contents')]])
  const executed=Promise.withResolvers<void>(),written=Promise.withResolvers<void>()
  const password='DUMMY-ssh-login-password-only'
  const state={auths:0,authMethods:[] as string[],commands:[] as string[],opens:[] as {path:string,flags:number,mode:number}[],writes:0,delayWrite:false,delayExec:false,readRedirect:false,
    execReplies:new Map<string,{stdout:string;stderr?:string;exitCode?:number}>()}
  const server=new Server({hostKeys:[host.private]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client))
    client.on('authentication',ctx=>{
      state.authMethods.push(ctx.method)
      const valid=ctx.username==='dummy-ssh-user'&&(auth==='password'
        ? ctx.method==='password'&&ctx.password===password
        : ctx.method==='publickey'&&ctx.key.data.equals(parsed.getPublicSSH())&&(!ctx.signature||parsed.verify(ctx.blob!,ctx.signature)===true))
      if(!valid){ctx.reject([auth==='password'?'password':'publickey']);return}
      state.auths++;ctx.accept()
    }).on('ready',()=>client.on('session',accept=>{
      const session=accept()
      session.on('exec',(accept,_reject,info)=>{state.commands.push(info.command);const stream=accept();executed.resolve();if(state.delayExec)return;const reply=state.execReplies.get(info.command);stream.write(reply?.stdout??'DUMMY-private-command-output');stream.stderr.write(reply?.stderr??'DUMMY-private-stderr');stream.exit(reply?.exitCode??0);stream.end()})
      session.on('sftp',accept=>{
        const s=accept(),handles=new Map<string,string>();let id=0
        s.on('error',()=>{})
        s.on('REALPATH',(req,path)=>s.name(req,[{filename:state.readRedirect&&path==='/approved/input.txt'?'/outside/private.txt':path,longname:path,attrs:{}}]))
        s.on('OPEN',(req,path,flags,attrs)=>{
          state.opens.push({path,flags,mode:attrs.mode})
          if(!path.startsWith('/approved/')||(flags&32)&&files.has(path)){s.status(req,4);return}
          if(flags&8)files.set(path,Buffer.alloc(0))
          if(!files.has(path)){s.status(req,2);return}
          const handle=Buffer.from(String(++id));handles.set(handle.toString(),path);s.handle(req,handle)
        })
        s.on('FSTAT',(req,handle)=>{const data=files.get(handles.get(handle.toString())??'');if(!data){s.status(req,4);return}s.attrs(req,{mode:0o100600,size:data.length,uid:1,gid:1,atime:1,mtime:1})})
        s.on('READ',(req,handle,offset,len)=>{const data=files.get(handles.get(handle.toString())??'');if(!data){s.status(req,4);return}if(offset>=data.length){s.status(req,1);return}s.data(req,data.subarray(offset,offset+len))})
        s.on('WRITE',(req,handle,offset,data)=>{
          const path=handles.get(handle.toString());if(!path){s.status(req,4);return}
          state.writes++;const old=files.get(path)!,next=Buffer.alloc(Math.max(old.length,offset+data.length));old.copy(next);data.copy(next,offset);files.set(path,next)
          written.resolve()
          if(!state.delayWrite)s.status(req,0)
        })
        s.on('CLOSE',(req,handle)=>{handles.delete(handle.toString());s.status(req,0)})
      })
    }))
  })
  server.listen(port,'127.0.0.1');await once(server,'listening')
  return {state,files,executed:executed.promise,written:written.promise,username:'dummy-ssh-user',secret:auth==='password'?password:key.private,target:{kind:'ssh' as const,host:'127.0.0.1',port:(server.address() as any).port,hostKey:fingerprint,...(auth==='password'?{auth}:{})},
    close:async()=>{for(const client of clients)client.end();await new Promise<void>(r=>server.close(()=>r()))}}
}
