// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {existsSync,statSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {CodexAuthorization,CODEX_DEVICE_URL} from '../../src/server/codexAuthorization'

let auth:CodexAuthorization,version:number,admin:boolean
const processes:Array<{child:any;directory:string;options:any;args:string[]}>=[]
const secret=JSON.stringify({tokens:{access_token:'fixture-access-secret',refresh_token:'fixture-refresh-secret'}})
beforeEach(()=>{
  version=1;admin=true;processes.length=0
  const launch=vi.fn((_command,args,options)=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,
      kill:vi.fn(()=>{child.signalCode='SIGTERM';child.emit('close',null);return true})})
    processes.push({child,directory:options.cwd,options,args});return child
  })
  auth=new CodexAuthorization({isAdminActive:()=>admin,pushAuthorizationVersion:()=>version} as any,launch as any)
})
afterEach(()=>{auth.close();vi.useRealTimers();vi.unstubAllEnvs()})
function pending(){const id=randomUUID();auth.begin('alice',id);const p=processes.at(-1)!;p.child.stdout.write(`Open ${CODEX_DEVICE_URL}\n\x1b[94mABCD-`);p.child.stdout.write('12345\x1b[0m\n');return {id,...p}}
function complete(p:ReturnType<typeof pending>){writeFileSync(join(p.directory,'auth.json'),secret);p.child.exitCode=0;p.child.emit('close',0)}
it('starts an isolated CLI login, parses split styled output and returns no credentials',()=>{
  vi.stubEnv('CODEX_ACCESS_TOKEN','host-secret')
  const p=pending()
  expect(p.args).toEqual(['login','--device-auth','-c','cli_auth_credentials_store="file"'])
  expect(p.options.env.CODEX_HOME).toBe(p.directory);expect(p.options.env.CODEX_ACCESS_TOKEN).toBeUndefined()
  expect(statSync(p.directory).mode&0o777).toBe(0o700)
  expect(auth.snapshot('alice',p.id)).toMatchObject({status:'pending',loginUrl:CODEX_DEVICE_URL,userCode:'ABCD-12345'})
  complete(p)
  expect(existsSync(p.directory)).toBe(false)
  expect(auth.credentials('alice',p.id)).toBe(secret)
  expect(auth.snapshot('alice',p.id)).toEqual({id:p.id,status:'authorized',expiresAt:expect.any(Number)})
})
it('isolates owners and invalidates replaced and cancelled attempts, including late completion',()=>{
  const p=pending();expect(()=>auth.credentials('bob',p.id)).toThrow('已结束')
  expect(()=>auth.credentials('alice',p.id)).toThrow('请先完成')
  auth.begin('alice',p.id);expect(processes).toHaveLength(1)
  const next=auth.begin('alice',randomUUID());expect(p.child.kill).toHaveBeenCalled();expect(existsSync(p.directory)).toBe(false)
  expect(()=>auth.snapshot('alice',p.id)).toThrow('已结束')
  auth.cancel('alice',next.id);expect(auth.snapshot('alice',next.id).status).toBe('cancelled')
  p.child.emit('close',0);expect(()=>auth.credentials('alice',next.id)).toThrow('请先完成')
})
it.each(['permission','expiry'])('discards authorized credentials after %s changes',reason=>{
  vi.useFakeTimers();const p=pending();complete(p)
  if(reason==='permission')version++
  else vi.advanceTimersByTime(15*60_000)
  expect(()=>auth.credentials('alice',p.id)).toThrow('请先完成')
  expect(auth.snapshot('alice',p.id).status).toBe(reason==='permission'?'cancelled':'expired')
})
it('stops an in-flight login when admin rights are removed and ignores late output',()=>{
  const p=pending();admin=false
  expect(auth.snapshot('alice',p.id).status).toBe('cancelled');expect(p.child.kill).toHaveBeenCalled()
  p.child.stdout.write(`\n${CODEX_DEVICE_URL}\nABCD-12345\n`)
  expect(auth.snapshot('alice',p.id).userCode).toBeUndefined()
})
it('reports launch and provider failures without exposing raw output',()=>{
  const p=pending();p.child.emit('error',Object.assign(new Error('sensitive error'),{code:'ENOENT'}))
  expect(auth.snapshot('alice',p.id).error).toContain('未找到 Codex CLI')
  const next=pending();next.child.stderr.write('fixture-access-secret');next.child.exitCode=1;next.child.emit('close',1)
  expect(auth.snapshot('alice',next.id).status).toBe('failed')
  expect(JSON.stringify(auth.snapshot('alice',next.id))).not.toContain('fixture-access-secret')
  expect(existsSync(next.directory)).toBe(false)
})
it('does not treat an exit code alone as successful login',()=>{
  const p=pending();p.child.exitCode=0;p.child.emit('close',0)
  expect(auth.snapshot('alice',p.id).status).toBe('failed')
})
