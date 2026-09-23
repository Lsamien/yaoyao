// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = vi.hoisted(() => ({ loaded: true, calls: [] as string[][] }))
vi.mock('node:child_process', () => ({ execFileSync: (command: string, args: string[]) => {
  native.calls.push([command, ...args])
  if (args[0] === 'print' && !native.loaded) throw new Error('not loaded')
  if (args[0] === 'bootout') native.loaded = false
  if (args[0] === 'bootstrap') native.loaded = true
  return ''
} }))
import { LaunchAgentService } from '../../bin/lib/service-update.mjs'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'yaoyao-launchagent-boot-')); native.loaded = true; native.calls = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
function fixture(pid?: number) {
  const driver = new LaunchAgentService({ home, releaseRoot: join(home, 'releases'), label: 'fixture', environment: { HERMES_YAOYAO_DEFER_HERMES: '1' } })
  driver.pid = () => pid
  driver.prepareBoot = vi.fn((defer: boolean) => defer && !pid)
  driver.writePlist = vi.fn()
  return driver
}
const operations = () => native.calls.map(([, operation]) => operation)

describe.skipIf(process.platform === 'win32')('desktop LaunchAgent boot', () => {
  it('reloads a stopped but loaded job before starting it with the new deferred environment', async () => {
    const driver = fixture()
    await driver.boot()
    expect(driver.prepareBoot).toHaveBeenCalledWith(true)
    expect(operations()).toEqual(['print', 'bootout', 'bootstrap'])
  })
  it('keeps an already running service registered and preserves its active authorization', async () => {
    const driver = fixture(1234)
    await driver.boot()
    expect(operations()).toEqual(['print', 'kickstart'])
  })
  it('restores the previous loaded job without clearing its recovered authorization', async () => {
    const driver = fixture()
    await driver.restore({ plist: { Label: 'fixture' }, wasRunning: true })
    expect(driver.prepareBoot).toHaveBeenCalledWith(false)
    expect(operations()).toEqual(['print', 'kickstart'])
  })
  it('bootstraps a new registration directly', async () => {
    native.loaded = false
    await fixture().boot()
    expect(operations()).toEqual(['print', 'bootstrap'])
  })
  it('does not unload a service that starts while preparation is finishing', async () => {
    const driver = fixture()
    driver.prepareBoot = vi.fn(() => { driver.pid = () => 1234; return true })
    await driver.boot()
    expect(operations()).toEqual(['print', 'kickstart'])
  })
})
