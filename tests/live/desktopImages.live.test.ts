// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {ComputerRuntime} from '../../src/runner/worker/gateway'
import {LocalVmImages} from '../../src/runner/computers/localVm'
import {CUA_DRIVER,CUA_SOCKET} from '../../src/runner/computers/container'
// @ts-expect-error Standalone deployment script.
import {generateDesktopCompose} from '../../scripts/generate-desktop-compose.mjs'
const exec=promisify(execFile)
const enabled=!!process.env.YAOYAO_TEST_STANDARD_IMAGE&&!!process.env.YAOYAO_TEST_CURSOR_IMAGE
const docker=(args:string[])=>exec('docker',args,{timeout:90000,maxBuffer:8*1024*1024})
const evidence=resolve('test-results/desktop-image-options')

it.skipIf(!enabled)('runs both images independently, preserves a selection and workspace across recreation, and shares one choice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-images-live-')),db=new DatabaseSync(':memory:')
 const standard=(await docker(['image','inspect',process.env.YAOYAO_TEST_STANDARD_IMAGE!,'--format','{{.Id}}'])).stdout.trim()
 const cursor=(await docker(['image','inspect',process.env.YAOYAO_TEST_CURSOR_IMAGE!,'--format','{{.Id}}'])).stdout.trim()
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:standard,python:'/unused',hermesSource:'/unused',hermesHome:'/unused',network:'public-proxy'}},root)
 const manager=new LocalVmImages(runtime,db)
 const ids=[randomUUID(),randomUUID()],targets=ids.map(id=>({environmentId:id,agentId:id,ownerKey:'fixture'}))
 const ready=async(meta:typeof targets[number])=>{const spec=runtime.pool.definition('fixture',meta.environmentId)!;await vi.waitFor(async()=>{await runtime.provider.health(spec,()=>{});await runtime.provider.capture(spec,()=>{})},{timeout:65000,interval:1000});return spec}
 try{
  await manager.ready
  // Bind the exact two local images under test; normal preparation verification still runs.
  const command=manager.images.run.bind(manager.images)
  vi.spyOn(manager.images,'run').mockImplementation((engine,args)=>args[0]==='image'&&args[1]==='ls'?Promise.resolve(cursor):command(engine,args))
  await manager.prepare(randomUUID(),async()=>{},'cursor')
  await vi.waitFor(async()=>expect((await manager.status()).job?.state).toBe('complete'),{timeout:80000,interval:1000})
  vi.spyOn(runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:'.'})
  for(const [index,key] of (['standard','cursor'] as const).entries()){
   await manager.select(targets[index]!,key,()=>{})
   await runtime.desktop(targets[index]!,'default','create',()=>{})
  }
  await mkdir(evidence,{recursive:true})
  for(const [index,meta] of targets.entries()){
   const spec=await ready(meta)
   if(index===1){
    await runtime.provider.execute(spec,['/usr/local/bin/yaoyao-browser','--new-window','data:text/html,<title>Yaoyao Cursor verification</title><h1>Cursor Universal</h1><p>Desktop, browser and private workspace are ready.</p>'],{authorize:()=>{}})
    await vi.waitFor(()=>runtime.provider.execute(spec,['xdotool','search','--name','Yaoyao Cursor verification'],{authorize:()=>{}}),{timeout:30000,interval:1000})
    expect((await runtime.provider.execute(spec,['ps','-eo','args='],{authorize:()=>{}})).stdout).toContain('--proxy-server=http://127.0.0.1:3128')
   }
   const result=await runtime.provider.execute(spec,['sh','-c',`printf image-${index} > proof-${index}.txt; mkdir -p .browser-profiles; printf profile-${index} > .browser-profiles/proof-${index}.txt; test ! -e proof-${1-index}.txt`],{authorize:()=>{}})
   expect(result.stderr).toBe('')
   const frame=await runtime.provider.capture(spec,()=>{})
   await writeFile(join(evidence,index?'cursor.png':'standard.png'),Buffer.from(frame.data,'base64'))
  }
  expect(runtime.pool.status('fixture').filter(s=>s.status==='idle')).toHaveLength(2)
  expect(runtime.imageFor({...targets[1]!,agentId:randomUUID()})).toBe(cursor)
  await expect(manager.select(targets[1]!,'standard',()=>{})).rejects.toMatchObject({code:'computer_image_in_use'})
  await runtime.desktop(targets[1]!,'default','remove',()=>{})
  await runtime.desktop(targets[1]!,'default','create',()=>{})
  const restored=await ready(targets[1]!)
  expect(restored.imageId).toBe(cursor)
  expect((await runtime.provider.execute(restored,['cat','proof-1.txt','.browser-profiles/proof-1.txt'],{authorize:()=>{}})).stdout).toBe('image-1profile-1')
  await runtime.provider.execute(restored,[CUA_DRIVER,'call','press_key',JSON.stringify({key:'escape'}),'--socket',CUA_SOCKET],{authorize:()=>{}})
  expect(await readFile(join(root,'computer-workspaces',ids[0]!,'proof-0.txt'),'utf8')).toBe('image-0')
 }finally{
  await manager.close()
  for(const meta of targets)await runtime.desktop(meta,'default','remove',()=>{})
  await runtime.controls.close();await runtime.pool.close();db.close();await rm(root,{recursive:true,force:true})
 }
},240000)

it.skipIf(!enabled)('runs mixed Compose desktops with isolated volumes and the same private bridge protocol',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-compose-images-')),project='yaoyao-image-test-'+randomUUID().slice(0,8)
 const entries=[{id:randomUUID(),service:'desktop-1',name:'Standard'},{id:randomUUID(),service:'desktop-2',name:'Cursor',imageKey:'cursor'}]
 let yaml=generateDesktopCompose(await readFile('compose.yaml','utf8'),entries)
 yaml=yaml.replace('${YAOYAO_DESKTOP_IMAGE:-hermes-yaoyao-desktop:0.4.0}',process.env.YAOYAO_TEST_STANDARD_IMAGE!).replace('${YAOYAO_CURSOR_DESKTOP_IMAGE:-yaoyao-desktop:cursor}',process.env.YAOYAO_TEST_CURSOR_IMAGE!)
 const config=join(root,'compose.yaml');await writeFile(config,yaml)
 const compose=['compose','--project-name',project,'--project-directory',process.cwd(),'-f',config]
 try{
  await docker([...compose,'up','-d','--no-build','desktop-1','desktop-2'])
  for(const [index,entry] of entries.entries()){
   const id=(await docker([...compose,'ps','-q',entry.service])).stdout.trim()
   const call=async(op:string,body={})=>{
    const script="import http.client,socket,sys; c=http.client.HTTPConnection('localhost'); c.sock=socket.socket(socket.AF_UNIX); c.sock.connect('/run/desktop/desktop.sock'); c.request('POST',sys.argv[1],sys.argv[2]); r=c.getresponse(); print(r.read().decode())"
    // Match Web's uid and read-only IPC mount, outside the desktop's private parent.
    return JSON.parse((await docker(['run','--rm','--network','none','--cap-drop','ALL','--user','1000:1000','--mount',`type=volume,src=${project}_${entry.service}-ipc,dst=/run/desktop,readonly`,'--entrypoint','python3',process.env.YAOYAO_TEST_CURSOR_IMAGE!,'-c',script,'/'+op,JSON.stringify({...body,desktopId:entry.id})])).stdout)
   }
   await vi.waitFor(async()=>expect((await call('health')).ready).toBe(true),{timeout:65000,interval:1000})
   const lease=await call('acquire',{requestId:randomUUID(),owner:'fixture'})
   const state=JSON.parse((await docker(['inspect',id])).stdout)[0]
   expect(state.HostConfig.NetworkMode).toBe('none')
   expect(Object.keys(state.HostConfig.PortBindings??{})).toHaveLength(0)
   const output=await docker(['exec','--user','1000:1000',id,'sh','-c',`printf compose-${index} > /home/cua/workspace/proof-${index}; test ! -e /home/cua/workspace/proof-${1-index}`])
   expect(output.stderr).toBe('')
   expect((await call('frame',lease)).data).toBeTruthy()
   await call('release',{...lease,cancel:false})
  }
 }finally{await docker([...compose,'down','--volumes']);await rm(root,{recursive:true,force:true})}
},180000)
