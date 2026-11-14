import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { kernelPaths } from './paths.js'

export type HermesImportResult =
  | { status: 'imported'; source: string; files: number; skipped: number; hermesVersion?: string | null }
  | { status: 'skipped'; reason: 'already_initialized' | 'no_source' | 'kernel_unavailable' | 'disabled' }
  | { status: 'failed'; source: string; error: string }

const MARKERS = ['config.yaml', 'state.db', 'auth.json', '.env', 'profiles']

/** The embedded home counts as empty until Hermes data or a previous import exists there. */
function initialized(home: string): boolean {
  if (!existsSync(home)) return false
  return readdirSync(home).some(name => name !== 'yaoyao-sessions.json' && name !== 'import-error.json')
}

function legacySource(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.YAOYAO_IMPORT_HERMES_HOME?.trim()
  const candidate = resolve(configured || join(homedir(), '.hermes'))
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return undefined
  return MARKERS.some(name => existsSync(join(candidate, name))) ? candidate : undefined
}

/**
 * First start only: copy an existing Hermes home into `<data>/hermes`. The source stays read-only.
 * Runs in a staging directory renamed into place on success, so a failure leaves no partial home and
 * the next start retries. A previously imported or used embedded home is never touched.
 */
export function importLegacyHermes(dataHome: string, env: NodeJS.ProcessEnv = process.env): HermesImportResult {
  const home = join(dataHome, 'hermes')
  if (env.YAOYAO_IMPORT_HERMES === '0') return { status: 'skipped', reason: 'disabled' }
  if (initialized(home)) return { status: 'skipped', reason: 'already_initialized' }
  const source = legacySource(env)
  if (!source) return { status: 'skipped', reason: 'no_source' }
  if (resolve(source) === resolve(home)) return { status: 'skipped', reason: 'already_initialized' }
  const paths = kernelPaths(env)
  const script = join(paths.root, 'runtime/hermes_import.py')
  if (!existsSync(paths.python) || !existsSync(script)) return { status: 'skipped', reason: 'kernel_unavailable' }
  const staging = join(dirname(home), `.hermes-import-${process.pid}-${Date.now()}`)
  const result = spawnSync(paths.python, ['-I', script, source, staging], { encoding: 'utf8', timeout: 30 * 60_000, env: { PATH: env.PATH, LANG: 'en_US.UTF-8' } })
  if (result.status !== 0) {
    rmSync(staging, { recursive: true, force: true })
    const error = (result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n').at(-1)?.slice(0, 500) ?? '导入失败'
    try { writeFileSync(join(dataHome, 'hermes-import-error.json'), JSON.stringify({ source, error, at: Date.now() }), { mode: 0o600 }) } catch { /* diagnostics only */ }
    return { status: 'failed', source, error }
  }
  // An empty pre-created home (only the session registry) is replaced by the imported copy.
  if (existsSync(home)) {
    const registry = join(home, 'yaoyao-sessions.json')
    if (existsSync(registry)) renameSync(registry, join(staging, 'yaoyao-sessions.json'))
    rmSync(home, { recursive: true, force: true })
  }
  renameSync(staging, home)
  rmSync(join(dataHome, 'hermes-import-error.json'), { force: true })
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}') as { files?: number; skipped?: number; hermesVersion?: string | null }
  return { status: 'imported', source, files: summary.files ?? 0, skipped: summary.skipped ?? 0, hermesVersion: summary.hermesVersion }
}
