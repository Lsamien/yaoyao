import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { bundleDesktopUpdater } from './bundle-desktop-updater.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 原生助手请通过 Windows CI 或 Windows x64 电脑构建')
const root = resolve(import.meta.dirname, '..'), out = join(root, '.desktop-build'), shell = join(out, 'shell')
await rm(out, { recursive: true, force: true })
await mkdir(shell, { recursive: true })
await mkdir(join(out, 'branding'))
const native = join(out, 'native')
execFileSync('cmake', ['-S', join(root, 'desktop/windows'), '-B', native, '-A', 'x64'], { stdio: 'inherit' })
execFileSync('cmake', ['--build', native, '--config', 'Release'], { stdio: 'inherit' })
for (const name of ['computer-helper.exe', 'computer-helper-dev.exe']) {
  await cp(join(native, 'Release', name), join(out, name))
  execFileSync(join(out, name), ['--self-test'], { stdio: 'inherit' })
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
execFileSync(createRequire(import.meta.url)('electron'), [join(root, 'scripts/build-windows-icon.cjs'),
  join(root, 'public/icons/icon-512.png'), join(out, 'branding/icon.ico')], { stdio: 'inherit', env })
await bundleDesktopUpdater(join(out, 'electron-updater.cjs'), 'win32')
await build({ entryPoints: [join(root, 'src/server/githubReleases.ts')], outfile: join(out, 'github-release.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await cp(join(root, 'bin/lib/data-home.mjs'), join(shell, 'data-home.mjs'))
await cp(join(root, 'bin/lib/desktop-activation.mjs'), join(shell, 'desktop-activation.mjs'))
for (const file of await readdir(join(root, 'desktop'))) {
  if (['data-home.mjs', 'desktop-activation.mjs'].includes(file) || file.endsWith('.test.mjs') || !/\.(js|mjs|cjs|html|css|png|svg)$/.test(file)) continue
  if (['file-transfer.mjs', 'host-files.mjs'].includes(file)) {
    await build({ entryPoints: [join(root, 'desktop', file)], outfile: join(shell, file), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
  } else {
    if (/\.(js|mjs|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', join(root, 'desktop', file)])
    await cp(join(root, 'desktop', file), join(shell, file))
  }
}
await cp(join(root, 'public/icons/icon-512.png'), join(shell, 'icon.png'))
await cp(join(root, 'public/icons/icon-512.png'), join(root, 'desktop/icon.png'))
for (const file of ['release.json', 'build-info.json']) await cp(join(root, file), join(out, file))
for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(join(root, file), join(shell, file), { recursive: true })
const { webVersion: version } = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
await writeFile(join(shell, 'package.json'), JSON.stringify({ name: 'yaoyao-desktop', version, productName: '夭夭',
  description: '夭夭 AI：Windows 客户端', author: 'YaoYao contributors', license: 'Apache-2.0', main: 'main.mjs', type: 'module' }, null, 2))
console.log('Windows 客户端与原生助手已构建，不包含本机服务器运行时')
