// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, readdir, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { FileTransferFiles } from '../../src/shared/fileTransferEndpoint.mjs'
import { FILE_TRANSFER_CHUNK_BYTES, type FileTransferEndpoint } from '../../src/shared/fileTransfer'
import { copyBetweenEndpoints } from '../../src/server/fileTransfer'
import { VM_FILE_TRANSFER_SCRIPT } from '../../src/runner/worker/fileTransfer'

const roots: string[] = [], files: FileTransferFiles[] = []
afterEach(async () => { await Promise.all(files.splice(0).map(file => file.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'yaoyao-transfer-test-')); roots.push(value); return value }
function nodeEndpoint(root: string, host: string, path: string): FileTransferEndpoint {
  const file = new FileTransferFiles(root); files.push(file)
  return { host, path, name: host, chunks: true, call: action => file.call(action) }
}
async function pythonCall(directory: string, namespace: string, action: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', VM_FILE_TRANSFER_SCRIPT, namespace], { cwd: directory, env: { ...process.env, TMPDIR: directory } })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject); child.on('close', code => { if (code) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } } })
    child.stdin.end(JSON.stringify(action))
  })
}
function vmEndpoint(root: string, path: string): FileTransferEndpoint {
  const namespace = createHash('sha256').update(randomUUID()).digest('hex')
  return { host: 'vm', name: 'vm', path, chunks: true, call: action => pythonCall(root, namespace, action) }
}

it.each([['mac1', 'server'], ['server', 'mac1'], ['mac1', 'mac2'], ['mac2', 'mac1'], ['mac1', 'vm'], ['vm', 'mac1']])('copies binary files from %s to %s without model-visible bytes', async (from, to) => {
  const source = await root(), target = await root(), bytes = Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  await writeFile(join(source, 'source'), bytes)
  const sourceEndpoint = from === 'vm' ? vmEndpoint(source, 'source') : nodeEndpoint(source, from, 'source')
  const targetEndpoint = to === 'vm' ? vmEndpoint(target, 'target') : nodeEndpoint(target, to, 'target')
  const result = await copyBetweenEndpoints(sourceEndpoint, targetEndpoint, 1024 * 1024, false, () => {})
  expect(result).toMatchObject({ copied: true, size: bytes.length, source: { host: from }, target: { host: to } })
  expect((await readFile(join(target, 'target'))).equals(bytes)).toBe(true)
  expect((await readFile(join(source, 'source'))).equals(bytes)).toBe(true)
  expect(JSON.stringify(result).length).toBeLessThan(500)
  expect((await readdir(target)).some(name => name.startsWith('.yaoyao-transfer-'))).toBe(false)
})

it('streams exactly 100 MiB in 512 KiB chunks and rejects one byte over the configured limit', async () => {
  const source = await root(), target = await root(), limit = 100 * 1024 * 1024
  const handle = await open(join(source, 'source'), 'w'); await handle.truncate(limit); await handle.close()
  const a = nodeEndpoint(source, 'mac1', 'source'), b = nodeEndpoint(target, 'mac2', 'target')
  let chunks = 0; const send = b.call
  b.call = async action => { if (action.op === 'transfer-append') { chunks++; expect(Buffer.from(String(action.data), 'base64').length).toBeLessThanOrEqual(FILE_TRANSFER_CHUNK_BYTES) } return send(action) }
  expect(await copyBetweenEndpoints(a, b, limit, false, () => {})).toMatchObject({ size: limit })
  expect(chunks).toBe(200)
  const grow = await open(join(source, 'source'), 'r+'); await grow.truncate(limit + 1); await grow.close()
  await expect(copyBetweenEndpoints(a, { ...b, path: 'too-big' }, limit, false, () => {})).rejects.toThrow('上限')
  expect(await readdir(target)).toEqual(['target'])
}, 30000)

it.each([false, true])('copies empty files and enforces overwrite protection (VM=%s)', async vm => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), '')
  const a = nodeEndpoint(source, 'mac1', 'source'), b = vm ? vmEndpoint(target, 'target') : nodeEndpoint(target, 'server', 'target')
  expect(await copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {})).toMatchObject({ size: 0 })
  await writeFile(join(source, 'source'), 'new')
  await expect(copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {})).rejects.toThrow()
  expect((await readFile(join(target, 'target'))).length).toBe(0)
  await copyBetweenEndpoints(a, b, 1024 * 1024, true, () => {})
  expect(await readFile(join(target, 'target'), 'utf8')).toBe('new')
})

it('queries the commit receipt after a lost response and never repeats the commit', async () => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), 'content')
  const a = nodeEndpoint(source, 'mac1', 'source'), b = nodeEndpoint(target, 'server', 'target'), send = b.call
  const operations: unknown[] = []
  b.call = async action => { operations.push(action.op); const result = await send(action); if (action.op === 'transfer-finish') throw new Error('response lost'); return result }
  expect(await copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {})).toMatchObject({ copied: true })
  expect(operations.filter(op => op === 'transfer-finish')).toHaveLength(1)
  expect(operations).toContain('transfer-status')
})

it('rejects corrupt chunks and removes temporary files without changing the destination', async () => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), 'content')
  const a = nodeEndpoint(source, 'mac1', 'source'), b = nodeEndpoint(target, 'server', 'target'), send = a.call
  a.call = async action => { const result = await send(action); return action.op === 'transfer-read' ? { ...result, data: Buffer.from('corrupt').toString('base64') } : result }
  await expect(copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {})).rejects.toThrow('校验')
  expect(await readdir(target)).toEqual([])
})

it('bounds legacy endpoints and explains the upgrade requirement above 10 MiB', async () => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), Buffer.alloc(11 * 1024 * 1024))
  const a = nodeEndpoint(source, 'mac1', 'source'), b = { ...nodeEndpoint(target, 'old', 'target'), chunks: false }
  await expect(copyBetweenEndpoints(a, b, 25 * 1024 * 1024, false, () => {})).rejects.toMatchObject({ code: 'desktop_transfer_upgrade_required' })
  expect(await readdir(target)).toEqual([])
})

it('makes chunk replays idempotent and refuses conflicting data or paths outside the root', async () => {
  const directory = await root(), file = new FileTransferFiles(directory); files.push(file)
  const transferId = randomUUID(), bytes = Buffer.from('abc')
  await expect(file.call({ op: 'transfer-read-open', transferId, path: '../outside', maxBytes: 1024 * 1024 })).rejects.toThrow('路径')
  await file.call({ op: 'transfer-write-open', transferId, path: 'target', maxBytes: 1024 * 1024, size: 3, sha256: createHash('sha256').update(bytes).digest('hex'), overwrite: false })
  const append = { op: 'transfer-append', transferId, offset: 0, data: bytes.toString('base64') }
  await file.call(append); expect(await file.call(append)).toEqual({ received: 3 })
  await expect(file.call({ ...append, data: Buffer.from('bad').toString('base64') })).rejects.toThrow('不一致')
  await file.call({ op: 'transfer-finish', transferId })
  expect(await readFile(join(directory, 'target'), 'utf8')).toBe('abc')
})

it.each(['cancelled', 'revoked', 'disconnected'])('stops before the next chunk after %s and cleans both endpoints', async reason => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), Buffer.alloc(2 * FILE_TRANSFER_CHUNK_BYTES))
  const a = nodeEndpoint(source, 'mac1', 'source'), b = nodeEndpoint(target, 'mac2', 'target'), send = b.call
  let active = true, chunks = 0
  b.call = async action => { const result = await send(action); if (action.op === 'transfer-append') { chunks++; active = false } return result }
  await expect(copyBetweenEndpoints(a, b, 1024 * 1024, false, () => { if (!active) throw new Error(reason) })).rejects.toThrow(reason)
  expect(chunks).toBe(1); expect(await readdir(target)).toEqual([])
})

it('keeps concurrent transfers isolated and refuses to replace a concurrently created destination', async () => {
  const source = await root(), target = await root(); await writeFile(join(source, 'source'), Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 1, 7))
  const a = nodeEndpoint(source, 'mac1', 'source'), b = nodeEndpoint(target, 'mac2', 'target')
  const outcomes = await Promise.allSettled([copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {}), copyBetweenEndpoints(a, b, 1024 * 1024, false, () => {})])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect((await readFile(join(target, 'target'))).equals(await readFile(join(source, 'source')))).toBe(true)
  expect(await readdir(target)).toEqual(['target'])
})
