import {randomUUID} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {ComputerError,type ComputerProvider,type ComputerSpecification} from './container.js'

/** Displays 2..64 belong to Bots; :1 stays the container's base desktop. */
export const FIRST_BOT_DISPLAY=2
export const MAX_DESKTOPS_PER_COMPUTER=8
export const DEFAULT_DESKTOPS_PER_COMPUTER=4
export const DESKTOP_SCRIPT='/usr/local/bin/yaoyao-desktop'
export const desktopSocket=(display:number)=>`/run/user/1000/yaoyao-cua-${display}.sock`

export interface BotDesktop {display:number;socket:string;token:string;agentId:string}
interface Row {owner_key:string;environment_id:string;agent_id:string;display:number;token:string}
const uuid=z.string().uuid()
const evidence=z.object({running:z.boolean(),token:z.string().nullable()}).strict()

/**
 * One account's computer is one container; each Bot of that account gets its own
 * display, window session, HOME and CUA socket inside it. Assignments live in the
 * Runner's private database, never in a guest-writable file. A display keeps its
 * Bot across container restarts so the Bot's browser profile and HOME stay put.
 */
export class BotDesktops {
  private readonly queues=new Map<string,Promise<unknown>>()
  constructor(readonly db:DatabaseSync,readonly provider:ComputerProvider,public limit:()=>number=()=>DEFAULT_DESKTOPS_PER_COMPUTER){
    db.exec(`CREATE TABLE IF NOT EXISTS bot_desktops(
      owner_key TEXT NOT NULL, environment_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      display INTEGER NOT NULL CHECK(display BETWEEN 2 AND 64), token TEXT NOT NULL,
      PRIMARY KEY(owner_key,environment_id,agent_id), UNIQUE(owner_key,environment_id,display))`)
  }
  private key(spec:ComputerSpecification){return `${spec.ownerKey}\u0000${spec.id}`}
  private async serialized<T>(spec:ComputerSpecification,action:()=>Promise<T>):Promise<T>{
    const key=this.key(spec),prior=this.queues.get(key)??Promise.resolve()
    const operation=prior.catch(()=>{}).then(action);this.queues.set(key,operation)
    try{return await operation}finally{if(this.queues.get(key)===operation)this.queues.delete(key)}
  }
  private row(ownerKey:string,environmentId:string,agentId:string){
    return this.db.prepare('SELECT * FROM bot_desktops WHERE owner_key=? AND environment_id=? AND agent_id=?').get(ownerKey,environmentId,agentId) as unknown as Row|undefined
  }
  private view(row:Row):BotDesktop{return {display:row.display,socket:desktopSocket(row.display),token:row.token,agentId:row.agent_id}}
  current(ownerKey:string,environmentId:string,agentId:string):BotDesktop|undefined{const row=this.row(ownerKey,environmentId,agentId);return row?this.view(row):undefined}
  list(ownerKey:string,environmentId:string):BotDesktop[]{
    return (this.db.prepare('SELECT * FROM bot_desktops WHERE owner_key=? AND environment_id=? ORDER BY display').all(ownerKey,environmentId) as unknown as Row[]).map(row=>this.view(row))
  }
  /** Reserves a display before any guest work so two Bots never race for one screen. */
  private assign(spec:ComputerSpecification,agentId:string):Row{
    uuid.parse(agentId)
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const existing=this.row(spec.ownerKey,spec.id,agentId)
      if(existing){this.db.exec('COMMIT');return existing}
      const used=new Set((this.db.prepare('SELECT display FROM bot_desktops WHERE owner_key=? AND environment_id=?').all(spec.ownerKey,spec.id) as {display:number}[]).map(row=>row.display))
      const limit=Math.min(MAX_DESKTOPS_PER_COMPUTER,Math.max(1,this.limit()))
      if(used.size>=limit)throw new ComputerError('computer_desktop_capacity',`这台虚拟机最多同时分配 ${limit} 个机器人桌面，请先在其他机器人的电脑面板移除桌面，或由管理员调高上限`)
      let display=FIRST_BOT_DISPLAY;while(used.has(display))display++
      const row:Row={owner_key:spec.ownerKey,environment_id:spec.id,agent_id:agentId,display,token:randomUUID()}
      this.db.prepare('INSERT INTO bot_desktops VALUES(?,?,?,?,?)').run(row.owner_key,row.environment_id,row.agent_id,row.display,row.token)
      this.db.exec('COMMIT');return row
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  private async script(spec:ComputerSpecification,args:string[],authorize:()=>void){
    let result
    try{result=await this.provider.execute(spec,['python3',DESKTOP_SCRIPT,...args],{authorize,user:'cua',timeout:60000})}
    catch(error){
      const output=`${(error as any)?.stdout??''}${(error as any)?.stderr??''}`
      if(/No such file|can't open file/.test(output))throw new ComputerError('computer_image_upgrade_required','当前虚拟机镜像不支持多个机器人桌面，请在本地虚拟机设置中重新准备镜像')
      if(/display owned by another desktop/.test(output))throw new ComputerError('computer_desktop_owner_mismatch','机器人桌面归属不一致，请在电脑面板移除后重新创建')
      throw error
    }
    return JSON.parse(result.stdout.trim().split('\n').at(-1)??'{}')
  }
  async inspect(spec:ComputerSpecification,display:number,authorize:()=>void){return evidence.parse(await this.script(spec,['inspect',String(display)],authorize))}
  /** Starts (or confirms) the Bot's own desktop in its account computer. */
  async ensure(spec:ComputerSpecification,agentId:string,authorize:()=>void):Promise<BotDesktop>{
    return this.serialized(spec,async()=>{
      const row=this.assign(spec,agentId);authorize()
      const current=await this.inspect(spec,row.display,authorize)
      if(current.running&&current.token===row.token)return this.view(row)
      if(current.running)throw new ComputerError('computer_desktop_owner_mismatch','机器人桌面归属不一致，请在电脑面板移除后重新创建')
      await this.script(spec,['start',String(row.display),row.token,agentId],authorize)
      authorize();return this.view(row)
    })
  }
  /** Stops the Bot's desktop; its display, HOME and browser profile stay reserved. */
  async stop(spec:ComputerSpecification,agentId:string,authorize:()=>void):Promise<void>{
    return this.serialized(spec,async()=>{
      const row=this.row(spec.ownerKey,spec.id,agentId);if(!row)return
      const running=await this.provider.inspect(spec);if(!running?.running)return
      await this.script(spec,['stop',String(row.display)],authorize)
    })
  }
  /** Gives the display back. The Bot's HOME (browser profile) is kept for a later desktop. */
  async release(spec:ComputerSpecification,agentId:string,authorize:()=>void):Promise<void>{
    return this.serialized(spec,async()=>{
      const row=this.row(spec.ownerKey,spec.id,agentId);if(!row)return
      const running=await this.provider.inspect(spec)
      if(running?.running)await this.script(spec,['stop',String(row.display)],authorize)
      this.db.prepare('DELETE FROM bot_desktops WHERE owner_key=? AND environment_id=? AND agent_id=? AND token=?').run(row.owner_key,row.environment_id,row.agent_id,row.token)
    })
  }
  /** A retired environment loses every assignment; HOME directories go with its data. */
  forget(ownerKey:string,environmentId:string){this.db.prepare('DELETE FROM bot_desktops WHERE owner_key=? AND environment_id=?').run(ownerKey,environmentId)}
}
