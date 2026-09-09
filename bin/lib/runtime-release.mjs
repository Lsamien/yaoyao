import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'))
export function sourceBuild(root) {
  try {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const ancestors = git(['rev-list', 'HEAD']).split('\n')
    return { commit: ancestors[0], ancestors, buildNumber: ancestors.length, dirty: Boolean(git(['status', '--porcelain'])) }
  } catch { return { commit: 'source-archive', ancestors: [], buildNumber: 0, dirty: true } }
}
export function readRuntime(root) {
  const release = readJSON(join(root, 'release.json'))
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.webVersion) || release.webVersion !== release.releaseVersion || release.gitTag !== `v${release.webVersion}`)
    throw new Error('服务发布清单无效')
  const build = existsSync(join(root, 'build-info.json')) ? readJSON(join(root, 'build-info.json')) : sourceBuild(root)
  const manifest = existsSync(join(root, 'runtime-manifest.json')) ? readJSON(join(root, 'runtime-manifest.json')) : undefined
  return { ...build, version: release.webVersion, release, hasBuildIdentity: Number.isSafeInteger(build.buildNumber) && existsSync(join(root, 'build-info.json')), artifactDigest: manifest?.artifactDigest }
}
export function compareVersions(a, b) {
  const parts = value => { const split = value.indexOf('-'); return [value.slice(0, split < 0 ? undefined : split).split('.').map(Number), split < 0 ? undefined : value.slice(split + 1).split('.')] }
  const [ac, as] = parts(a), [bc, bs] = parts(b)
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return ac[i] > bc[i] ? 1 : -1
  if (!as || !bs) return as ? -1 : bs ? 1 : 0
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === bs[i]) continue
    if (as[i] === undefined || bs[i] === undefined) return as[i] === undefined ? -1 : 1
    const an = /^\d+$/.test(as[i]), bn = /^\d+$/.test(bs[i])
    if (an && bn) return Number(as[i]) > Number(bs[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return as[i] > bs[i] ? 1 : -1
  }
  return 0
}
/** Commit hashes are identities, never sortable version numbers. Unknown branch
 * ancestry must not turn an App install into an accidental downgrade. */
export function syncDecision(target, current) {
  if (!current) return 'install'
  const version = compareVersions(target.version, current.version)
  if (version) return version > 0 ? 'upgrade' : 'newer'
  if (target.artifactDigest && target.artifactDigest === current.artifactDigest) return 'same'
  if (target.commit === current.commit && !target.dirty && !current.dirty) return 'same'
  if (target.ancestors?.includes(current.commit) && target.commit !== current.commit) return 'upgrade'
  if (current.ancestors?.includes(target.commit) && target.commit !== current.commit) return 'newer'
  return 'unknown'
}
export function runtimeFiles(root, prefix = '') {
  const files = {}
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = join(prefix, name), stat = lstatSync(join(root, path))
    if (path === 'runtime-manifest.json') continue
    if (stat.isSymbolicLink()) throw new Error('服务包不得包含符号链接')
    if (stat.isDirectory()) Object.assign(files, runtimeFiles(root, path))
    else if (stat.isFile()) files[path] = digest(readFileSync(join(root, path)))
    else throw new Error('服务包包含不支持的文件')
  }
  return files
}
export function sealRuntime(root) {
  const files = runtimeFiles(root), artifactDigest = digest(JSON.stringify(files))
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, artifactDigest, files }, null, 2) + '\n')
  return artifactDigest
}
export function verifyRuntimePackage(root) {
  const manifest = readJSON(join(root, 'runtime-manifest.json')), files = runtimeFiles(root)
  if (manifest.schemaVersion !== 1 || digest(JSON.stringify(files)) !== manifest.artifactDigest || JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error('App 配套服务包校验失败，请重新安装完整 App')
  for (const file of ['node', 'server.mjs', 'ui/index.html', 'bin/hermes-yaoyao.mjs', 'bin/hermes-yaoyao-updater.mjs', 'build-info.json'])
    if (!files[file]) throw new Error(`App 配套服务包缺少 ${file}`)
  return readRuntime(root)
}
export function inside(path, root) {
  const result = relative(realpathSync(root), resolve(path))
  return result !== '' && result !== '..' && !result.startsWith('../') && !result.startsWith('/')
}
