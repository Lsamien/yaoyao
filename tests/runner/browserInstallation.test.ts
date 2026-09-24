// @vitest-environment node
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {browserInstallationFailure,createBrowserInstaller,type BrowserInstallerDependencies} from '../../src/runner/browser/installation.js'

function fixture(options:Partial<BrowserInstallerDependencies>={}){
  const children:(EventEmitter&{stdout:PassThrough;stderr:PassThrough;pid:number;kill:ReturnType<typeof vi.fn>})[]=[]
  const spawn=vi.fn(()=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),pid:999999999,kill:vi.fn()})
    child.kill.mockImplementation(()=>{queueMicrotask(()=>child.emit('close',null));return true});children.push(child);return child
  })
  const close=vi.fn(async()=>{}),launch=vi.fn(async()=>({close})),onUpdate=vi.fn()
  const installer=createBrowserInstaller({spawn:spawn as unknown as BrowserInstallerDependencies['spawn'],chromium:async()=>({executablePath:()=>process.execPath,launch}),cliPath:()=>'/fixed/playwright/cli.js',execPath:'/fixed/node',platform:'darwin',env:{HOME:'/private/person',TOKEN:'secret',NODE_OPTIONS:'--inspect',PWDEBUG:'1'},...options})
  const controller=new AbortController(),run=()=>installer.install({signal:controller.signal,onUpdate})
  return {children,spawn,close,launch,onUpdate,installer,controller,run}
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})

describe('Runner Chromium installer',()=>{
  it('runs the matching fixed CLI in Node mode and waits for an actual sandbox launch',async()=>{
    const f=fixture(),result=f.run()
    expect(f.spawn).toHaveBeenCalledWith('/fixed/node',['/fixed/playwright/cli.js','install','chromium'],expect.objectContaining({shell:false,detached:true,env:expect.objectContaining({ELECTRON_RUN_AS_NODE:'1',CI:'1'})}))
    expect(f.spawn.mock.calls[0]![2]?.env).not.toHaveProperty('NODE_OPTIONS')
    f.children[0]!.stdout.write('Downloading from https://user:secret@mirror.invalid/private/person\n|████ | 50% of 12 MiB\n')
    expect(f.onUpdate).toHaveBeenCalledWith({message:'正在下载浏览器组件（当前组件 50%）',progress:50})
    f.children[0]!.emit('close',0);await result
    expect(f.launch).toHaveBeenCalledWith({headless:true,chromiumSandbox:true,timeout:30000});expect(f.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.onUpdate.mock.calls)).not.toMatch(/secret|private\/person|mirror/)
  })
  it('checks executable and sandbox readiness rather than only accepting an existing binary',async()=>{
    const f=fixture();expect(await f.installer.probe()).toBe(true)
    f.launch.mockRejectedValueOnce(new Error('headless shell missing'))
    expect(await f.installer.probe()).toBe(false)
  })
  it('never invokes install-deps as a user that would trigger sudo or su',async()=>{
    const f=fixture({platform:'linux',getuid:()=>1000});f.launch.mockRejectedValueOnce(new Error('Host system is missing dependencies to run browsers'))
    const result=f.run();f.children[0]!.emit('close',0)
    await expect(result).rejects.toMatchObject({code:'browser_install_dependencies'})
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('installs missing Linux system libraries only as root, then checks the sandbox again',async()=>{
    const f=fixture({platform:'linux',getuid:()=>0});f.launch.mockRejectedValueOnce(new Error('error while loading shared libraries: libX.so'))
    const result=f.run();f.children[0]!.emit('close',0)
    await vi.waitFor(()=>expect(f.children).toHaveLength(2))
    expect(f.spawn.mock.calls[1]![1]).toEqual(['/fixed/playwright/cli.js','install-deps','chromium'])
    f.children[1]!.emit('close',0);await result
    expect(f.launch).toHaveBeenCalledTimes(2);expect(f.close).toHaveBeenCalledOnce()
  })
  it('reports sandbox failure without disabling it or exposing raw diagnostics',async()=>{
    const f=fixture();f.launch.mockRejectedValueOnce(new Error('Chromium sandboxing failed! /private/person use --no-sandbox token=secret'))
    const result=f.run();f.children[0]!.emit('close',0)
    const error=await result.catch(error=>error)
    expect(error.code).toBe('browser_install_sandbox')
    expect(browserInstallationFailure(error)).not.toMatch(/private|secret|--no-sandbox/)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('kills the installer on cancellation and on the bounded overall deadline',async()=>{
    const f=fixture();const result=f.run().catch(error=>error);f.controller.abort()
    expect((await result).code).toBe('browser_install_cancelled');expect(f.children[0]!.kill).toHaveBeenCalled()
    vi.useFakeTimers();const timeout=fixture({timeoutMs:1000}),expired=timeout.run().catch(error=>error)
    await vi.advanceTimersByTimeAsync(1100)
    expect((await expired).code).toBe('browser_install_timeout');expect(timeout.children[0]!.kill).toHaveBeenCalled()
  })
  it('kills remaining process-group children even when the CLI parent exits first',async()=>{
    const kill=vi.spyOn(process,'kill').mockImplementation(()=>true)
    const f=fixture(),result=f.run().catch(error=>error);f.controller.abort()
    expect(kill).toHaveBeenCalledWith(-999999999,'SIGTERM')
    f.children[0]!.emit('close',null);await result
    expect(kill).toHaveBeenCalledWith(-999999999,'SIGKILL')
  })
  it('cancels a pending sandbox launch and closes any browser that arrives late',async()=>{
    const f=fixture();let complete!:(value:{close:typeof f.close})=>void
    f.launch.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
    const result=f.run().catch(error=>error);f.children[0]!.emit('close',0)
    await vi.waitFor(()=>expect(f.launch).toHaveBeenCalled())
    f.controller.abort();expect((await result).code).toBe('browser_install_cancelled')
    complete({close:f.close});await vi.waitFor(()=>expect(f.close).toHaveBeenCalled())
  })
  it('also honors cancellation while the probe browser is closing',async()=>{
    const f=fixture();let finish!:()=>void
    f.close.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const result=f.run().catch(error=>error);f.children[0]!.emit('close',0)
    await vi.waitFor(()=>expect(f.close).toHaveBeenCalled());f.controller.abort()
    expect((await result).code).toBe('browser_install_cancelled');finish()
  })
  it('bounds diagnostics and does not expose CLI paths or credentials on failure',async()=>{
    const f=fixture(),result=f.run().catch(error=>error)
    f.children[0]!.stderr.write('x'.repeat(100000)+' /private/person https://token:secret@mirror.invalid');f.children[0]!.emit('close',1)
    const error=await result;expect(error.code).toBe('browser_install_failed')
    expect(browserInstallationFailure(error)).not.toMatch(/private|secret|mirror/);expect(f.launch).not.toHaveBeenCalled()
  })
})
