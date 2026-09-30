import {execFileSync} from 'node:child_process'
import {z} from 'zod'
import {readPrivateUtf8} from './privateFiles.js'
import {parse} from './schema.js'
import {HttpError} from '../errors.js'
import type {IsolationGate} from './executor.js'
const controls=['separate-identity','hermes-no-control-access','browser-private-no-cdp','restricted-egress'] as const
const approval=z.object({version:z.literal(1),approved:z.literal(true),brokerUid:z.number().int().positive(),hermesUid:z.number().int().positive(),hermesPid:z.number().int().positive(),
  approvedAt:z.number().int().positive(),expiresAt:z.number().int().positive(),controls:z.array(z.enum(controls)).length(4)}).strict()
const processUid=(pid:number)=>Number(execFileSync('/bin/ps',['-o','uid=','-p',String(pid)],{encoding:'utf8',timeout:2000,env:{PATH:'/usr/bin:/bin'}}).trim())
/** Manual operator approval is a deployment trust contract, NOT proof of OS,
 * IPC/CDP/firewall isolation. Also checks the observable process identity.
 * CLI uses the real probe; tests inject a dummy probe without inspecting users. */
export class OperatorIsolationGate implements IsolationGate {
  constructor(private path:string,private hermesUid:number,private hermesPid:number,private probe=processUid,private now=Date.now){}
  assert(){
    try{
      const a=parse(approval,JSON.parse(readPrivateUtf8(this.path,8192))),uid=process.getuid?.()
      if(!uid||uid!==a.brokerUid||uid===a.hermesUid||a.hermesUid!==this.hermesUid||a.hermesPid!==this.hermesPid||this.probe(a.hermesPid)!==a.hermesUid
        ||a.approvedAt>this.now()||a.expiresAt<=this.now()||a.expiresAt-a.approvedAt>31*86400000||new Set(a.controls).size!==controls.length)throw new Error()
    }catch{throw new HttpError(503,'执行隔离尚未获得有效人工批准或身份已变化','vault_isolation_required')}
  }
}
