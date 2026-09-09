export const DEFAULT_RELEASE_SOURCE = 'https://github.com/Lsamien/hermes-yaoyao.git'

/** Only the former official repository is migrated; private forks stay private. */
export function normalizeReleaseSource(value) {
  const source = value?.trim()
  if (!source) return DEFAULT_RELEASE_SOURCE
  if (/^git@git\.samien\.cn:samien\/hermes-yaoyao(?:\.git)?\/?$/.test(source)) return DEFAULT_RELEASE_SOURCE
  try {
    const url = new URL(source)
    const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '')
    if (!url.username && !url.password && !url.search && !url.hash
      && ['https:', 'http:', 'ssh:'].includes(url.protocol)
      && ['git.samien.cn', '192.168.153.8:3000'].includes(url.host)
      && path === '/samien/hermes-yaoyao') return DEFAULT_RELEASE_SOURCE
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+$/.test(path)) {
      const normalized = `https://github.com${path}.git`
      return normalized.toLowerCase() === DEFAULT_RELEASE_SOURCE.toLowerCase() ? DEFAULT_RELEASE_SOURCE : normalized
    }
  } catch { /* Custom SSH sources retain their existing Git transport. */ }
  return source
}
