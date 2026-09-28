import {existsSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createDecipheriv} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {ContainerComputerProvider} from './container.js'

/** Read-only metadata access. The updater must first quiesce the managed Web. */
export async function preserveManagedVmData(home:string){
  const path=join(home,'workspace.sqlite3')
  if(!existsSync(path))return {preserved:0}
  const db=new DatabaseSync(path,{readOnly:true})
  let configuration:{runnerId:string;computers?:{runtime:'docker'|'podman'}}|undefined
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_entities'").get())return {preserved:0}
    const row=db.prepare("SELECT data FROM workspace_entities WHERE owner='_system' AND kind='local-vm-managed' AND id='local'").get() as {data:string}|undefined
    if(!row)return {preserved:0}
    const sealed=Buffer.from(JSON.parse(row.data).sealed,'base64'),cipher=createDecipheriv('aes-256-gcm',readFileSync(join(home,'workspace-key.bin')),sealed.subarray(0,12))
    cipher.setAuthTag(sealed.subarray(12,28))
    configuration=z.object({runnerId:z.string().uuid(),computers:z.object({runtime:z.enum(['docker','podman'])}).optional()}).parse(JSON.parse(Buffer.concat([cipher.update(sealed.subarray(28)),cipher.final()]).toString()))
  }finally{db.close()}
  if(!configuration?.computers)return {preserved:0}
  const directory=join(home,'runner-state','local-vm',configuration.runnerId),database=join(directory,'runner-commands.sqlite3')
  if(!existsSync(database))return {preserved:0}
  const state=new DatabaseSync(database,{readOnly:true})
  try{
    if(!state.prepare("SELECT 1 FROM sqlite_master WHERE name='computer_environments'").get())return {preserved:0}
    const rows=state.prepare('SELECT value FROM computer_environments').all() as {value:string}[]
    const entries=rows.map(row=>JSON.parse(row.value))
    if(entries.some(entry=>['active','preparing','stopping'].includes(entry.status)))throw new Error('虚拟机仍在使用，不能迁移用户资料')
    const provider=new ContainerComputerProvider(configuration.computers.runtime,configuration.runnerId,directory)
    let preserved=0
    for(const entry of entries)if(await provider.preserveUserData(entry.spec))preserved++
    return {preserved}
  }finally{state.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!process.argv[2])throw new Error();console.log(JSON.stringify(await preserveManagedVmData(resolve(process.argv[2]))))}
  catch{console.error('虚拟机资料迁移未完成，已保留原服务和容器；请检查运行状态与可用空间后重试');process.exitCode=1}
}
