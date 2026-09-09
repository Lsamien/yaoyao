import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {DesktopRunnerManager} from './runner-manager.mjs'

async function fixture(run){
  const home=await mkdtemp(join(tmpdir(),'yaoyao-native-runner-')),key=randomBytes(32),children=[]
  const encrypt=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes])}
  const decrypt=bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString()}
  const manager=new DesktopRunnerManager({home,encrypt,decrypt,validate:value=>{if(value.protocol!==1)throw new Error('invalid');return value},fork:()=>{
    const child=new EventEmitter();child.messages=[]
    child.postMessage=value=>{child.messages.push(value);if(value.type==='shutdown')queueMicrotask(()=>child.emit('exit',0))}
    child.kill=()=>{queueMicrotask(()=>child.emit('exit',0));return true}
    children.push(child);queueMicrotask(()=>child.emit('spawn'));return child
  }})
  const config={protocol:1,runnerId:randomUUID(),token:randomBytes(32).toString('base64url'),serverURL:'https://fixture.invalid',hermesURL:'http://127.0.0.1:9119',allowedProfiles:['default'],artifactRoots:[]}
  const file=join(home,'download.json');await writeFile(file,JSON.stringify(config))
  try{await run({home,manager,children,config,file})}finally{await manager.stop();await rm(home,{recursive:true,force:true})}
}
test('stores only encrypted credentials and restarts from private IPC configuration',()=>fixture(async({manager,children,config,file})=>{
  await manager.importFile(file)
  const encrypted=await readFile(manager.path)
  assert.equal(encrypted.includes(config.token),false)
  assert.equal((await stat(manager.path)).mode&0o077,0)
  assert.deepEqual(children[0].messages.find(m=>m.type==='configure').config,config)
  await manager.stop();await manager.start()
  assert.equal(children.length,2)
  assert.deepEqual(children[1].messages.find(m=>m.type==='configure').config,config)
  await manager.forget()
  await assert.rejects(readFile(manager.path),{code:'ENOENT'})
  await manager.start();assert.equal(children.length,2)
}))
test('a Keychain failure preserves a running node and its previous encrypted configuration',()=>fixture(async({manager,children,file})=>{
  await manager.importFile(file);const encrypted=await readFile(manager.path)
  manager.options.encrypt=()=>{throw new Error('keychain unavailable')}
  await assert.rejects(manager.importFile(file),/keychain/)
  assert.equal(children[0].finished,undefined)
  assert.deepEqual(await readFile(manager.path),encrypted)
}))
test('a queued import cannot start a node after stop was requested',()=>fixture(async({manager,children,file})=>{
  const imported=manager.importFile(file),stopped=manager.stop()
  await Promise.all([imported,stopped])
  assert.equal(children.length,0)
}))
