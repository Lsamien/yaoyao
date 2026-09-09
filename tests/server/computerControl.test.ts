// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerRuntime} from '../../src/runner/worker/gateway'
it('separates view from control and fences stale, duplicate and out-of-frame input',async()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-control-')),db=new DatabaseSync(':memory:')
  const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'/fixture/python',hermesSource:'/fixture/source',hermesHome:'/fixture/home'}},home)
  let permitted=true
  try{
    await runtime.ready
    const model=vi.spyOn(runtime,'resolve').mockRejectedValue(new Error('model unavailable'))
    vi.spyOn(runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/projects/fixture',configuredCwd:'/projects/fixture'})
    vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id:'fixture',containerId:'fixture',running:true,workspace:'/fixture',isolation:'container'})
    vi.spyOn(runtime.provider,'stop').mockResolvedValue();vi.spyOn(runtime.provider,'remove').mockResolvedValue()
    vi.spyOn(runtime.provider,'capture').mockImplementation(async()=>({data:'image-fixture',width:100,height:80,capturedAt:Date.now()}))
    const execute=vi.spyOn(runtime.provider,'execute').mockResolvedValue({stdout:'{"ok":true}',stderr:''})
    const meta={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'owner'},id=randomUUID()
    await expect(runtime.controls.input(meta,id,randomUUID(),1,randomUUID(),{kind:'key',key:'Return'})).rejects.toMatchObject({code:'computer_control_required'})
    await runtime.controls.take(meta,'default',id,async()=>{if(!permitted)throw new Error('revoked')})
    await vi.waitFor(async()=>expect((await runtime.controls.status(meta)).mode).toBe('human'))
    expect(model).not.toHaveBeenCalled()
    const frame=await runtime.controls.frame(meta,()=>{})
    expect(execute).not.toHaveBeenCalled()
    await expect(runtime.controls.input(meta,id,randomUUID(),frame.generation-1,frame.id,{kind:'key',key:'Return'})).rejects.toMatchObject({code:'computer_control_stale'})
    await expect(runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,{kind:'click',x:101,y:1})).rejects.toMatchObject({code:'computer_point_invalid'})
    const requestId=randomUUID(),action={kind:'click',x:20,y:30}
    const first=await runtime.controls.input(meta,id,requestId,frame.generation,frame.id,action)
    expect(await runtime.controls.input(meta,id,requestId,frame.generation,frame.id,action)).toEqual(first)
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(runtime.controls.input(meta,id,requestId,frame.generation,frame.id,{kind:'click',x:30,y:30})).rejects.toMatchObject({code:'idempotency_conflict'})
    await expect(runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,{kind:'drag',fromX:2,fromY:3,toX:101,toY:4})).rejects.toMatchObject({code:'computer_point_invalid'})
    await runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,{kind:'drag',fromX:2,fromY:3,toX:20,toY:30})
    expect(execute.mock.calls.at(-1)?.[1]).toContain('xdotool')
    await runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,{kind:'key',key:'a',modifiers:['ctrl']})
    expect(execute.mock.calls.at(-1)?.[1]).toContain('hotkey')
    expect(JSON.parse(execute.mock.calls.at(-1)![1][3]!)).toMatchObject({keys:['ctrl','a']})
    permitted=false
    await expect(runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,action)).rejects.toThrow('revoked')
    await vi.waitFor(async()=>expect((await runtime.controls.status(meta)).mode).toBe('off'),{timeout:6500,interval:100})
    expect(runtime.provider.stop).toHaveBeenCalled()
    await expect(runtime.controls.input(meta,id,randomUUID(),frame.generation,frame.id,action)).rejects.toMatchObject({code:'computer_control_required'})
  }finally{await runtime.controls.close();await runtime.pool.close();db.close();rmSync(home,{recursive:true,force:true})}
},10000)
