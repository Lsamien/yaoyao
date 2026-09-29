import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, readdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bundleDesktopUpdater } from './bundle-desktop-updater.mjs'

/** Client-only macOS desktop: no embedded server, runner or Node runtime.
 * The app connects to an existing yaoyao server (Docker or otherwise) and can
 * still act as a remote-controlled computer; everything else is remote. */
const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.desktop-build-client')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await bundleDesktopUpdater(resolve(out, 'electron-updater.cjs'))
execFileSync('xcrun', ['swift', resolve(root, 'scripts/build-desktop-icon.swift'),
  resolve(root, 'public/brand/AppIcon-1024.png'), resolve(out, 'branding')], { stdio: 'inherit' })
execFileSync('iconutil', ['-c', 'icns', resolve(out, 'branding/icon.iconset'),
  '-o', resolve(out, 'branding/icon.icns')], { stdio: 'inherit' })
await build({ entryPoints: [resolve(root, 'src/server/githubReleases.ts')], outfile: resolve(out, 'github-release.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const swiftTarget = process.arch === 'arm64' ? 'arm64-apple-macosx12.0' : 'x86_64-apple-macosx12.0'
execFileSync('xcrun', ['swiftc', '-O', '-target', swiftTarget, resolve(root, 'desktop/keychain-helper.swift'), '-o', resolve(out, 'keychain-helper')], { stdio: 'inherit' })
execFileSync('xcrun', ['swiftc', '-O', '-target', swiftTarget, '-D', 'DEVELOPMENT_HELPER', resolve(root, 'desktop/keychain-helper.swift'), '-o', resolve(out, 'keychain-helper-dev')], { stdio: 'inherit' })
for (const development of [false, true]) execFileSync('xcrun', ['swiftc', '-O', '-target', swiftTarget,
  ...(development ? ['-D', 'DEVELOPMENT_HELPER'] : []), resolve(root, 'desktop/computer-helper.swift'), '-o', resolve(out, development ? 'computer-helper-dev' : 'computer-helper')], { stdio: 'inherit' })
await cp(resolve(root, 'release.json'), resolve(out, 'release.json'))
await cp(resolve(root, 'build-info.json'), resolve(out, 'build-info.json'))
await cp(resolve(root, 'public/icons/icon-512.png'), resolve(root, 'desktop/icon.png'))
const shell = resolve(out, 'shell')
await mkdir(shell)
await cp(resolve(root, 'bin/lib/data-home.mjs'), resolve(shell, 'data-home.mjs'))
await cp(resolve(root, 'bin/lib/desktop-activation.mjs'), resolve(shell, 'desktop-activation.mjs'))
for (const file of await readdir(resolve(root, 'desktop'))) {
  if (['data-home.mjs', 'desktop-activation.mjs'].includes(file) || file.endsWith('.test.mjs') || !/\.(js|mjs|cjs|html|css|png|svg)$/.test(file)) continue
  if (['file-transfer.mjs', 'host-files.mjs'].includes(file)) {
    await build({ entryPoints: [resolve(root, 'desktop', file)], outfile: resolve(shell, file), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
    continue
  }
  if (/\.(js|mjs|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', resolve(root, 'desktop', file)], { stdio: 'inherit' })
  await cp(resolve(root, 'desktop', file), resolve(shell, file))
}
for (const file of ['boot.html', 'boot.js', 'boot.css', 'preload.cjs']) await readFile(resolve(shell, file))
await writeFile(resolve(out, 'client-only.marker'), '')
const manifest = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'))
await writeFile(resolve(shell, 'package.json'), JSON.stringify({ name: 'yaoyao-desktop-client', version: manifest.webVersion,
  productName: '夭夭', description: '夭夭 AI：连接服务器的 macOS 客户端',
  author: 'YaoYao contributors', license: 'Apache-2.0', main: 'main.mjs', type: 'module' }, null, 2))
console.log('macOS 客户端已构建到 .desktop-build-client（不含本机服务器运行时）')
