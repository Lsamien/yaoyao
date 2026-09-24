// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseRunnerConfiguration} from '../../src/runner/config.js'
import {RunnerAgent} from '../../src/runner/agent.js'
import type {RunnerConfiguration} from '../../src/shared/runner.js'
import {DesktopRunnerManager} from '../../desktop/runner-manager.mjs'

const browserConstructed=vi.hoisted(()=>vi.fn())
vi.mock('../../src/runner/managedBrowser.js',()=>({RunnerBrowser:class {
  available=false
  constructor(config:unknown){browserConstructed(config)}
  async disconnect(){}async shutdown(){}async sweep(){}
}}))
const base=()=>({protocol:1 as const,runnerId:randomUUID(),token:randomBytes(32).toString('base64url'),serverURL:'https://fixture.invalid',hermesURL:'http://127.0.0.1:9119',allowedProfiles:['default'],artifactRoots:[]})
afterEach(()=>vi.clearAllMocks())

it.each([undefined,{}, {enabled:false,maxSessions:2,idleTimeoutMs:120000}])('revalidates an old encrypted desktop configuration on restart and import (%j)',async browser=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-browser-config-upgrade-')),key=randomBytes(32),children:any[]=[]
  const encrypt=(value:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes])}
  const decrypt=(bytes:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString()}
  const manager=new DesktopRunnerManager({home,encrypt,decrypt,validate:parseRunnerConfiguration,fork:()=>{
    const child=Object.assign(new EventEmitter(),{messages:[] as any[],postMessage(value:any){this.messages.push(value);if(value.type==='shutdown')queueMicrotask(()=>this.emit('exit',0))},kill(){queueMicrotask(()=>this.emit('exit',0));return true}})
    children.push(child);queueMicrotask(()=>child.emit('spawn'));return child
  }})
  const config={...base(),...(browser?{browser}:{})},encrypted=encrypt(JSON.stringify(config)),expected=browser?.enabled===false?browser:{enabled:true}
  try{
    // Existing bytes are the pre-upgrade settings; start must not rewrite them.
    await writeFile(manager.path,encrypted,{mode:0o600});await manager.start()
    expect(children[0].messages.find((item:any)=>item.type==='configure').config.browser).toEqual(expected)
    expect(await readFile(manager.path)).toEqual(encrypted)
    await manager.stop();await manager.start()
    expect(children[1].messages.find((item:any)=>item.type==='configure').config.browser).toEqual(expected)
    const file=join(home,'runner.json');await writeFile(file,JSON.stringify(config),{mode:0o600})
    await manager.importFile(file)
    expect(children[2].messages.find((item:any)=>item.type==='configure').config.browser).toEqual(expected)
    expect((await readFile(manager.path)).includes(config.token)).toBe(false)
  }finally{await manager.stop();await rm(home,{recursive:true,force:true})}
})

it.each([undefined,{}, {enabled:false}])('advertises setup for direct/embedded old configurations unless explicitly disabled (%j)',async browser=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-browser-agent-upgrade-'))
  const fetchImpl=vi.fn(async()=>Response.json({commands:[],epoch:randomUUID()}))
  const runner=new RunnerAgent({...base(),...(browser?{browser}:{})} as RunnerConfiguration,home,fetchImpl as typeof fetch)
  try{
    await (runner as any).api('poll')
    const headers=new Headers(fetchImpl.mock.calls[0]![1]?.headers)
    const features=headers.get('x-runner-features')!.split(',')
    expect(features.includes('managed-browser-setup-v1')).toBe(browser?.enabled!==false)
    expect(features.includes('managed-browser-disabled-v1')).toBe(browser?.enabled===false)
    expect(features).not.toContain('managed-browser-v1')
    expect(features).not.toContain('local-vm-v1')
    if(browser?.enabled===false)expect(browserConstructed).not.toHaveBeenCalled()
    else expect(browserConstructed).toHaveBeenCalledWith({enabled:true})
  }finally{const stop=new AbortController();stop.abort();await runner.run(stop.signal);await rm(home,{recursive:true,force:true})}
})
