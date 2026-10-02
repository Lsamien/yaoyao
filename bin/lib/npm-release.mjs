import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

export const NPM_PACKAGE = '@lsamien/yaoyao'
export const NPM_RELEASE_SOURCE = `npm:${NPM_PACKAGE}`
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function isNpmInstallation(root) {
  if (!root.includes(`${sep}node_modules${sep}`) || existsSync(join(root, '.git'))) return false
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === NPM_PACKAGE }
  catch { return false }
}

export function parseNpmRelease(value) {
  if (!value || value.name !== NPM_PACKAGE || typeof value.version !== 'string' || !versionPattern.test(value.version))
    throw new Error('npm 发布包名称或版本无效')
  const { integrity, tarball } = value.dist ?? {}
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))
    throw new Error('npm 发布包缺少 SHA-512 完整性信息')
  let url
  try { url = new URL(tarball) } catch { throw new Error('npm 下载地址无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('npm 下载地址无效')
  return { version: value.version, integrity, tarball: url.href }
}

export function inspectNpmRelease(cwd) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['view', `${NPM_PACKAGE}@latest`, '--json'], {
      cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) { reject(new Error('无法读取 npm 最新版本，请检查仓库连接和 npm 配置')); return }
      try { resolve(parseNpmRelease(JSON.parse(stdout))) } catch (cause) { reject(cause) }
    })
  })
}

export function npmInstallationLocation(root) {
  root = realpathSync(root)
  const modules = dirname(dirname(root)), prefix = dirname(modules)
  if (basename(modules) !== 'node_modules' || root !== join(modules, NPM_PACKAGE) || !isNpmInstallation(root))
    throw new Error('直接覆盖更新仅支持已核对的 npm 安装目录')
  // Unix global installs use <prefix>/lib/node_modules; managed local installs
  // use <prefix>/node_modules. Preserve the layout and unrelated global tools.
  return basename(prefix) === 'lib' ? { prefix: dirname(prefix), global: true } : { prefix, global: false }
}

export function verifyPreparedNpmArchive(home, prepared, npm) {
  const downloads = realpathSync(join(home, 'updates', 'npm'))
  const archive = realpathSync(prepared.archive), directory = basename(dirname(archive))
  if (!/^[0-9a-f-]{36}$/.test(directory) || archive !== join(downloads, directory, 'release.tgz') || !lstatSync(archive).isFile())
    throw new Error('已下载更新的文件位置无效')
  const hash = createHash('sha512'), descriptor = openSync(archive, 'r'), buffer = Buffer.alloc(1024 * 1024)
  try {
    let bytes, received = 0
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      received += bytes
      if (received > 512 * 1024 * 1024) throw new Error('npm 安装包超过下载大小限制')
      hash.update(buffer.subarray(0, bytes))
    }
  } finally { closeSync(descriptor) }
  if (`sha512-${hash.digest('base64')}` !== npm.integrity) throw new Error('已下载更新的安装包完整性校验失败')
  return archive
}

/** Validate the installed application's version, build and published files. */
export function npmRuntimeDigest(root, version) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'))
  const build = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'))
  if (packageJson.name !== NPM_PACKAGE || packageJson.version !== version
    || release.schemaVersion !== 1 || release.releaseVersion !== version || release.webVersion !== version || release.gitTag !== `v${version}`)
    throw new Error('npm 包与目标发布版本不一致')
  if (!/^[a-f0-9]{40,64}$/.test(build.commit) || !Number.isSafeInteger(build.buildNumber))
    throw new Error('npm 包缺少有效的构建信息')
  for (const file of ['dist/index.html', 'dist-server/server/index.js', 'bin/hermes-yaoyao.mjs', 'bin/hermes-yaoyao-updater.mjs']) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error(`npm 包缺少服务文件：${file}`)
  }
  const hash = createHash('sha256')
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'node_modules') continue
      const path = join(directory, name), relative = `${prefix}${name}`, stat = lstatSync(path)
      if (stat.isDirectory()) visit(path, `${relative}/`)
      else if (stat.isFile()) hash.update(relative).update('\0').update(createHash('sha256').update(readFileSync(path)).digest())
      else throw new Error('npm 服务文件包含不支持的链接或文件')
    }
  }
  visit(root)
  return hash.digest('hex')
}
