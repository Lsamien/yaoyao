// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {ComputerRuntime} from '../../src/runner/worker/gateway'
it('rejects foreign retirement and resumes failed workspace cleanup from its durable record',async()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-helper-cleanup-')),db=new DatabaseSync(':memory:')
  const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:'sha256:'+'a'.repeat(64),python:'/fixture/python',hermesSource:'/fixture/source',hermesHome:'/fixture/home'}},home)
  try{
    await runtime.ready
    vi.spyOn(runtime.provider,'ensure').mockResolvedValue({id:'fixture',containerId:'fixture',running:true,workspace:'/fixture',isolation:'container'})
    const stop=vi.spyOn(runtime.provider,'stop').mockResolvedValue(undefined)
    vi.spyOn(runtime.provider,'remove').mockResolvedValue(undefined)
    const remove=vi.spyOn(runtime.provider,'deleteWorkspace').mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined)
    const meta={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'owner'}
    const spec={id:meta.environmentId,ownerKey:meta.ownerKey,imageId:runtime.config.imageId}
    const lease=await runtime.pool.acquire(spec,'task',()=>{})
    await expect(runtime.retire({...meta,ownerKey:'foreign'})).rejects.toMatchObject({code:'computer_owner_mismatch'})
    expect(stop).not.toHaveBeenCalled()
    await runtime.pool.release(lease)
    await expect(runtime.retire(meta)).rejects.toThrow('storage unavailable')
    expect(runtime.pool.definition(meta.ownerKey,meta.environmentId)).toBeUndefined()
    expect(()=>runtime.assertTarget(meta)).toThrow('临时电脑已退役')
    await runtime.retire(meta)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove.mock.calls[1]![0]).toMatchObject(spec)
    await runtime.retire(meta)
    expect(remove).toHaveBeenCalledTimes(2)
  }finally{await runtime.pool.close();db.close();rmSync(home,{recursive:true,force:true})}
})
