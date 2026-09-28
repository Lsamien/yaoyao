// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {ContainerComputerProvider} from '../../src/runner/computers/container'
import {preserveManagedVmData} from '../../src/runner/computers/migrateUserData'
it('preserves the quiesced managed runner before old service shutdown, without changing its databases',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-migration-')),runnerId=randomUUID(),key=randomBytes(32),nonce=randomBytes(12)
  const cipher=createCipheriv('aes-256-gcm',key,nonce),payload=Buffer.concat([cipher.update(JSON.stringify({runnerId,token:'private-fixture',computers:{runtime:'docker'}})),cipher.final()])
  const sealed=Buffer.concat([nonce,cipher.getAuthTag(),payload]).toString('base64')
  const workspace=new DatabaseSync(join(home,'workspace.sqlite3'))
  workspace.exec('CREATE TABLE workspace_entities(owner TEXT,kind TEXT,id TEXT,data TEXT)')
  workspace.prepare('INSERT INTO workspace_entities VALUES(?,?,?,?)').run('_system','local-vm-managed','local',JSON.stringify({sealed}));workspace.close()
  await writeFile(join(home,'workspace-key.bin'),key,{mode:0o600})
  const directory=join(home,'runner-state','local-vm',runnerId);await mkdir(directory,{recursive:true})
  const db=new DatabaseSync(join(directory,'runner-commands.sqlite3')),spec={id:randomUUID(),ownerKey:'fixture',imageId:'sha256:'+'a'.repeat(64)}
  db.exec('CREATE TABLE computer_environments(id TEXT,value TEXT)')
  const entry=JSON.stringify({spec,status:'idle'});db.prepare('INSERT INTO computer_environments VALUES(?,?)').run(spec.id,entry)
  const spy=vi.spyOn(ContainerComputerProvider.prototype,'preserveUserData').mockResolvedValue(true)
  try{
    expect(await preserveManagedVmData(home)).toEqual({preserved:1})
    expect(spy).toHaveBeenCalledWith(spec)
    expect(db.prepare('SELECT value FROM computer_environments').get()?.value).toBe(entry)
    spy.mockClear();db.prepare('UPDATE computer_environments SET value=?').run(JSON.stringify({spec,status:'active'}))
    await expect(preserveManagedVmData(home)).rejects.toThrow('仍在使用')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRejectedValue(new Error('disk full'));db.prepare('UPDATE computer_environments SET value=?').run(entry)
    await expect(preserveManagedVmData(home)).rejects.toThrow('disk full')
    expect(db.prepare('SELECT value FROM computer_environments').get()?.value).toBe(entry)
  }finally{spy.mockRestore();db.close();await rm(home,{recursive:true,force:true})}
})
