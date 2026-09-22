import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DesktopCredentials } from './credentials.mjs'
import { DesktopAutoUpdateManager } from './auto-update-manager.mjs'
import { powershellArguments } from './windows-shell.mjs'
import { execHostShell } from './host-files.mjs'
import { windowsFrame, sameWindowsDisplay } from './windows-input.mjs'
import { FileTransferFiles } from './file-transfer.mjs'
import { windowsSigningOptions, verifyWindowsArtifacts } from '../scripts/windows-desktop-release.mjs'

test('Windows credentials use the asynchronous OS provider and reject foreign/corrupt ciphertext', async () => {
  const raw = 'fixture-token', cipher = Buffer.from('opaque-encrypted-value')
  const store = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => { assert.equal(value, raw); return cipher },
    decryptStringAsync: async value => { assert.deepEqual(value, cipher); return { result: raw } } }
  const credentials = new DesktopCredentials({ home: 'C:\\fixture', platform: 'win32', safeStorage: store })
  const encrypted = await credentials.encrypt(raw)
  assert.equal(encrypted.includes(raw), false)
  assert.equal(await credentials.decrypt(encrypted), raw)
  await assert.rejects(credentials.decrypt(Buffer.from('YAOYAO-RUNNER-KEYCHAIN-1\ninvalid')), /不属于 Windows/)
  store.isAsyncEncryptionAvailable = async () => false
  await assert.rejects(credentials.encrypt(raw), /加密暂不可用/)
  store.decryptStringAsync = async () => { throw new Error('DPAPI failure') }
  await assert.rejects(credentials.decrypt(encrypted), /重新登录/)
})
test('PowerShell transports quoted Unicode as UTF-16 without shell interpolation', () => {
  const command = 'Write-Output "你好 $env:USERNAME"; exit 7', args = powershellArguments(command)
  assert.equal(args.at(-2), '-EncodedCommand')
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes(command)); assert.match(script, /UTF8Encoding/); assert.match(script, /LASTEXITCODE/)
})
test('Windows input invalidates screenshots after DPI, geometry or primary display changes', () => {
  const d = { id: 1, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 1280, height: 720 } }
  const physical = { x: 0, y: 0, width: 1920, height: 1080 }
  const frame = windowsFrame(d, { width: 1600, height: 900 }, physical)
  assert.equal(sameWindowsDisplay(frame, d, physical), true)
  assert.equal(sameWindowsDisplay(frame, { ...d, scaleFactor: 2 }, physical), false)
  assert.equal(sameWindowsDisplay(frame, { ...d, id: 2 }, physical), false)
  assert.equal(sameWindowsDisplay(frame, d, { ...physical, width: 2560 }), false)
})
test('NSIS installation is explicit and runs exactly once after cleanup', async t => {
  const driver = new EventEmitter(), events = []
  driver.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } })
  driver.downloadUpdate = async () => { driver.emit('update-downloaded'); return ['setup.exe'] }
  driver.quitAndInstall = () => events.push('install')
  const manager = new DesktopAutoUpdateManager({ driver, platform: 'win32', version: '1.0.0', prepareInstall: async () => events.push('cleanup') })
  t.after(() => { manager.stopChecking(); clearTimeout(manager.restartTimer) })
  assert.equal(driver.autoInstallOnAppQuit, false)
  await manager.check(); await manager.download()
  assert.equal(manager.snapshot().phase, 'ready'); assert.equal(manager.stagingTimer, undefined)
  assert.deepEqual(events, [])
  await manager.install(); await manager.install()
  assert.deepEqual(events, ['cleanup', 'install'])
})
test('NSIS errors before install can retry, while dispatched installs stay fenced', async t => {
  const driver = new EventEmitter(), manager = new DesktopAutoUpdateManager({ driver, platform: 'win32', version: '1.0.0' })
  t.after(() => manager.stopChecking())
  manager.nativeStarted = true; manager.failure(new Error('checksum'))
  assert.equal(manager.snapshot().retryable, true); assert.equal(manager.nativeStarted, false)
  manager.nativeStarted = true; manager.installAttempted = true; manager.failure(new Error('installer failed'))
  assert.equal(manager.snapshot().retryable, false)
})
test('signed Windows builds fail closed without a certificate and publisher', () => {
  assert.equal(windowsSigningOptions({}).forceCodeSigning, false)
  assert.throws(() => windowsSigningOptions({ YAOYAO_WINDOWS_SIGNED: '1' }), /CSC_LINK/)
  const result = windowsSigningOptions({ YAOYAO_WINDOWS_SIGNED: '1', CSC_LINK: 'fixture.pfx', YAOYAO_WINDOWS_PUBLISHER: 'Fixture publisher' })
  assert.equal(result.forceCodeSigning, true); assert.equal(result.win.verifyUpdateCodeSignature, true)
})
test('Windows artifact verification detects corruption before delivery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yaoyao-win-release-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const name = 'Yaoyao-1.0.0-win-x64-setup.exe', bytes = Buffer.from('MZ-test-installer')
  await writeFile(join(dir, name), bytes); await writeFile(join(dir, name + '.blockmap'), 'map')
  await writeFile(join(dir, 'latest.yml'), JSON.stringify({ version: '1.0.0', files: [{ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] }))
  await verifyWindowsArtifacts(dir, '1.0.0')
  assert.match(await readFile(join(dir, 'SHA256SUMS-win-x64.txt'), 'utf8'), /setup\.exe/)
  await writeFile(join(dir, name), 'corrupt')
  await assert.rejects(verifyWindowsArtifacts(dir, '1.0.0'), /不匹配/)
})
test('native Windows PowerShell preserves Chinese, exit status and cancellation', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), '夭夭-shell-')); t.after(() => rm(root, { recursive: true, force: true }))
  const result = await execHostShell(root, { command: "[Console]::WriteLine('你好，Windows'); exit 7" })
  assert.equal(result.stdout.trim(), '你好，Windows'); assert.equal(result.exitCode, 7)
  const controller = new AbortController()
  const pending = execHostShell(root, { command: 'Start-Sleep -Seconds 60' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 500)
  assert.equal((await pending).cancelled, true)
  const childCommand = "$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c ping -n 60 127.0.0.1 > nul' -WindowStyle Hidden -PassThru; [Console]::WriteLine($p.Id)"
  for (const wait of [false, true]) {
    const result = await execHostShell(root, { command: childCommand + (wait ? '; Start-Sleep -Seconds 60' : ''), timeoutMs: 3000 })
    assert.equal(result.timedOut, wait)
    const pid = Number(result.stdout.trim()); assert.ok(pid > 0, result.stderr)
    const alive = await execHostShell(root, { command: `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }` })
    assert.equal(alive.exitCode, 0, 'PowerShell 子进程在结束或超时后必须退出')
  }
})
test('chunked file writes preserve contents and reject directory links outside the root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yaoyao-win-files-')), outside = await mkdtemp(join(tmpdir(), 'yaoyao-win-outside-'))
  const files = new FileTransferFiles(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  const bytes = Buffer.from('中文附件'), transferId = randomUUID(), path = '中文 文件.txt'
  await files.call({ op: 'transfer-write-open', transferId, path, maxBytes: 1048576, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), overwrite: false })
  await files.call({ op: 'transfer-append', transferId, offset: 0, data: bytes.toString('base64') })
  await files.call({ op: 'transfer-finish', transferId })
  assert.equal(await readFile(join(root, path), 'utf8'), '中文附件')
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(files.path('escape/secret', true), /超出允许范围/)
})
