// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerGateway,ComputerRuntime} from '../../src/runner/worker/gateway'
import {FileTransferFiles} from '../../src/shared/fileTransferEndpoint.mjs'
import {VM_FILE_TRANSFER_SCRIPT} from '../../src/runner/worker/fileTransfer'
import {hostTool} from '../../src/runner/worker/hostTools'

it('runs host commands and files in the explicitly selected working directory and interrupts child processes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-host-tools-')),controller=new AbortController()
 const context={cwd:home,signal:controller.signal,authorize:()=>{}}
 try{
  await hostTool('host_write_file',{path:'nested/source.txt',content:'host-proof'},context)
  expect(await hostTool('host_read_file',{path:'nested/source.txt'},context)).toEqual({stdout:'host-proof'})
  expect(await hostTool('host_shell',{command:'pwd; cat nested/source.txt'},context)).toMatchObject({exitCode:0,stdout:expect.stringContaining('host-proof')})
  const running=hostTool('host_shell',{command:'sleep 1; printf escaped > late.txt'},context)
  setTimeout(()=>controller.abort(),50);await expect(running).rejects.toThrow('中断')
  await new Promise(resolve=>setTimeout(resolve,1100));await expect(readFile(join(home,'late.txt'))).rejects.toMatchObject({code:'ENOENT'})
  await expect(hostTool('host_read_file',{path:'nested/source.txt'},context)).rejects.toThrow()
 }finally{await rm(home,{recursive:true,force:true})}
})

it('exposes host tools only with an explicit hybrid grant and removes access on the next VM-only turn',async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-hybrid-gateway-')),db=new DatabaseSync(':memory:'),script=join(home,'probe.py')
 await writeFile(script,`import json,sys
boot=json.loads(sys.stdin.readline())
print(json.dumps({"nonce":boot["nonce"],"type":"probe","boot":boot}),flush=True)
for line in sys.stdin:
    if json.loads(line).get("type")=="interrupt": break
`)
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'python3',hermesSource:home,hermesHome:home,network:'none'}},home,script)
 const vmRoot=join(home,'vm');await mkdir(vmRoot);const vmFiles=new FileTransferFiles(vmRoot)
 const id=randomUUID(),gateways:ComputerGateway[]=[]
 let allowed=true,sessionId:string|undefined
 try{
  await runtime.ready;await writeFile(join(home,'private.txt'),'explicit-host-proof')
  vi.spyOn(runtime,'resolve').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:home,model:{provider:'custom',api_mode:'chat_completions',model:'fixture'}})
  vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id,containerId:'fixture',running:true,workspace:home,isolation:'container'})
  vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
  const execute=vi.spyOn(runtime.provider,'execute').mockImplementation(async(_spec,argv,options)=>argv[2]===VM_FILE_TRANSFER_SCRIPT?{stdout:JSON.stringify(await vmFiles.call(JSON.parse(options.input!.toString()))),stderr:''}:{stdout:'vm-proof',stderr:''})
  for(const hostAccess of [false,true,false]){
   const gateway=new ComputerGateway(runtime,{environmentId:id,agentId:id,ownerKey:'owner',...(hostAccess?{hostAccess:true}:{})},randomUUID(),async()=>{if(!allowed)throw new Error('revoked')},async()=>({}))
   gateways.push(gateway);await gateway.connect()
   const opened=await gateway.rpc(sessionId?'session.resume':'session.create',{profile:'default',...(sessionId?{session_id:sessionId}:{})});sessionId=opened.session_id
   await gateway.rpc('prompt.submit',{session_id:sessionId,text:'exercise both environments'})
   const worker=runtime.workers.get(gateway.workId)!.process,probe=await worker.wait('probe',5000),names=probe.boot.tools.map((tool:any)=>tool.name)
   expect(names.includes('host_shell')).toBe(hostAccess);expect(names.includes('computer_copy_file')).toBe(hostAccess)
   if(hostAccess){
    expect(probe.boot.host.cwd).toBe(home)
    expect(await worker.onTool('host_read_file',{path:'private.txt'},randomUUID())).toEqual({stdout:'explicit-host-proof'})
    await worker.onTool('computer_copy_file',{from:'host',source:'private.txt',destination:'import.txt'},randomUUID())
    expect(await readFile(join(vmRoot,'import.txt'),'utf8')).toBe('explicit-host-proof')
    expect(await worker.onTool('computer_copy_file',{from:'vm',source:'import.txt',destination:'from-vm.txt'},randomUUID())).toEqual({ok:true})
    expect(await readFile(join(home,'from-vm.txt'),'utf8')).toBe('explicit-host-proof')
   }else{
    expect(probe.boot.host).toBeUndefined()
    await expect(worker.onTool('host_read_file',{path:join(home,'private.txt')},randomUUID())).rejects.toMatchObject({code:'computer_tool_forbidden'})
    await expect(worker.onTool('computer_copy_file',{from:'host',source:join(home,'private.txt'),destination:'bad.txt'},randomUUID())).rejects.toMatchObject({code:'computer_tool_forbidden'})
   }
   expect(await worker.onTool('computer_shell',{command:'pwd'},randomUUID())).toMatchObject({stdout:'vm-proof'})
   expect(execute).toHaveBeenLastCalledWith(expect.anything(),['/bin/bash','-lc','pwd'],expect.objectContaining({user:'cua'}))
   await worker.onTool('computer_shell',{command:'id -u',user:'root'},randomUUID())
   expect(execute).toHaveBeenLastCalledWith(expect.anything(),['/bin/bash','-lc','id -u'],expect.objectContaining({user:'root'}))
   if(!hostAccess&&gateways.length===3){allowed=false;await expect(worker.onTool('computer_shell',{command:'no'},randomUUID())).rejects.toThrow('revoked')}
   await gateway.close()
  }
 }finally{await Promise.all(gateways.map(g=>g.close()));await vmFiles.close();await runtime.controls.close();await runtime.pool.close();db.close();vi.restoreAllMocks();await rm(home,{recursive:true,force:true})}
})
