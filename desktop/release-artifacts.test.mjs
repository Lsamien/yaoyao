import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dump } from 'js-yaml'
import { releaseSigningOptions, verifyUpdateArtifacts } from '../scripts/desktop-release.mjs'

test('formal desktop releases require a distribution identity and notarization credentials', () => {
  assert.throws(() => releaseSigningOptions({}), /Developer ID/)
  assert.throws(() => releaseSigningOptions({ CSC_NAME: 'Apple Development: Test' }), /Developer ID/)
  assert.throws(() => releaseSigningOptions({ CSC_NAME: 'Developer ID Application: Test' }), /公证/)
  const options = releaseSigningOptions({ CSC_NAME: 'Developer ID Application: Test', APPLE_API_KEY: '/fixture/key.p8', APPLE_API_KEY_ID: 'key', APPLE_API_ISSUER: 'issuer' })
  assert.equal(options.forceCodeSigning, true); assert.equal(options.mac.notarize, true)
  assert.equal(options.mac.identity, 'Test'); assert.equal(options.mac.type, 'distribution')
  assert.deepEqual(releaseSigningOptions({ CSC_NAME: 'Developer ID Application: Test', APPLE_KEYCHAIN_PROFILE: 'yaoyao-notary' }), options)
  assert.throws(() => releaseSigningOptions({ CSC_NAME: 'Developer ID Application: Test', APPLE_KEYCHAIN: '/fixture/login.keychain-db' }), /公证/)
  assert.throws(() => releaseSigningOptions({ CSC_NAME: 'Developer ID Application: Test', APPLE_KEYCHAIN_PROFILE: '  ' }), /公证/)
})

test('release verification rejects incomplete, mixed-version and corrupt updater artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yaoyao-update-artifacts-'))
  const bytes = Buffer.from('signed fixture'), version = '0.4.63'
  const files = ['zip', 'dmg'].map(ext => ({ url: `Yaoyao-${version}-arm64.${ext}`, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }))
  try {
    for (const file of files) { await writeFile(join(directory, file.url), bytes); await writeFile(join(directory, file.url + '.blockmap'), 'map') }
    await writeFile(join(directory, 'latest-mac.yml'), dump({ version, files }))
    assert.equal((await verifyUpdateArtifacts(directory, version)).length, 5)
    await assert.rejects(verifyUpdateArtifacts(directory, '0.4.64'), /版本/)
    await writeFile(join(directory, files[0].url), 'tampered')
    await assert.rejects(verifyUpdateArtifacts(directory, version), /大小/)
    await writeFile(join(directory, files[0].url), Buffer.alloc(bytes.length))
    await assert.rejects(verifyUpdateArtifacts(directory, version), /SHA-512/)
    await writeFile(join(directory, 'latest-mac.yml'), dump({ version, files: [files[1]] }))
    await assert.rejects(verifyUpdateArtifacts(directory, version), /缺少唯一/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
