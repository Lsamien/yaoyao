import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

async function hash(path, algorithm, encoding) {
  const result = createHash(algorithm)
  for await (const bytes of createReadStream(path)) result.update(bytes)
  return result.digest(encoding)
}
export function windowsSigningOptions(env = process.env) {
  if (env.YAOYAO_WINDOWS_SIGNED !== '1') return { forceCodeSigning: false, win: { signAndEditExecutable: true, signExecutable: false } }
  if (!env.CSC_LINK || !env.YAOYAO_WINDOWS_PUBLISHER?.trim()) throw new Error('正式 Windows 包需要 CSC_LINK、CSC_KEY_PASSWORD（如适用）和 YAOYAO_WINDOWS_PUBLISHER')
  return { forceCodeSigning: true, win: { signExecutable: true,
    signtoolOptions: { publisherName: env.YAOYAO_WINDOWS_PUBLISHER.trim() }, verifyUpdateCodeSignature: true } }
}
export async function verifyWindowsArtifacts(directory, version) {
  const name = `Yaoyao-${version}-win-x64-setup.exe`
  const metadata = load(await readFile(join(directory, 'latest.yml'), 'utf8'))
  if (metadata?.version !== version || metadata.files?.length !== 1 || metadata.files[0].url !== name) throw new Error('Windows 更新清单与安装包不匹配')
  for (const file of metadata.files) {
    if (basename(file.url) !== file.url) throw new Error('安装包路径无效')
    const path = join(directory, file.url), info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size !== file.size || file.sha512 !== await hash(path, 'sha512', 'base64')) throw new Error('Windows 安装包大小或 SHA-512 不匹配')
    const exe = await readFile(path)
    if (exe.toString('ascii', 0, 2) !== 'MZ') throw new Error('Windows 安装包不是 PE 文件')
  }
  if (!(await stat(join(directory, `${name}.blockmap`))).size) throw new Error('Windows 差分更新文件为空')
  const names = [name, `${name}.blockmap`, 'latest.yml']
  await writeFile(join(directory, 'SHA256SUMS-win-x64.txt'), (await Promise.all(names.map(async name => `${await hash(join(directory, name), 'sha256', 'hex')}  ${name}`))).join('\n') + '\n')
  return names
}
export async function packageWindowsDesktop() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 CI 或 Windows 电脑打包')
  const root = resolve(import.meta.dirname, '..'), directory = join(root, 'desktop-release', 'windows-x64')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const { build, Platform, Arch } = await import('electron-builder')
  const signing = windowsSigningOptions()
  if (process.env.YAOYAO_WINDOWS_SIGNED !== '1') process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
    config: { ...signing, directories: { output: directory }, electronUpdaterCompatibility: '>=2.16' } })
  await verifyWindowsArtifacts(directory, version)
  const { listPackage } = await import('@electron/asar')
  if (listPackage(join(directory, 'win-unpacked/resources/app.asar')).some(name => /[\\/]node_modules[\\/]/.test(name))) throw new Error('Windows 客户端意外包含服务器或开发依赖')
  const feed = load(await readFile(join(directory, 'win-unpacked/resources/app-update.yml'), 'utf8'))
  if (feed.provider !== 'github' || feed.owner !== 'Lsamien' || feed.repo !== 'yaoyao') throw new Error('Windows 更新源配置无效')
  if (process.env.YAOYAO_WINDOWS_SIGNED === '1' && ![feed.publisherName].flat().includes(process.env.YAOYAO_WINDOWS_PUBLISHER.trim())) throw new Error('正式 Windows 更新配置缺少发布者签名校验')
  const info = JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'))
  await writeFile(join(directory, 'BUILD-INFO.json'), JSON.stringify({ version, platform: 'win32', arch: 'x64',
    signing: process.env.YAOYAO_WINDOWS_SIGNED === '1' ? 'signed' : 'unsigned-test', ...info }, null, 2) + '\n')
  await writeFile(join(directory, 'README.txt'), '夭夭 Windows x64 客户端\n' +
    (process.env.YAOYAO_WINDOWS_SIGNED === '1' ? '正式签名构建。\n' : '未签名测试包，Windows 可能提示未知发布者。\n') +
    '支持 Windows 10/11 x64；连接已有夭夭服务器。本机无需 Node、Python、Hermes。\n' +
    'Windows 电脑操作需要服务器支持；更新清单随本次构建交付，尚未上传正式更新源。\n' +
    '完整验收步骤见 docs/windows-client.md。CI 构建不代表真实桌面控制已完成验收。\n')
  console.log(`Windows 安装包及更新清单已校验：${directory}（尚未发布）`)
  console.log(await readFile(join(directory, 'SHA256SUMS-win-x64.txt'), 'utf8'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageWindowsDesktop()
