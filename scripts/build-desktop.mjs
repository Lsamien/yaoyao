import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { buildRunner } from './build-runner.mjs'
import { cp, mkdir, rm, readdir, readFile, writeFile, realpath, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sealRuntime } from '../bin/lib/runtime-release.mjs'

const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.desktop-build')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await build({ entryPoints: [resolve(root, 'src/server/index.ts')], outfile: resolve(out, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['vite'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: true,
})
await buildRunner(out)
const swiftTarget=process.arch==='arm64'?'arm64-apple-macosx12.0':'x86_64-apple-macosx12.0'
execFileSync('xcrun',['swiftc','-O','-target',swiftTarget,resolve(root,'desktop/keychain-helper.swift'),'-o',resolve(out,'keychain-helper')],{stdio:'inherit'})
execFileSync('xcrun',['swiftc','-O','-target',swiftTarget,'-D','DEVELOPMENT_HELPER',resolve(root,'desktop/keychain-helper.swift'),'-o',resolve(out,'keychain-helper-dev')],{stdio:'inherit'})
await cp(resolve(root, 'dist'), resolve(out, 'ui'), { recursive: true })
await cp(resolve(root, 'release.json'), resolve(out, 'release.json'))
await cp(resolve(root, 'public/icons/icon-512.png'), resolve(root, 'desktop/icon.png'))
const shell = resolve(out, 'shell')
await mkdir(shell)
for (const file of await readdir(resolve(root, 'desktop'))) {
  if (file.endsWith('.test.mjs') || !/\.(js|mjs|cjs|html|css|png)$/.test(file)) continue
  await cp(resolve(root, 'desktop', file), resolve(shell, file))
}
for (const file of ['boot.html', 'boot.js', 'boot.css', 'preload.cjs']) await readFile(resolve(shell, file))
await cp(resolve(root,'build-info.json'),resolve(out,'build-info.json'))
const manifest = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'))
const service = resolve(out, 'web-service')
await mkdir(service)
for (const file of ['server.mjs', 'ui', 'release.json', 'build-info.json', 'hermes_worker.py', 'guest_proxy.py', 'computer-image', 'third-party']) await cp(resolve(out, file), resolve(service, file), { recursive: true })
await cp(resolve(root, 'bin'), resolve(service, 'bin'), { recursive: true })
await cp(await realpath(process.execPath), resolve(service, 'node'))
await cp(resolve(await realpath(process.execPath), '../../LICENSE'), resolve(service, 'NODE-LICENSE.txt'))
await chmod(resolve(service, 'node'), 0o755)
await writeFile(resolve(service, 'package.json'), JSON.stringify({ name: 'hermes-yaoyao', version: manifest.webVersion, type: 'module' }))
sealRuntime(service)
await writeFile(resolve(shell, 'package.json'), JSON.stringify({ name: 'hermes-yaoyao-desktop', version: manifest.webVersion,
  productName: '夭夭', description: '夭夭：本地服务、多 Agent 团队与电脑工作空间',
  author: 'YaoYao contributors', license: 'BSL-1.1', main: 'main.mjs', type: 'module' }, null, 2))
console.log('桌面服务和界面已打包到 .desktop-build')
