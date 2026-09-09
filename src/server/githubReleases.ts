import { parseReleaseManifest, type ReleaseManifest } from './releases.js'
import { normalizeReleaseSource } from '../../bin/lib/release-source.mjs'
export { DEFAULT_RELEASE_SOURCE, normalizeReleaseSource } from '../../bin/lib/release-source.mjs'
export { compareReleaseVersions } from './releases.js'

export interface GitHubAsset { name: string; url: string; size: number; digest?: string }
export interface GitHubRelease {
  manifest: ReleaseManifest
  commit: string
  releasePageUrl: string
  notes: string
  assets: GitHubAsset[]
}
export function githubRepository(source: string): string | undefined {
  const match = normalizeReleaseSource(source).match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/)
  return match?.[1]
}
export function githubReleasePage(source: string): string | undefined {
  const repo = githubRepository(source)
  return repo ? `https://github.com/${repo}/releases` : undefined
}

/** Public releases require no end-user token, gh installation, or Hermes connection. */
export async function inspectGitHubRelease(source: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<GitHubRelease> {
  const repo = githubRepository(source)
  if (!repo) throw new Error('不是有效的 GitHub 仓库地址')
  const api = `https://api.github.com/repos/${repo}`
  async function json(url: string): Promise<any> {
    let response: Response
    try {
      response = await fetchImpl(url, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
    } catch {
      if (signal?.aborted) throw new Error('检查已取消')
      throw new Error('无法连接 GitHub 发布源，请检查网络后重试')
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试')
      if (response.status === 404) throw new Error('GitHub 仓库尚无稳定发布，或发布文件不存在')
      throw new Error(`GitHub 发布源返回 HTTP ${response.status}`)
    }
    try { return await response.json() } catch { throw new Error('GitHub 发布数据不是有效的 JSON') }
  }
  const release = await json(`${api}/releases/latest`)
  if (release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('GitHub 最新发布不是有效的稳定版本')
  }
  const tag = release.tag_name as string
  let ref = (await json(`${api}/git/ref/tags/${encodeURIComponent(tag)}`)).object
  for (let depth = 0; ref?.type === 'tag' && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error('GitHub 标签提交无效')
    ref = (await json(`${api}/git/tags/${ref.sha}`)).object
  }
  if (ref?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error('GitHub 标签提交无效')
  // Read an immutable commit, never a moving branch or tag URL.
  const manifest = parseReleaseManifest(await json(`https://raw.githubusercontent.com/${repo}/${ref.sha}/release.json`))
  if (manifest.gitTag !== tag) throw new Error('GitHub 标签与 release.json 版本不一致')
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`
  const assets: GitHubAsset[] = []
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    if (typeof asset.name !== 'string' || !/^[\w.-]+$/.test(asset.name) || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || asset.browser_download_url !== prefix + asset.name) continue
    assets.push({ name: asset.name, url: asset.browser_download_url, size: asset.size,
      ...(typeof asset.digest === 'string' ? { digest: asset.digest } : {}) })
  }
  return { manifest, commit: ref.sha, assets, notes: typeof release.body === 'string' ? release.body.slice(0, 64000) : '',
    releasePageUrl: `https://github.com/${repo}/releases/tag/${tag}` }
}
