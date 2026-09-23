import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DesktopUpdateManager, githubDownload } from './update-manager.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const prefix = 'https://github.com/Lsamien/yaoyao/releases/download/v0.4.2/'
const name = 'Yaoyao-0.4.2-arm64.dmg', data = Buffer.from('fixture-image')
async function fixture(overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'yaoyao-update-unit-'))
  const sums = Buffer.from(`${hash(data)}  ${name}\n`)
  const release = { manifest: { webVersion: '0.4.2' }, commit: 'a'.repeat(40), notes: 'Notes', releasePageUrl: 'https://github.com/Lsamien/yaoyao/releases/tag/v0.4.2', assets: [
    { name, size: data.length, digest: `sha256:${hash(data)}`, url: prefix + name },
    { name: 'SHA256SUMS.txt', size: sums.length, digest: `sha256:${hash(sums)}`, url: prefix + 'SHA256SUMS.txt' },
  ] }
  const calls = [], verified = []
  const manager = new DesktopUpdateManager({ version: '0.4.1', arch: 'arm64', platform: 'darwin', cacheRoot: home,
    source: 'https://github.com/Lsamien/yaoyao.git', inspect: async () => release,
    compare: (a, b) => Number(a.split('.').at(-1)) - Number(b.split('.').at(-1)),
    fetchImpl: async url => { calls.push(url); return new Response(url.endsWith('.dmg') ? data : sums) },
    verifyImage: async path => { verified.push(path) }, ...overrides })
  return { manager, release, home, calls, verified, clean: () => rm(home, { recursive: true, force: true }) }
}
test('downloads, checks both digests and image, reuses verified cache and rejects later tampering', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.manager.check()).available, true)
    assert.equal((await f.manager.download()).phase, 'ready')
    const path = await f.manager.verifiedFile()
    assert.equal(f.verified.length, 1)
    await f.manager.download()
    assert.equal(f.calls.filter(url => url.endsWith('.dmg')).length, 1)
    assert.equal(f.verified.length, 2)
    await writeFile(path, 'tampered')
    await assert.rejects(f.manager.verifiedFile(), /改变/)
    assert.equal(f.manager.snapshot().phase, 'failed')
  } finally { await f.clean() }
})
test('same version with a different commit and unsupported architectures never offer an install', async () => {
  const f = await fixture({ version: '0.4.2' })
  try {
    assert.equal((await f.manager.check()).available, false)
    f.manager.version = '0.4.1'; f.manager.arch = 'x64'
    assert.equal((await f.manager.check()).available, false)
    assert.match(f.manager.snapshot().message, /缺少/)
    assert.equal(f.calls.length, 0)
  } finally { await f.clean() }
})
test('Windows downloads an EXE using its platform checksum manifest', async () => {
  const assetName = 'Yaoyao-0.4.2-win-x64-setup.exe'
  const sums = Buffer.from(`${hash(data)}  ${assetName}\n`)
  const f = await fixture({ platform: 'win32', arch: 'x64', fetchImpl: async url => new Response(url.endsWith('.exe') ? data : sums) })
  try {
    f.release.assets = [
      { name: assetName, url: prefix + assetName, size: data.length },
      { name: 'SHA256SUMS-win-x64.txt', url: prefix + 'SHA256SUMS-win-x64.txt', size: sums.length },
    ]
    assert.equal((await f.manager.check()).available, true)
    assert.equal((await f.manager.download()).phase, 'ready')
    assert.match(await f.manager.verifiedFile(), /win-x64-setup\.exe$/)
  } finally { await f.clean() }
})
test('corrupt or missing checksum, wrong size, and failed image validation never expose a file', async () => {
  for (const failure of ['digest', 'size', 'checksum', 'image']) {
    const f = await fixture()
    try {
      await f.manager.check()
      if (failure === 'digest') f.release.assets[0].digest = 'sha256:' + '0'.repeat(64)
      if (failure === 'size') f.release.assets[0].size++
      if (failure === 'checksum') f.manager.fetchImpl = async () => new Response('wrong-checksum')
      if (failure === 'image') f.manager.verifyImage = async () => { throw new Error('invalid dmg') }
      assert.equal((await f.manager.download()).phase, 'failed')
      await assert.rejects(f.manager.verifiedFile())
      assert.deepEqual(await readdir(join(f.home, '0.4.2')), [])
    } finally { await f.clean() }
  }
})
test('cancels a pending download, excludes duplicate work and permits retry', async () => {
  const f = await fixture()
  try {
    await f.manager.check()
    const original = f.manager.fetchImpl
    let started
    const entered = new Promise(resolve => { started = resolve })
    f.manager.fetchImpl = async (url, options) => {
      if (!url.endsWith('.dmg')) return original(url, options)
      started()
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    const pending = f.manager.download(); await entered
    assert.equal((await f.manager.download()).phase, 'downloading')
    f.manager.cancel(); assert.equal((await pending).phase, 'cancelled')
    assert.deepEqual(await readdir(join(f.home, '0.4.2')), [])
    f.manager.fetchImpl = original
    assert.equal((await f.manager.download()).phase, 'ready')
  } finally { await f.clean() }
})
test('a failed check clears stale update availability and reports a retryable error', async () => {
  const f = await fixture()
  try {
    await f.manager.check()
    f.manager.inspect = async () => { throw new Error('GitHub rate limited') }
    const state = await f.manager.check()
    assert.equal(state.available, false); assert.equal(state.phase, 'failed')
    assert.match(state.error, /GitHub/)
  } finally { await f.clean() }
})
test('follows GitHub CDN redirects but rejects insecure or foreign hosts', async () => {
  let calls = 0
  const allowed = async () => ++calls === 1 ? new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response(data)
  assert.equal((await githubDownload(prefix + name, allowed)).status, 200)
  for (const location of ['http://github.com/file', 'https://evil.example/file', 'http://127.0.0.1/file']) {
    await assert.rejects(githubDownload(prefix + name, async () => new Response(null, { status: 302, headers: { Location: location } })), /不受信任/)
  }
})
