// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,access,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {GUEST_COMMAND} from '../../src/runner/computers/commandProcess'
const homes:string[]=[]
afterEach(async()=>{await Promise.all(homes.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
const python=promisify(execFile)
const launch=(root:string,key:string,script:string,timeout=3)=>python('python3',['-c',GUEST_COMMAND,'run',root,key,'root',String(timeout),'python3','-c',script],{timeout:10000})
const cancel=(root:string,key:string)=>python('python3',['-c',GUEST_COMMAND,'cancel',root,key],{timeout:10000})
const exists=(path:string)=>access(path).then(()=>true,()=>false)
async function fixture(){const root=await mkdtemp('/tmp/yaoyao-cmd-');homes.push(root);return root}

it.skipIf(process.platform==='win32')('cancels a guest process group while a peer command finishes and preserves command IO',async()=>{
  const root=await fixture(),key=randomUUID(),ready=join(root,'ready'),late=join(root,'late')
  const child=`import pathlib,time;time.sleep(.6);pathlib.Path(${JSON.stringify(late)}).touch()`
  const execution=launch(root,key,`import subprocess,pathlib,time;subprocess.Popen(['python3','-c',${JSON.stringify(child)}]);pathlib.Path(${JSON.stringify(ready)}).touch();time.sleep(30)`).catch(error=>error)
  const peer=launch(root,randomUUID(),"import time,sys;time.sleep(.3);print('peer');print('stderr',file=sys.stderr)")
  try{
    await vi.waitFor(async()=>expect(await exists(ready)).toBe(true))
    await expect(launch(root,key,"print('duplicate')")).rejects.toMatchObject({code:130})
    expect(JSON.parse((await cancel(root,key)).stdout)).toEqual({stopped:true})
    expect(await execution).toMatchObject({code:130})
    expect(await peer).toMatchObject({stdout:'peer\n',stderr:'stderr\n'})
    await new Promise(resolve=>setTimeout(resolve,600))
    expect(await exists(late)).toBe(false)
  }finally{await cancel(root,key).catch(()=>{});await Promise.allSettled([execution,peer])}
},10000)

it.skipIf(process.platform==='win32')('prevents launch when cancellation arrives first and acknowledges completed commands',async()=>{
  const root=await fixture(),key=randomUUID(),marker=join(root,'never')
  expect(JSON.parse((await cancel(root,key)).stdout)).toEqual({stopped:true})
  await expect(launch(root,key,`import pathlib;pathlib.Path(${JSON.stringify(marker)}).touch()`)).rejects.toMatchObject({code:130})
  expect(await exists(marker)).toBe(false)
  const completed=randomUUID()
  expect((await launch(root,completed,"print('done')")).stdout).toBe('done\n')
  expect(JSON.parse((await cancel(root,completed)).stdout)).toEqual({stopped:true})
})

it.skipIf(process.platform==='win32')('times out a process group and refuses to confirm a crashed supervisor',async()=>{
  const root=await fixture(),key=randomUUID(),late=join(root,'late')
  const child=`import pathlib,time;time.sleep(.6);pathlib.Path(${JSON.stringify(late)}).touch()`
  await expect(launch(root,key,`import subprocess,time;subprocess.Popen(['python3','-c',${JSON.stringify(child)}]);time.sleep(30)`,.15)).rejects.toMatchObject({code:124})
  await new Promise(resolve=>setTimeout(resolve,600))
  expect(await exists(late)).toBe(false)
  const crashed=randomUUID();await mkdir(join(root,crashed));await writeFile(join(root,crashed,'started'),'')
  await expect(cancel(root,crashed)).rejects.toMatchObject({code:1})
  expect(await exists(join(root,crashed,'done'))).toBe(false)
})
