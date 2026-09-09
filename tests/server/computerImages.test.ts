// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ComputerImages,fileSHA256,imageManifest,writeManifest} from '../../src/runner/computers/images'
const id='sha256:'+'a'.repeat(64)
const detail={Id:id,Os:'linux',Architecture:'arm64',Config:{Labels:{'com.openmausbot.cua-driver':'0.20.0','com.openmausbot.image-layer':'5'}}}
it('checks immutable identity, architecture and driver before accepting an image',async()=>{
  const run=vi.fn().mockResolvedValue(JSON.stringify([detail])),images=new ComputerImages('docker',run)
  expect(await images.inspect(id)).toMatchObject({protocol:1,imageId:id,architecture:'arm64'})
  await expect(images.inspect('mutable:latest')).rejects.toThrow()
  run.mockResolvedValue(JSON.stringify([{...detail,Id:'sha256:'+'b'.repeat(64)}]))
  await expect(images.inspect(id)).rejects.toThrow('身份')
  run.mockResolvedValue(JSON.stringify([{...detail,Architecture:'unknown'}]))
  await expect(images.inspect(id)).rejects.toThrow()
})
it('rejects damaged offline archives before invoking the engine',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-image-')),path=join(home,'image.tar'),run=vi.fn()
  try{
    await writeFile(path,'fixture image')
    const manifest=imageManifest.parse({protocol:1,imageId:id,architecture:'arm64',driver:'0.20.0',layer:'5',createdAt:1,archiveSha256:await fileSHA256(path)})
    await writeManifest(path+'.json',manifest);await writeFile(path,'damaged image')
    await expect(new ComputerImages('docker',run).import(path)).rejects.toThrow('校验失败')
    expect(run).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path+'.json','utf8'))).toEqual(manifest)
  }finally{await rm(home,{recursive:true,force:true})}
})
it('never overwrites an existing archive and health-checks imported identity',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-image-')),path=join(home,'image.tar')
  const run=vi.fn().mockResolvedValue(JSON.stringify([detail])),images=new ComputerImages('podman',run),verify=vi.spyOn(images,'verify').mockResolvedValue()
  try{
    await writeFile(path,'original')
    await expect(images.export(id,path)).rejects.toMatchObject({code:'EEXIST'})
    expect(await readFile(path,'utf8')).toBe('original')
    await writeManifest(path+'.json',{protocol:1,imageId:id,architecture:'arm64',driver:'0.20.0',layer:'5',createdAt:1,archiveSha256:await fileSHA256(path)})
    await images.import(path)
    expect(run).toHaveBeenCalledWith('podman',['load','--input',path]);expect(verify).toHaveBeenCalledOnce()
  }finally{await rm(home,{recursive:true,force:true})}
})
