import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { DashboardSupervisor } from '../../src/server/dashboardSupervisor.js'

function supervisor(initiallyRunning = false) {
  let running = initiallyRunning
  const calls: string[][] = [], launches: string[][] = [], probes: string[] = []
  const instance = new DashboardSupervisor({
    run(args) {
      calls.push([...args])
      if (args[0] === 'dashboard' && args[1] === '--stop') running = false
      return ''
    },
    launch(args) { launches.push([...args]); running = true },
    probe: async (host, port) => { probes.push(host + ':' + port); return running },
    log: () => undefined,
  })
  return { instance, calls, launches, probes }
}

describe('DashboardSupervisor', () => {
  it('starts a missing service on loopback without reading or writing authentication config', async () => {
    const f = supervisor()
    await f.instance.checkNow()
    expect(f.calls).toEqual([])
    expect(f.launches).toEqual([['dashboard', '--host', '127.0.0.1']])
    await f.instance.checkNow()
    expect(f.launches).toHaveLength(1)
  })
  it('leaves an existing service and its authentication/binding untouched', async () => {
    const f = supervisor(true)
    await f.instance.checkNow(); await f.instance.checkNow()
    expect(f.calls).toEqual([])
    expect(f.launches).toEqual([])
    expect(new Set(f.probes)).toEqual(new Set(['127.0.0.1:9119']))
  })
  it('only restarts on an explicit request, without configuring any credentials', async () => {
    const f = supervisor(true)
    await f.instance.restart()
    expect(f.calls).toEqual([['dashboard', '--stop']])
    expect(f.launches).toEqual([['dashboard', '--host', '127.0.0.1']])
  })
  it('coalesces concurrent checks', async () => {
    const f = supervisor()
    await Promise.all([f.instance.checkNow(), f.instance.checkNow()])
    expect(f.launches).toHaveLength(1)
  })
})

function managedSupervisor(initiallyRunning=false, readyTimeoutMs=1000) {
  let running=initiallyRunning
  const children:ChildProcess[]=[]
  const spawnManaged=vi.fn(()=>{
    const child=Object.assign(new EventEmitter(),{pid:10000+children.length,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,
      kill:vi.fn((signal:NodeJS.Signals)=>{running=false;child.signalCode=signal;child.emit('exit',null,signal);return true})}) as unknown as ChildProcess
    children.push(child)
    return child
  })
  const instance=new DashboardSupervisor({managed:true,spawnManaged,probe:async()=>running,readyTimeoutMs,log:()=>{}})
  return {instance,spawnManaged,children,listening:(value=true)=>{running=value}}
}

it('never adopts or restarts an externally started Dashboard',async()=>{
  const f=managedSupervisor(true)
  await f.instance.checkNow()
  expect(f.instance.canRestart).toBe(false)
  await expect(f.instance.restart()).rejects.toThrow('外部服务管理')
  expect(f.spawnManaged).not.toHaveBeenCalled()
  expect(supervisor(true).instance.canRestart).toBe(false)
})

it('restarts only its owned child, serializes requests and waits for the replacement listener',async()=>{
  const f=managedSupervisor()
  await f.instance.checkNow();f.listening()
  expect(f.instance.canRestart).toBe(true)
  let completed=false
  const pending=f.instance.restart().then(()=>{completed=true})
  await vi.waitFor(()=>expect(f.children).toHaveLength(2))
  expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
  expect(completed).toBe(false)
  await expect(f.instance.restart()).rejects.toThrow('正在重启')
  await f.instance.checkNow()
  expect(f.spawnManaged).toHaveBeenCalledTimes(2)
  f.listening();await pending
  expect(completed).toBe(true)
  expect(f.instance.canRestart).toBe(true)
  f.instance.stop();await f.instance.stopOwned()
})

it('reports startup failure and timeout instead of claiming a successful restart',async()=>{
  const failed=managedSupervisor()
  await failed.instance.checkNow()
  const pending=failed.instance.restart()
  const rejected=expect(pending).rejects.toThrow('启动失败')
  await vi.waitFor(()=>expect(failed.children).toHaveLength(2))
  failed.children[1]!.emit('error',new Error('spawn failed'))
  await rejected
  expect(failed.instance.canRestart).toBe(false)
  const timeout=managedSupervisor(false,10)
  await timeout.instance.checkNow()
  await expect(timeout.instance.restart()).rejects.toThrow('规定时间')
  timeout.instance.stop();await timeout.instance.stopOwned()
})

it('does not relaunch an owned Dashboard when shutdown starts during restart',async()=>{
  const f=managedSupervisor()
  await f.instance.checkNow()
  f.children[0]!.kill=vi.fn(()=>{f.instance.stop();f.children[0]!.signalCode='SIGTERM';f.children[0]!.emit('exit');return true})
  await expect(f.instance.restart()).rejects.toThrow('启动失败')
  expect(f.spawnManaged).toHaveBeenCalledTimes(1)
  expect(f.instance.canRestart).toBe(false)
})
