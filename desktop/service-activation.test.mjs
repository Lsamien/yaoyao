import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopServiceManager } from './service-manager.mjs'
import { grantDesktopActivation, hasDesktopActivation } from '../bin/lib/desktop-activation.mjs'

for (const legacy of [false, true]) test(`inspection preserves active background authorization when reusing a ${legacy ? 'legacy' : 'current'} service`, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-reuse-activation-')))
  grantDesktopActivation(home)
  const service = { url: 'http://127.0.0.1:15300', version: 'fixture', pid: 123, legacy }
  const manager = new DesktopServiceManager({ home, fork: () => assert.fail('must reuse the live service') })
  manager.readRecord = async () => legacy ? null : service
  manager.verify = async () => service
  manager.legacyService = async () => legacy ? service : null
  try {
    await manager.start()
    assert.equal(manager.state.phase, 'ready')
    assert.equal(hasDesktopActivation(home), true)
    assert.equal(manager.activationRequested, false)
    await manager.stop()
    assert.equal(hasDesktopActivation(home), true, 'disconnecting must preserve independent background recovery')
  } finally { await manager.stop(); await rm(home, { recursive: true, force: true }) }
})

test('inspection clears a previous authorization immediately before forking a new service', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-fork-activation-')))
  grantDesktopActivation(home)
  let forked = false
  const child = new EventEmitter()
  child.pid = 123
  child.kill = () => child.emit('exit', 0)
  const service = { url: 'http://127.0.0.1:15300', version: 'fixture', pid: child.pid }
  const manager = new DesktopServiceManager({ home, fork: () => {
    assert.equal(hasDesktopActivation(home), false, 'the child must start in inspection mode')
    forked = true
    return child
  } })
  manager.readRecord = async () => forked ? service : null
  manager.verify = async () => service
  manager.legacyService = async () => null
  try {
    await manager.start()
    assert.equal(forked, true)
    assert.equal(manager.state.phase, 'ready')
    assert.equal(hasDesktopActivation(home), false)
  } finally { await manager.stop(); await rm(home, { recursive: true, force: true }) }
})
