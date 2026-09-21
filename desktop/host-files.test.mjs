import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {listHostFiles,readHostFile,writeHostFile,receiveHostFile,execHostShell,resolveWithin} from './host-files.mjs'

test('lists, reads and writes files inside the allowed root',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-host-files-'))
 try{
  await mkdir(join(root,'docs'))
  await writeFile(join(root,'docs','note.txt'),'你好，世界','utf8')
  const listing=await listHostFiles(root,'docs')
  assert.equal(listing.entries.length,1)
  assert.deepEqual(listing.entries[0],{name:'note.txt',type:'file',size:Buffer.byteLength('你好，世界'),mtime:listing.entries[0].mtime})
  const file=await readHostFile(root,'docs/note.txt')
  assert.equal(Buffer.from(file.data,'base64').toString('utf8'),'你好，世界')
  const written=await writeHostFile(root,{path:'docs/out/new.bin',data:Buffer.from([1,2,3]).toString('base64')})
  assert.equal(written.size,3)
  assert.deepEqual(Buffer.from(await readHostFile(root,'docs/out/new.bin').then(value=>Buffer.from(value.data,'base64'))),Buffer.from([1,2,3]))
  await assert.rejects(()=>listHostFiles(root,'missing'),/不存在/)
  await assert.rejects(()=>readHostFile(root,'docs'),/不是文件/)
  await assert.rejects(()=>writeHostFile(root,{path:'x.txt',data:'not base64!!'}),/base64/)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('path escapes are refused for every operation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-host-files-'))
 const outside=await mkdtemp(join(tmpdir(),'yaoyao-host-files-out-'))
 try{
  await writeFile(join(outside,'secret.txt'),'secret','utf8')
  await symlink(outside,join(root,'escape'))
  await writeFile(join(root,'keep.txt'),'keep','utf8')
  await assert.rejects(()=>resolveWithin(root,'../x'),/超出允许范围/)
  await assert.rejects(()=>resolveWithin(root,'/etc/passwd'),/超出允许范围/)
  await assert.rejects(()=>readHostFile(root,'escape/secret.txt'),/超出允许范围/)
  await assert.rejects(()=>listHostFiles(root,'escape'),/超出允许范围/)
  await assert.rejects(()=>writeHostFile(root,{path:'escape/evil.txt',data:Buffer.from('x').toString('base64')}),/超出允许范围/)
  await assert.rejects(()=>readHostFile(root,'keep.txt\u0000'),/路径无效/)
  assert.equal((await readHostFile(root,'keep.txt')).size,4)
 }finally{
  await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})
 }
})

test('receives verified binary and empty files atomically and preserves existing files unless overwrite was requested',async()=>{
 const source=await mkdtemp(join(tmpdir(),'yaoyao-copy-source-')),target=await mkdtemp(join(tmpdir(),'yaoyao-copy-target-'))
 try{
  await mkdir(join(source,'Desktop'))
  const bytes=Buffer.alloc(300_000);for(let i=0;i<bytes.length;i++)bytes[i]=i%256
  await writeFile(join(source,'Desktop','a.bin'),bytes)
  const file=await readHostFile(source,'Desktop/a.bin'),sha256=createHash('sha256').update(bytes).digest('hex')
  const input={path:'Desktop/a.bin',data:file.data,sha256,overwrite:false}
  assert.deepEqual(await receiveHostFile(target,input),{path:input.path,size:bytes.length,sha256})
  assert.deepEqual(await readFile(join(source,'Desktop','a.bin')),bytes)
  assert.deepEqual(await readFile(join(target,'Desktop','a.bin')),bytes)
  await assert.rejects(()=>receiveHostFile(target,{...input,sha256:'wrong'}),/校验失败/)
  const next=Buffer.from('replacement'),replacement={...input,data:next.toString('base64'),sha256:createHash('sha256').update(next).digest('hex')}
  await assert.rejects(()=>receiveHostFile(target,replacement),/已存在/)
  assert.deepEqual(await readFile(join(target,'Desktop','a.bin')),bytes)
  await receiveHostFile(target,{...replacement,overwrite:true})
  assert.deepEqual(await readFile(join(target,'Desktop','a.bin')),next)
  const empty={...input,path:'Desktop/empty',data:'',sha256:createHash('sha256').update('').digest('hex')}
  assert.equal((await receiveHostFile(target,empty)).size,0)
  assert.equal((await readFile(join(target,'Desktop','empty'))).length,0)
  await symlink(source,join(target,'escape'))
  await assert.rejects(()=>receiveHostFile(target,{...input,path:'escape/evil.bin'}),/超出允许范围/)
  assert.deepEqual((await readdir(join(target,'Desktop'))).sort(),['a.bin','empty'])
 }finally{await rm(source,{recursive:true,force:true});await rm(target,{recursive:true,force:true})}
})

test('shell execution reports stdout, exit codes, timeouts and cwd stays in root',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-host-files-'))
 try{
  await mkdir(join(root,'work'))
  const ok=await execHostShell(root,{command:'pwd',cwd:'work'})
  assert.equal(ok.exitCode,0)
  assert.ok(ok.stdout.includes(`${root}/work`),ok.stdout)
  const failing=await execHostShell(root,{command:'echo boom >&2; exit 7'})
  assert.equal(failing.exitCode,7);assert.equal(failing.stderr.trim(),'boom')
  const timed=await execHostShell(root,{command:'sleep 5',timeoutMs:1000})
  assert.equal(timed.timedOut,true);assert.notEqual(timed.exitCode,0)
  const escaped=await execHostShell(root,{command:'cd / && pwd'})
  assert.equal(escaped.exitCode,0)
  await assert.rejects(()=>execHostShell(root,{command:'  '}),/命令为空/)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('tilde home paths resolve inside the allowed root', async () => {
 const root = await mkdtemp(join(tmpdir(), 'yaoyao-host-files-'))
 await mkdir(join(root, 'Desktop'), { recursive: true })
 await writeFile(join(root, 'Desktop', 'a.txt'), 'x')
 const listing = await listHostFiles(root, '~/Desktop')
 assert.equal(listing.entries[0].name, 'a.txt')
 const home = await listHostFiles(root, '~')
 assert.ok(home.entries.some(e => e.name === 'Desktop'))
 await assert.rejects(() => listHostFiles(root, '/Desktop'), /超出允许范围|不存在/)
})
