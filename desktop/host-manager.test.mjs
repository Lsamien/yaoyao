import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {HostEnvironmentReporter} from './host-environment.mjs'
import {DesktopHostManager} from './host-manager.mjs'
import {parseDesktopHostConfiguration} from './host-config.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('computer configuration validation mirrors the runner rules',()=>{
 const base={protocol:1,serverURL:'https://yaoyao.example.com',hostId:randomUUID(),token:randomBytes(32).toString('base64url')}
 assert.deepEqual(parseDesktopHostConfiguration(base),{...base,allowInsecureLan:false})
 assert.deepEqual(parseDesktopHostConfiguration({...base,serverURL:'http://127.0.0.1:15300'}).serverURL,'http://127.0.0.1:15300')
 assert.throws(()=>parseDesktopHostConfiguration({...base,protocol:2}),/协议不兼容/)
 assert.throws(()=>parseDesktopHostConfiguration({...base,serverURL:'http://192.168.1.4:15300'}),/HTTPS/)
 assert.equal(parseDesktopHostConfiguration({...base,serverURL:'http://192.168.1.4:15300',allowInsecureLan:true}).allowInsecureLan,true)
 assert.throws(()=>parseDesktopHostConfiguration({...base,serverURL:'https://example.com/path'}),/服务地址/)
 assert.throws(()=>parseDesktopHostConfiguration({...base,hostId:'not-a-uuid'}),/电脑编号/)
 assert.throws(()=>parseDesktopHostConfiguration({...base,token:'short'}),/电脑凭据/)
})

async function fixture(config){
 const home=await mkdtemp(join(tmpdir(),'yaoyao-desktop-host-')),key=randomBytes(32)
 const encrypt=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes])}
 const decrypt=bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString()}
 const cores=[],handled=[]
 const manager=new DesktopHostManager({home,root:'/app',dataRoot:home,
  encrypt,decrypt,
  createCore:()=>{const reporter=new HostEnvironmentReporter('/Users/fixture');const core={id:randomUUID(),closed:false,results:[],exchanges:0,
    info(){core.exchanges++;return {id:core.id,name:'测试 Mac',platform:'darwin',screen:true,accessibility:true,approved:[],...reporter.fields()}},
    acceptCapabilities(capabilities){reporter.accept(capabilities)},
    takeResults(){return core.results.splice(0,core.results.length)},
    async handle(commands){handled.push(...commands??[])},
    async revoke(){core.id=randomUUID()},
    async close(){core.closed=true}}
  cores.push(core);return core}})
 const configPath=join(home,'desktop-host.json')
 if(config)await writeFile(configPath,JSON.stringify(config))
 return {manager,home,configPath,cores,handled}
}

test('concurrent first logins share one persistent installation identity',async()=>{
 const {manager,home}=await fixture()
 try{
  const managers=Array.from({length:20},()=>new DesktopHostManager(manager.options))
  const ids=await Promise.all(managers.map(item=>item.installIdentity()))
  assert.equal(new Set(ids).size,1,'one installation must not register as multiple computers')
  assert.equal(await readFile(join(home,'desktop-install-id'),'utf8'),ids[0])
  await manager.forget()
  assert.equal(await new DesktopHostManager(manager.options).installIdentity(),ids[0])
  if(process.platform!=='win32')assert.equal((await stat(join(home,'desktop-install-id'))).mode&0o077,0)
 }finally{await rm(home,{recursive:true,force:true})}
})

test('a damaged installation identity is not silently replaced by a new computer',async()=>{
 const {manager,home}=await fixture()
 try{
  await writeFile(join(home,'desktop-install-id'),'damaged')
  await assert.rejects(()=>manager.installIdentity(),/设备标识/)
  assert.equal(await readFile(join(home,'desktop-install-id'),'utf8'),'damaged')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('imports an encrypted config, exchanges with the paired server and stops on revocation',async()=>{
 const token=randomBytes(32).toString('base64url'),hostId=randomUUID()
 const exchanges=[]
 const server=createServer((req,res)=>{
  if(!req.url.includes(`/api/desktop-host/v1/${hostId}/exchange`)){res.statusCode=404;res.end();return}
  if(req.headers.authorization!==`Bearer ${token}`||req.headers['x-desktop-host-protocol']!=='1'){res.statusCode=403;res.end(JSON.stringify({error:'unauthorized'}));return}
  let body='';req.on('data',chunk=>{body+=chunk});req.on('end',()=>{
   exchanges.push(JSON.parse(body))
   res.setHeader('content-type','application/json')
   res.end(JSON.stringify({capabilities:{desktopPlatforms:['darwin','win32']},...(exchanges.length===1?{commands:[{id:randomUUID(),deadline:Date.now()+30000,mode:'local',owner:'a'.repeat(64),resource:'local',profile:'persistent',operation:'open'}]}:{commands:[]})}))
  })
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const {manager,home,configPath,cores,handled}=await fixture({protocol:1,serverURL:`http://127.0.0.1:${server.address().port}`,hostId,token})
 try{
  await manager.importFile(configPath)
  const mode=await stat(join(home,'desktop-host.enc'))
  if(process.platform!=='win32')assert.equal(mode.mode&0o077,0)
  await sleep(1500)
  assert.ok(cores.length>=1)
  assert.equal(cores[0].closed,false)
  assert.equal(exchanges.length>=2,true)
  assert.equal(exchanges[0].host.name,'测试 Mac')
  assert.equal(handled.length,1)
  assert.equal(handled[0].operation,'open')
  assert.match(manager.state,/已连接/)
  await manager.forget()
  assert.equal(cores[0].closed,true)
  assert.equal(manager.state,'未配置电脑')
  await assert.rejects(()=>readFile(join(home,'desktop-host.enc')),{code:'ENOENT'})
 }finally{
  await manager.stop().catch(()=>{})
  server.close();server.closeAllConnections?.()
 }
})

test('a revoked token stops the loop with a clear state instead of retrying',async()=>{
 const token=randomBytes(32).toString('base64url')
 let requests=0
 const server=createServer((req,res)=>{requests++;res.statusCode=403;res.end(JSON.stringify({error:'revoked'}))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const {manager,configPath,cores}=await fixture({protocol:1,serverURL:`http://127.0.0.1:${server.address().port}`,hostId:randomUUID(),token})
 try{
  await manager.importFile(configPath)
  await sleep(1200)
  assert.match(manager.state,/授权已失效/)
  assert.equal(cores[0].closed,true)
  const settled=requests
  await sleep(1200)
  assert.equal(requests,settled)
 }finally{
  await manager.stop().catch(()=>{})
  server.close();server.closeAllConnections?.()
 }
})

test('network failures back off but keep retrying',async()=>{
 const token=randomBytes(32).toString('base64url')
 const {manager,home,configPath,cores}=await fixture({protocol:1,serverURL:'http://127.0.0.1:1',hostId:randomUUID(),token})
 try{
  await manager.importFile(configPath)
  await sleep(900)
  assert.match(manager.state,/正在重试/)
  assert.equal(cores[0].closed,false)
  await manager.stop()
  assert.equal(cores[0].closed,true)
 }finally{
  await rm(home,{recursive:true,force:true})
 }
})

test('negotiates metadata and retries in legacy format when the server stops supporting it',async()=>{
 const exchanges=[]
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  exchanges.push(JSON.parse(body));res.setHeader('content-type','application/json')
  if(exchanges.length===2){res.statusCode=400;res.end(JSON.stringify({error:'older server'}));return}
  res.end(JSON.stringify(exchanges.length===1?{commands:[],capabilities:{environmentMetadata:1}}:{commands:[]}))
 })})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const f=await fixture({protocol:1,serverURL:`http://127.0.0.1:${server.address().port}`,hostId:randomUUID(),token:randomBytes(32).toString('base64url')})
 try{
  await f.manager.importFile(f.configPath)
  clearTimeout(f.manager.timer)
  for(let i=0;i<3;i++){await f.manager.cycle();clearTimeout(f.manager.timer)}
  assert.equal(exchanges[0].host.environment,undefined)
  assert.equal(exchanges[0].host.fileTransferVersion,undefined)
  assert.equal(exchanges[1].host.environment.homeDirectory,'/Users/fixture')
  assert.equal(exchanges[1].host.fileTransferVersion,1)
  assert.equal(exchanges[2].host.environment,undefined)
  assert.equal(exchanges[2].host.fileTransferVersion,undefined)
 }finally{await f.manager.stop();await new Promise(resolve=>server.close(resolve));await rm(f.home,{recursive:true,force:true})}
})
