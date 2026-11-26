import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// macOS local-network privacy also looks up the responsible app by Mach-O UUID.
// Stock Electron binaries share that UUID across otherwise unrelated bundles.
// Run once on freshly staged executables, BEFORE electron-builder signs them.
// Namespace each upstream build UUID by bundle ID; leave framework/dSYM UUIDs alone.
export function namespaceMachOUUID(input, bundleId) {
  if (!bundleId?.trim()) throw new Error('缺少 macOS 应用标识')
  const bytes = Buffer.from(input), patches = []
  function thin(start, size) {
    const end = start + size
    if (size < 32 || start < 0 || end > bytes.length || bytes.readUInt32LE(start) !== 0xfeedfacf)
      throw new Error('不支持或损坏的 Mach-O 64 位可执行文件')
    const count = bytes.readUInt32LE(start + 16), commandsEnd = start + 32 + bytes.readUInt32LE(start + 20)
    if (commandsEnd > end) throw new Error('Mach-O 加载命令越界')
    let offset = start + 32, uuidOffset
    for (let i = 0; i < count; i++) {
      if (offset + 8 > commandsEnd) throw new Error('Mach-O 加载命令不完整')
      const command = bytes.readUInt32LE(offset), length = bytes.readUInt32LE(offset + 4)
      if (length < 8 || length % 8 || offset + length > commandsEnd) throw new Error('Mach-O 加载命令长度无效')
      if (command === 0x1b) {
        if (length !== 24 || uuidOffset !== undefined) throw new Error('Mach-O LC_UUID 不唯一或无效')
        uuidOffset = offset + 8
      }
      offset += length
    }
    if (offset !== commandsEnd || uuidOffset === undefined) throw new Error('Mach-O 缺少有效的 LC_UUID')
    const uuid = createHash('sha256').update('yaoyao-macho-uuid-v1\0').update(bundleId).update('\0')
      .update(bytes.subarray(uuidOffset, uuidOffset + 16)).digest().subarray(0, 16)
    uuid[6] = (uuid[6] & 0x0f) | 0x80 // RFC 9562 version 8, application-defined UUID
    uuid[8] = (uuid[8] & 0x3f) | 0x80
    patches.push({ offset: uuidOffset, uuid })
  }
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = bytes.readUInt32BE(4), tableEnd = 8 + count * 20, ranges = []
    if (!count || tableEnd > bytes.length) throw new Error('Mach-O universal 架构表无效')
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * 20, start = bytes.readUInt32BE(entry + 8), size = bytes.readUInt32BE(entry + 12)
      if (start < tableEnd || ranges.some(r => start < r.end && start + size > r.start))
        throw new Error('Mach-O universal 架构重叠')
      thin(start, size)
      ranges.push({ start, end: start + size })
    }
  } else thin(0, bytes.length)
  for (const { offset, uuid } of patches) uuid.copy(bytes, offset)
  return bytes
}

export default async function prepareMacDesktop(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, context.packager.appInfo.productFilename + '.app')
  const plist = (bundle, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
  if (!plist(app, 'NSLocalNetworkUsageDescription')) throw new Error('应用缺少局域网权限用途说明')
  const frameworks = join(app, 'Contents', 'Frameworks')
  const bundles = [app, ...readdirSync(frameworks, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app')).map(entry => join(frameworks, entry.name))]
  for (const bundle of bundles) {
    const id = plist(bundle, 'CFBundleIdentifier'), name = plist(bundle, 'CFBundleExecutable')
    if (!name || /[/\\]/.test(name)) throw new Error('应用可执行文件名称无效')
    const executable = join(bundle, 'Contents', 'MacOS', name)
    writeFileSync(executable, namespaceMachOUUID(readFileSync(executable), id))
    console.log(`签名前配置独立的 macOS 网络权限身份：${id}`)
  }
}
