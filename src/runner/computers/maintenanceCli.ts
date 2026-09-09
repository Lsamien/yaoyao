import {parseArgs} from 'node:util'
import {readFileSync,statSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {parseRunnerConfiguration} from '../config.js'
import {acquireServiceInstance} from '../../server/serviceInstance.js'
import {ContainerComputerProvider} from './container.js'
import {ComputerPool} from './pool.js'
import {ComputerMaintenance} from './maintenance.js'
let lock:ReturnType<typeof acquireServiceInstance>|undefined,db:DatabaseSync|undefined,pool:ComputerPool|undefined
try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},home:{type:'string'},environment:{type:'string'},snapshot:{type:'string'}}})
  if(!values.config||!['list','backup','restore','rebuild'].includes(positionals[0]??''))throw new Error('用法：runner-maintenance list|backup|restore|rebuild --config runner.json [--home Runner数据目录] [--environment UUID] [--snapshot 备份目录]')
  if(process.platform!=='win32'&&(statSync(values.config).mode&0o077)!==0)throw new Error('执行节点配置必须仅当前用户可读')
  const config=parseRunnerConfiguration(JSON.parse(readFileSync(values.config,'utf8'))),home=values.home?resolve(values.home):resolve(dirname(values.config),'state',config.runnerId)
  if(!config.computers)throw new Error('该节点未配置电脑')
  lock=acquireServiceInstance(home,'1.0.0')
  db=new DatabaseSync(join(home,'runner-commands.sqlite3'))
  const provider=new ContainerComputerProvider(config.computers.runtime,config.runnerId,home)
  pool=new ComputerPool(db,provider);await pool.recover()
  const entries=(db.prepare('SELECT value FROM computer_environments').all() as {value:string}[]).map(row=>JSON.parse(row.value))
  let result
  if(positionals[0]==='list')result=entries.map(row=>({environmentId:row.spec.id,status:row.status,imageId:row.spec.imageId}))
  else{
    const id=z.string().uuid().parse(values.environment),entry=entries.find(row=>row.spec.id===id)
    if(!entry)throw new Error('当前 Runner 中没有这台电脑')
    const maintenance=new ComputerMaintenance(pool,provider,home)
    if(positionals[0]==='rebuild')result=await maintenance.rebuild(entry.spec)
    else{if(!values.snapshot)throw new Error('需要 --snapshot 备份目录');result=positionals[0]==='backup'?await maintenance.backup(entry.spec,values.snapshot):await maintenance.restore(entry.spec,values.snapshot)}
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n')
}catch(error){process.stderr.write(`${error instanceof Error?error.message:'电脑维护失败'}\n`);process.exitCode=1}
finally{try{await pool?.close()}catch{process.stderr.write('尚未确认所有电脑已停止，请核对运行时\n');process.exitCode=1}db?.close();lock?.release()}
