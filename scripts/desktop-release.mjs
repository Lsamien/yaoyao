import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

export function releaseSigningOptions(env = process.env) {
  if (!env.CSC_NAME?.startsWith('Developer ID Application:'))
    throw new Error('正式自动更新包需要 CSC_NAME 指定 Developer ID Application 签名身份')
  const apiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
  const appleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE?.trim()
  if (!apiKey && !appleId && !keychainProfile) throw new Error('请配置 Apple 公证凭据：APPLE_KEYCHAIN_PROFILE，APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER，或 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID')
  // electron-builder selects the certificate type itself and rejects its prefix
  // in the identity qualifier. Enforce a distribution identity, then strip it.
  const identity = env.CSC_NAME.slice('Developer ID Application:'.length).trim()
  if (!identity) throw new Error('CSC_NAME 缺少分发签名身份名称')
  return { forceCodeSigning: true, mac: { identity, type: 'distribution', notarize: true } }
}

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

export async function verifyUpdateArtifacts(directory, version, arch = 'arm64') {
  const metadata = load(await readFile(join(directory, 'latest-mac.yml'), 'utf8'))
  if (metadata?.version !== version || !Array.isArray(metadata.files)) throw new Error('自动更新清单版本无效')
  const required = [`Yaoyao-${version}-${arch}.zip`, `Yaoyao-${version}-${arch}.dmg`]
  for (const name of required) {
    const matches = metadata.files.filter(file => file.url === name)
    if (matches.length !== 1) throw new Error(`自动更新清单缺少唯一附件：${name}`)
  }
  const names = ['latest-mac.yml']
  for (const file of metadata.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url || !required.includes(file.url)) throw new Error('自动更新清单包含非本次发布的附件')
    const fullPath = join(directory, file.url), info = await stat(fullPath)
    if (file.size !== info.size || !info.size || !info.isFile()) throw new Error(`安装包大小无效：${file.url}`)
    if (file.sha512 !== await digest(fullPath, 'sha512', 'base64')) throw new Error(`安装包 SHA-512 不匹配：${file.url}`)
    names.push(file.url)
    const blockmap = `${file.url}.blockmap`
    if (!(await stat(join(directory, blockmap))).size) throw new Error(`差分更新文件为空：${blockmap}`)
    names.push(blockmap)
  }
  return names
}

export async function packageDesktopRelease() {
  const signing = releaseSigningOptions()
  const root = resolve(import.meta.dirname, '..')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const { build, Platform, Arch } = await import('electron-builder')
  await build({ projectDir: root, targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
    publish: 'never', config: signing })
  const directory = join(root, 'desktop-release')
  const names = await verifyUpdateArtifacts(directory, version)
  const app = join(directory, 'mac-arm64', '夭夭.app')
  const feed = load(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8'))
  if (feed.provider !== 'github' || feed.owner !== 'Lsamien' || feed.repo !== 'yaoyao') throw new Error('安装包中的更新源不正确')
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' })
  const sums = await Promise.all(names.map(async name => `${await digest(join(directory, name), 'sha256', 'hex')}  ${name}`))
  await writeFile(join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
  console.log(`正式桌面产物已验证：${[...names, 'SHA256SUMS.txt'].join('、')}。尚未上传发布。`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageDesktopRelease()
