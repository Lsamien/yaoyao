// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerMaintenance} from '../../src/runner/computers/maintenance'
import {recoverWorkspace} from '../../src/runner/computers/workspaceRecovery'
it('backs up only stopped owned data and validates restore before replacing it',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-maintenance-')),id=randomUUID(),workspace=join(home,'computer-workspaces',id),spec={id,ownerKey:'fixture',imageId:'sha256:'+'a'.repeat(64)}
  let status='active'
  const pool={status:()=>[{environmentId:id,status}]},provider={remove:vi.fn().mockResolvedValue(undefined)}
  const maintenance=new ComputerMaintenance(pool as any,provider as any,home),snapshot=join(home,'snapshot')
  try{
    await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'document.txt'),'before');await symlink('/guest/path',join(workspace,'guest-link'))
    await expect(maintenance.backup(spec,snapshot)).rejects.toThrow('停止状态')
    status='free';await maintenance.backup(spec,snapshot)
    await writeFile(join(workspace,'document.txt'),'after')
    const result=await maintenance.restore(spec,snapshot)
    expect(await readFile(join(workspace,'document.txt'),'utf8')).toBe('before')
    expect(await readFile(join(result.previousWorkspace,'document.txt'),'utf8')).toBe('after')
    expect((await lstat(join(workspace,'guest-link'))).isSymbolicLink()).toBe(true)
    await writeFile(join(snapshot,'workspace/document.txt'),'damaged')
    await expect(maintenance.restore(spec,snapshot)).rejects.toThrow('校验失败')
    expect(await readFile(join(workspace,'document.txt'),'utf8')).toBe('before')
    await expect(maintenance.backup(spec,snapshot)).rejects.toMatchObject({code:'EEXIST'})
  }finally{await rm(home,{recursive:true,force:true})}
})
it('recovers an interrupted content restore without replacing the bind-mount root',async()=>{
  const base=await mkdtemp(join(tmpdir(),'yaoyao-restore-')),id=randomUUID(),workspace=join(base,id),previous=join(base,`.before-restore-${id}-${randomUUID()}`),staging=join(base,`.restore-${randomUUID()}`)
  try{
    await mkdir(workspace);await writeFile(join(workspace,'file'),'original');await mkdir(staging);await writeFile(join(staging,'file'),'replacement')
    await writeFile(join(base,`.restore-${id}.json`),JSON.stringify({protocol:1,mode:'copy',previous:basename(previous),staging:basename(staging)}))
    await mkdir(previous);await writeFile(join(previous,'file'),'original');await writeFile(join(workspace,'file'),'partial replacement');const inode=(await lstat(workspace)).ino;await recoverWorkspace(base,id)
    expect((await lstat(workspace)).ino).toBe(inode)
    expect(await readFile(join(workspace,'file'),'utf8')).toBe('original')
    await expect(lstat(staging)).rejects.toMatchObject({code:'ENOENT'})
  }finally{await rm(base,{recursive:true,force:true})}
})
