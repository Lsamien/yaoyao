// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deniedHostToolsets, readHostTools, saveHostTools } from '../../src/server/hostToolSettings'

let home = ''
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }) })

describe('host tool settings', () => {
  it('uses one global approval policy and retires the ineffective native-tool switch', () => {
    home = mkdtempSync(join(tmpdir(), 'yaoyao-host-tools-'))
    expect(readHostTools(home)).toEqual({ denyServerTools: false, approvalPolicy:'ask', scriptMachine: true, serverComputer: true, vm: true, cloud: true, fileTransferMaxMiB:25 })
    expect(deniedHostToolsets(home)).toEqual([])
    saveHostTools(home,{approvalPolicy:'allow',cloud:false})
    expect(saveHostTools(home,{denyServerTools:true})).toMatchObject({denyServerTools:false,approvalPolicy:'allow',cloud:false})
    expect(()=>saveHostTools(home,{approvalPolicy:'invalid'})).toThrow('审批策略无效')
    writeFileSync(join(home, 'host-tools.json'), '{')
    expect(()=>readHostTools(home)).toThrow('无法读取')
  })
  it('keeps old files that only stored the server-tool switch', () => {
    home = mkdtempSync(join(tmpdir(), 'yaoyao-host-tools-'))
    writeFileSync(join(home, 'host-tools.json'), JSON.stringify({ denyServerTools: true }))
    expect(readHostTools(home).scriptMachine).toBe(true)
    expect(saveHostTools(home, { denyServerTools: true, scriptMachine: false, serverComputer: true, vm: false, cloud: true })).toMatchObject({ scriptMachine: false, vm: false, cloud: true })
  })
  it('validates transfer limits and preserves them when an older client saves switches', () => {
    home = mkdtempSync(join(tmpdir(), 'yaoyao-host-tools-'))
    for (const fileTransferMaxMiB of [0, 101, 1.5, '25', null, NaN, Infinity]) expect(() => saveHostTools(home, { fileTransferMaxMiB })).toThrow('1–100')
    saveHostTools(home, { fileTransferMaxMiB: 100 })
    expect(saveHostTools(home, { cloud: false }).fileTransferMaxMiB).toBe(100)
    expect(readHostTools(home).fileTransferMaxMiB).toBe(100)
    expect(saveHostTools(home, { fileTransferMaxMiB: 1 }).fileTransferMaxMiB).toBe(1)
  })
})
