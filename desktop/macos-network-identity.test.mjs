import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { namespaceMachOUUID } from '../scripts/prepare-desktop-macos.mjs'

function binary(cpu = 0x100000c) {
  const bytes = Buffer.alloc(96, 0x42)
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4)
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20)
  bytes.writeUInt32LE(0x1b, 32); bytes.writeUInt32LE(24, 36)
  return bytes
}

test('Electron build UUIDs are separated by app/helper identity without changing other bytes', () => {
  const original = binary(), before = Buffer.from(original)
  const client = namespaceMachOUUID(original, 'cn.samien.yaoyao.desktop')
  const full = namespaceMachOUUID(original, 'cn.samien.yaoyao.desktop.full')
  const helper = namespaceMachOUUID(original, 'cn.samien.yaoyao.desktop.helper')
  assert.deepEqual(original, before)
  assert.deepEqual(client, namespaceMachOUUID(original, 'cn.samien.yaoyao.desktop'))
  assert.equal(new Set([original, client, full, helper].map(b => b.subarray(40, 56).toString('hex'))).size, 4)
  assert.deepEqual(client.subarray(0, 40), original.subarray(0, 40))
  assert.deepEqual(client.subarray(56), original.subarray(56))
  const nextElectron = binary(); nextElectron[40]++
  assert.notDeepEqual(client, namespaceMachOUUID(nextElectron, 'cn.samien.yaoyao.desktop'))
})

test('universal builds rewrite both architecture slices and preserve their boundaries', () => {
  const bytes = Buffer.alloc(512)
  bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(2, 4)
  bytes.writeUInt32BE(128, 16); bytes.writeUInt32BE(96, 20)
  bytes.writeUInt32BE(256, 36); bytes.writeUInt32BE(96, 40)
  binary().copy(bytes, 128); const intel = binary(0x1000007); intel[40]++; intel.copy(bytes, 256)
  const result = namespaceMachOUUID(bytes, 'test.app')
  assert.deepEqual(result.subarray(128, 224), namespaceMachOUUID(bytes.subarray(128, 224), 'test.app'))
  assert.deepEqual(result.subarray(256, 352), namespaceMachOUUID(intel, 'test.app'))
  assert.deepEqual(result.subarray(0, 128), bytes.subarray(0, 128))
  bytes.writeUInt32BE(128, 36)
  assert.throws(() => namespaceMachOUUID(bytes, 'test.app'), /重叠/)
})

test('malformed executables fail before anything is written', () => {
  assert.throws(() => namespaceMachOUUID(Buffer.alloc(4), 'test.app'), /Mach-O/)
  for (const [offset, value] of [[20, 9999], [36, 0], [36, 16], [32, 0x19], [16, 2]]) {
    const bytes = binary(); bytes.writeUInt32LE(value, offset)
    assert.throws(() => namespaceMachOUUID(bytes, 'test.app'), /Mach-O/)
  }
  assert.throws(() => namespaceMachOUUID(binary(), ''), /应用标识/)
})

test('both macOS package variants declare LAN access and run identity preparation before signing', () => {
  const root = new URL('../', import.meta.url)
  for (const file of ['electron-builder.client.yml', 'electron-builder.yml']) {
    const config = load(readFileSync(new URL(file, root), 'utf8'))
    assert.match(config.mac.extendInfo.NSLocalNetworkUsageDescription, /局域网服务器/)
    const hook = readFileSync(new URL(config.afterPack, root), 'utf8')
    assert.match(hook, /prepareMacDesktop/)
  }
})
