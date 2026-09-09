import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {dataKey,DesktopServiceManager} from './service-manager.mjs'
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
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
