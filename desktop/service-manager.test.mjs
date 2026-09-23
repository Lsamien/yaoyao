import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {dataKey,DesktopServiceManager} from './service-manager.mjs'
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DesktopOnboarding} from './onboarding.mjs'
test('local inspection defers Hermes and Runner until entry and does not retain activation after disconnect',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-deferred-start-')))
  const record={protocol:1,instanceId:'deferred-fixture',pid:process.pid,dataKey:dataKey(home),version:'0.4.71',token:'private-token'}
  let required=true,hermesStarts=0,runnerStarts=0
  const server=createServer((req,res)=>{
    assert.equal(req.headers['x-yaoyao-desktop-token'],record.token)
    const {token,...identity}=record
    res.setHeader('Content-Type','application/json')
    if(req.url==='/desktop/service/activate'&&req.method==='POST'){required=false;hermesStarts++;res.end(JSON.stringify({activated:true}))}
    else{assert.equal(req.url,'/desktop/service');assert.equal(req.method,'GET');res.end(JSON.stringify({...identity,activationRequired:required}))}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  record.url=`http://127.0.0.1:${server.address().port}`
  await writeFile(join(home,'service-instance.json'),JSON.stringify(record))
  const manager=new DesktopServiceManager({home,version:record.version})
  const flow=new DesktopOnboarding({remoteServer:()=>'',prepareLocal:async()=>{await manager.start();return manager.state.url},inspect:async()=>({authenticated:true}),
    activate:async()=>{await manager.activate();runnerStarts++},navigate:async()=>{}})
  try{
    flow.select('local');await flow.prepare()
    assert.equal(flow.state.phase,'ready');assert.equal(hermesStarts,0);assert.equal(runnerStarts,0)
    await flow.submit()
    assert.equal(hermesStarts,1);assert.equal(runnerStarts,1)
    await manager.activate();assert.equal(hermesStarts,1)
    // A process replacement while actively using local mode retains this entry's intent.
    required=true;await manager.check();assert.equal(hermesStarts,2)
    await manager.stop();required=true
    flow.open({mode:'local'});await flow.prepare()
    assert.equal(hermesStarts,2);assert.equal(runnerStarts,1)
    await flow.submit()
    assert.equal(hermesStarts,3);assert.equal(runnerStarts,2)
  }finally{await manager.stop();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true})}
})
test('checks recorded and bundled versions while permitting a separately owned older service',async()=>{
  const root='/fixture/desktop',record={protocol:1,instanceId:'fixture',pid:1234,dataKey:dataKey(root),version:'0.3.32',token:'fixture'}
  let actual={...record};delete actual.token
  const server=createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(actual))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  record.url=`http://127.0.0.1:${server.address().port}`
  const manager=new DesktopServiceManager({version:'0.3.33'});manager.root=root
  try{
    assert.equal((await manager.verify(record)).version,'0.3.32')
    actual={...actual,version:'0.3.31'}
    await assert.rejects(manager.verify(record),/身份/)
    actual={...actual,version:'0.3.32'};manager.child={pid:record.pid}
    await assert.rejects(manager.verify(record),/版本不匹配/)
  }finally{await new Promise(resolve=>server.close(resolve))}
})
test('busy synchronization connects the verified existing Web and remains retryable without accepting other errors',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-startup-busy-')))
  const record={protocol:1,instanceId:'busy-fixture',pid:process.pid,dataKey:dataKey(home),version:'0.3.31',token:'fixture'}
  const server=createServer((request,response)=>{const {token,...identity}=record;response.setHeader('Content-Type','application/json');response.end(JSON.stringify(identity))})
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  record.url=`http://127.0.0.1:${server.address().port}`
  await writeFile(join(home,'service-instance.json'),JSON.stringify(record))
  let attempts=0
  const options={home,version:'0.3.32',fork:()=>{throw new Error('must not fork')},synchronize:async()=>{if(++attempts===1)throw Object.assign(new Error('已有任务，同步待完成'),{code:'service_busy'})}}
  const manager=new DesktopServiceManager(options)
  try{
    const state=await manager.start()
    assert.equal(state.phase,'ready');assert.equal(state.external,true);assert.match(state.updateNotice,/同步待完成/)
    assert.equal((await manager.retrySynchronization()).updateNotice,undefined);assert.equal(attempts,2)
    await manager.stop()
    assert.equal(manager.state.phase,'disconnected')
    assert.doesNotMatch(manager.state.message,/服务已停止/)
    assert.equal((await manager.reconnect()).phase,'ready')
    assert.equal(manager.state.pid,process.pid)
    await assert.rejects(manager.stopBackground(),/不由本 App 管理/)
    assert.equal(manager.state.phase,'error')
    assert.equal((await manager.reconnect()).phase,'ready')
    const invalid=new DesktopServiceManager({...options,synchronize:async()=>{throw new Error('invalid package')}})
    await assert.rejects(invalid.start(),/invalid package/)
    assert.equal(invalid.state.phase,'error')
  }finally{await new Promise(done=>server.close(done));await rm(home,{recursive:true,force:true})}
})
test('publishes stopped only after the native service manager confirms shutdown',async()=>{
 let finish,fail=false
 const manager=new DesktopServiceManager({stopBackground:()=>fail?Promise.reject(new Error('still alive')):new Promise(resolve=>{finish=resolve})})
 const stopping=manager.stopBackground()
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(manager.state.phase,'stopping')
 finish();await stopping
 assert.equal(manager.state.phase,'stopped')
 fail=true;await assert.rejects(manager.stopBackground(),/still alive/)
 assert.equal(manager.state.phase,'error')
 assert.doesNotMatch(manager.state.message,/服务已停止/)
})
test('a late activate health check cannot reconnect after quit has begun',async()=>{
 const manager=new DesktopServiceManager({})
 manager.state={phase:'ready'}
 let finish,starts=0
 manager.check=()=>new Promise(resolve=>{finish=resolve})
 manager.start=async()=>{starts++}
 const reconnect=manager.reconnect()
 await manager.stop();finish();await reconnect
 assert.equal(starts,0);assert.equal(manager.state.phase,'disconnected')
})
test('unknown same-version builds offer an explicit one-shot overwrite without changing ordinary retries',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-force-sync-'))),attempts=[]
 const manager=new DesktopServiceManager({home,version:'0.4.18',synchronize:async(_progress,options)=>{
  attempts.push(options.force)
  if(attempts.length===1)throw Object.assign(new Error('同版本构建需要选择'),{code:'service_build_unknown'})
 }})
 manager.readRecord=async()=>({url:'http://127.0.0.1:1'})
 manager.verify=async()=>({url:'http://127.0.0.1:1',version:'0.4.18',pid:process.pid})
 try{
  await assert.rejects(manager.start(),/需要选择/)
  assert.equal(manager.state.canForceSync,true);assert.equal(manager.canForceSynchronization,true)
  await manager.retrySynchronization({force:true});assert.equal(manager.state.phase,'ready')
  await manager.retrySynchronization();assert.deepEqual(attempts,[false,true,false])
  manager.state={phase:'error',message:'签名校验失败'}
  await assert.rejects(manager.retrySynchronization({force:true}),/当前状态不能覆盖/)
 }finally{await rm(home,{recursive:true,force:true})}
})
