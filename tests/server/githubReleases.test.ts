// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest'
import { inspectGitHubRelease, githubRepository } from '../../src/server/githubReleases.js'
import { inspectGitRemote } from '../../src/server/updateManager.js'
import { normalizeReleaseSource, DEFAULT_RELEASE_SOURCE } from '../../bin/lib/release-source.mjs'
import { loadServerConfig } from '../../src/server/config.js'
import { launchAgentPlist } from '../../bin/hermes-yaoyao.mjs'

const commit = 'a'.repeat(40), tagObject = 'b'.repeat(40)
const gitCalls = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: gitCalls.execFile }))
const manifest = { schemaVersion: 1, releaseVersion: '0.4.2', webVersion: '0.4.2', gitTag: 'v0.4.2' }
const api = 'https://api.github.com/repos/Lsamien/yaoyao'
function fixture(overrides: Record<string, unknown> = {}) {
  const documents: Record<string, unknown> = {
    [`${api}/releases/latest`]: { draft: false, prerelease: false, tag_name: 'v0.4.2', body: 'Release notes', assets: [
      { name: 'Yaoyao-0.4.2-arm64.dmg', size: 10, state: 'uploaded', browser_download_url: 'https://github.com/Lsamien/yaoyao/releases/download/v0.4.2/Yaoyao-0.4.2-arm64.dmg' },
      { name: 'bad.dmg', size: 10, state: 'uploaded', browser_download_url: 'https://evil.test/bad.dmg' },
    ] },
    [`${api}/git/ref/tags/v0.4.2`]: { object: { type: 'tag', sha: tagObject } },
    [`${api}/git/tags/${tagObject}`]: { object: { type: 'commit', sha: commit } },
    [`https://raw.githubusercontent.com/Lsamien/yaoyao/${commit}/release.json`]: manifest,
    ...overrides,
  }
  return vi.fn(async (url: string | URL | Request) => {
    const value = documents[String(url)]
    return value instanceof Response ? value : Response.json(value ?? {}, { status: value ? 200 : 404 })
  }) as unknown as typeof fetch
}
afterEach(() => { vi.unstubAllGlobals(); gitCalls.execFile.mockReset() })
describe('GitHub release source', () => {
  it('migrates only known official sources and leaves user forks unchanged', () => {
    for (const source of [undefined, '', 'https://github.com/Lsamien/hermes-yaoyao', 'https://github.com/Lsamien/hermes-yaoyao.git/', 'git@github.com:Lsamien/hermes-yaoyao.git', 'https://git.samien.cn/samien/hermes-yaoyao.git', 'http://192.168.153.8:3000/samien/hermes-yaoyao/', 'git@git.samien.cn:samien/hermes-yaoyao.git']) expect(normalizeReleaseSource(source)).toBe(DEFAULT_RELEASE_SOURCE)
    for (const source of ['https://git.samien.cn/other/fork.git', 'https://private.example/repo.git', 'git@private.example:fork.git', 'https://github.com/other/fork.git']) expect(normalizeReleaseSource(source)).toBe(source)
    expect(normalizeReleaseSource('https://github.com/lsamien/Hermes-Yaoyao')).toBe(DEFAULT_RELEASE_SOURCE)
    expect(githubRepository('https://github.com/Lsamien/yaoyao/')).toBe('Lsamien/yaoyao')
    expect(loadServerConfig({ HERMES_YAOYAO_RELEASE_SOURCE: 'https://git.samien.cn/samien/hermes-yaoyao.git' }).releaseSource).toBe(DEFAULT_RELEASE_SOURCE)
    const plist = launchAgentPlist({ environment: { HERMES_YAOYAO_RELEASE_SOURCE: 'https://git.samien.cn/samien/hermes-yaoyao.git' } })
    expect(plist).toContain(DEFAULT_RELEASE_SOURCE)
    expect(launchAgentPlist({ environment: { HERMES_YAOYAO_RELEASE_SOURCE: 'https://private.example/fork.git' } })).toContain('https://private.example/fork.git')
  })
  it('selects a published stable release, peels annotated tags and reads an immutable manifest', async () => {
    const fetchImpl = fixture()
    const result = await inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fetchImpl)
    expect(result).toMatchObject({ manifest, commit, notes: 'Release notes', releasePageUrl: 'https://github.com/Lsamien/yaoyao/releases/tag/v0.4.2' })
    expect(result.assets).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledWith(`https://raw.githubusercontent.com/Lsamien/yaoyao/${commit}/release.json`, expect.anything())
  })
  it('uses the GitHub adapter instead of cloning or contacting 9119', async () => {
    const fetchImpl = fixture(); vi.stubGlobal('fetch', fetchImpl)
    expect(await inspectGitRemote(DEFAULT_RELEASE_SOURCE, manifest as any)).toMatchObject({ manifest, commit })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(gitCalls.execFile).not.toHaveBeenCalled()
  })
  it('keeps a custom GitHub fork on the original Git-tag discovery path', async () => {
    gitCalls.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''))
    const fetchImpl = vi.fn(); vi.stubGlobal('fetch', fetchImpl)
    const source = 'https://github.com/other/fork.git'
    expect(await inspectGitRemote(source, manifest as any)).toBeUndefined()
    expect(gitCalls.execFile).toHaveBeenCalledWith('git', ['ls-remote', '--tags', source, 'refs/tags/v*'], expect.anything(), expect.any(Function))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each([403, 429, 404, 500])('surfaces HTTP %s rather than returning up to date', async status => {
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fixture({ [`${api}/releases/latest`]: new Response('', { status }) }))).rejects.toThrow(/GitHub/)
  })
  it.each([{ draft: true }, { prerelease: true }, { tag_name: 'v0.4.2-beta.1' }])('rejects non-stable release metadata %s', async patch => {
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fixture({ [`${api}/releases/latest`]: { draft: false, prerelease: false, tag_name: 'v0.4.2', ...patch } }))).rejects.toThrow('稳定')
  })
  it('rejects mismatching manifests and invalid tags', async () => {
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fixture({ [`https://raw.githubusercontent.com/Lsamien/yaoyao/${commit}/release.json`]: { ...manifest, gitTag: 'v0.4.1' } }))).rejects.toThrow()
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fixture({ [`${api}/git/ref/tags/v0.4.2`]: { object: { type: 'tree', sha: commit } } }))).rejects.toThrow('标签提交')
  })
  it('reports network failure and cancellation explicitly', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fetchImpl)).rejects.toThrow('网络')
    await expect(inspectGitHubRelease(DEFAULT_RELEASE_SOURCE, fetchImpl, AbortSignal.abort())).rejects.toThrow('取消')
  })
})
