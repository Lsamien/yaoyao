// A private synthetic website and AES-encrypted application token. No accounts.
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
const open=process.argv[1]==='login-open',login=process.argv[1].startsWith('login'),home=process.env.HOME
const app=join(home,'.config/yaoyao-auth-fixture'),keyring=join(home,'.local/share/keyrings/yaoyao-auth-fixture')
if(login){
  await mkdir(app,{recursive:true});await mkdir(join(home,'.local/share/keyrings'),{recursive:true})
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv)
  const token=Buffer.concat([cipher.update('fixture-app-authorization'),cipher.final()])
  await writeFile(keyring,key,{mode:0o600})
  await writeFile(join(app,'token'),JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),token:token.toString('hex')}))
}
const saved=JSON.parse(await readFile(join(app,'token'),'utf8')),decipher=createDecipheriv('aes-256-gcm',await readFile(keyring),Buffer.from(saved.iv,'hex'))
decipher.setAuthTag(Buffer.from(saved.tag,'hex'))
if(Buffer.concat([decipher.update(Buffer.from(saved.token,'hex')),decipher.final()]).toString()!=='fixture-app-authorization')throw Error('app authorization lost')
const server=createServer((req,res)=>{
  if(req.url==='/session'){res.end(JSON.stringify((req.headers.cookie??'').includes('session=fixture-cookie')));return}
  if(login)res.setHeader('Set-Cookie','session=fixture-cookie; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/')
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>authorization fixture</body>')
})
await new Promise(resolve=>server.listen(18765,'127.0.0.1',resolve))
const browser=spawn('google-chrome',[...(open?[]:['--headless']),'--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--password-store=basic','--remote-debugging-pipe',`--user-data-dir=${join(home,'.config/yaoyao-auth-browser')}`],{stdio:['ignore','ignore','pipe','pipe','pipe']})
let buffer='',id=0,errors='';const waiting=new Map()
browser.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-1500)})
browser.stdio[4].on('data',chunk=>{
  buffer+=chunk.toString();let end
  while((end=buffer.indexOf('\0'))>=0){
    const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
    if(message.id){const handler=waiting.get(message.id);waiting.delete(message.id);if(message.error)handler?.reject(Error(JSON.stringify(message.error)));else handler?.resolve(message.result)}
  }
})
const closed=new Promise(resolve=>browser.once('close',resolve))
const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
  const next=++id;waiting.set(next,{resolve,reject});browser.stdio[3].write(JSON.stringify({id:next,method,params,...(sessionId?{sessionId}:{})})+'\0')
})
const timeout=setTimeout(()=>{process.stderr.write('browser fixture timed out: '+errors);browser.kill();process.exit(1)},40000)
try{
  const target=await command('Target.createTarget',{url:'about:blank'})
  const {sessionId}=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  await command('Page.enable',{},sessionId)
  await command('Page.navigate',{url:'http://127.0.0.1:18765/'},sessionId)
  // CDP awaits the actual IndexedDB transaction, not a virtual-time delay.
  const result=await command('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
    if(document.readyState!=='complete')await new Promise(resolve=>addEventListener('load',resolve,{once:true}));
    const login=${JSON.stringify(login)};
    if(login)localStorage.setItem('authorization','fixture-local');
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('tokens');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    if(login)await new Promise((resolve,reject)=>{const tx=db.transaction('tokens','readwrite');tx.objectStore('tokens').put('fixture-idb','auth');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    const token=await new Promise(resolve=>{const read=db.transaction('tokens').objectStore('tokens').get('auth');read.onsuccess=()=>resolve(read.result)});
    const cookie=await (await fetch('/session')).json();db.close();
    return cookie&&localStorage.getItem('authorization')==='fixture-local'&&token==='fixture-idb';
  })()`},sessionId)
  if(result.exceptionDetails||result.result?.value!==true)throw Error('browser authorization lost: '+JSON.stringify(result))
  if(open)await writeFile(join(app,'ready'),'ready')
  else await command('Browser.close')
  await closed
  console.log(JSON.stringify({browser:true,encryptedApplicationToken:true}))
}finally{clearTimeout(timeout);browser.kill();server.close()}
