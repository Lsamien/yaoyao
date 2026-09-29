// Verification for the client-only macOS desktop build.
// Structural checks always run; the GUI smoke runs when Playwright can drive
// the packaged Electron (skipped automatically when launch is unsupported,
// e.g. the Playwright/Electron flag incompatibility on this machine).
// Run: node --test scripts/smoke-client-desktop.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const staging = join(root, '.desktop-build-client')
const appRoot = join(root, 'desktop-release-client/mac-arm64/夭夭.app')

test('client staging omits the local server runtime but keeps client pieces', () => {
  assert.equal(existsSync(join(staging, 'client-only.marker')), true, 'marker present')
  for (const forbidden of ['server.mjs', 'runner.mjs', 'web-service', 'ui', 'node_modules', 'node'])
    assert.equal(existsSync(join(staging, forbidden)), false, `${forbidden} must not ship`)
  for (const needed of ['github-release.mjs', 'electron-updater.cjs', 'keychain-helper', 'computer-helper', 'release.json', 'build-info.json'])
    assert.equal(existsSync(join(staging, needed)), true, `${needed} must ship`)
  for (const page of ['boot.html', 'boot.js', 'boot.css', 'preload.cjs', 'main.mjs', 'platform.mjs', 'remote-login.mjs', 'host-manager.mjs'])
    assert.equal(existsSync(join(staging, 'shell', page)), true, `${page} must ship`)
})

test('packaged app carries the marker and the client policy code', () => {
  assert.equal(existsSync(appRoot), true, 'packaged app exists (run desktop:pack:client first)')
  const runtime = join(appRoot, 'Contents/Resources/runtime')
  assert.equal(existsSync(join(runtime, 'client-only.marker')), true, 'marker inside Resources/runtime')
  for (const forbidden of ['server.mjs', 'runner.mjs', 'web-service', 'ui', 'node'])
    assert.equal(existsSync(join(runtime, forbidden)), false, `${forbidden} must not be packaged`)
  const asar = readFileSync(join(appRoot, 'Contents/Resources/app.asar'), 'latin1')
  assert.ok(asar.includes('clientOnlyRuntime'), 'main.mjs inside asar knows the client policy')
  assert.ok(!asar.includes('DesktopServiceManager(') || asar.includes('clientOnlyRuntime'), 'policy guard present')
  // The runtime detection must resolve for the packaged layout.
  const probe = `import { clientOnlyRuntime } from ${JSON.stringify('file://' + join(root, 'desktop/platform.mjs'))}
    console.log(clientOnlyRuntime(${JSON.stringify(runtime)}) ? 'client' : 'full')`
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }).trim()
  assert.equal(result, 'client')
})

test('packaged app size stays close to the bare Electron runtime', () => {
  assert.equal(existsSync(appRoot), true, 'packaged app exists')
  let total = 0
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const full = join(directory, entry.name); if (entry.isDirectory()) walk(full); else total += statSync(full).size } }
  walk(join(appRoot, 'Contents/Resources'))
  const resourcesMB = total / 1024 / 1024
  assert.ok(resourcesMB < 25, `Resources should stay small, got ${Math.round(resourcesMB)}MB`)
})
