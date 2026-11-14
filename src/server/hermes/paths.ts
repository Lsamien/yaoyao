import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError } from '../errors.js'

/** Package root: works from src/server/hermes (tsx) and dist-server/server/hermes (build). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface KernelPaths { root: string; python: string; worker: string; service: string }

export function kernelPaths(env: NodeJS.ProcessEnv = process.env): KernelPaths {
  const root = env.YAOYAO_KERNEL_ROOT || PACKAGE_ROOT
  const bundled = join(root, 'runtime/python/bin/python3')
  return {
    root,
    python: env.YAOYAO_KERNEL_PYTHON || (existsSync(bundled) ? bundled : join(root, '.venv/bin/python')),
    worker: env.YAOYAO_KERNEL_WORKER || join(root, 'runtime/worker.py'),
    service: env.YAOYAO_HERMES_SERVICE || join(root, 'runtime/hermes_service.py'),
  }
}

export function requireKernel(paths: KernelPaths, script: string): void {
  if (!existsSync(script) || !existsSync(paths.python))
    throw new HttpError(503, '内置 Hermes 内核尚未安装，请运行 yaoyao setup（源码目录使用 npm run kernel:setup）。', 'kernel_unavailable')
}

/** Isolated process environment: no ambient Hermes profile, only proxy/TLS settings pass through. */
export function kernelEnv(home: string, source: NodeJS.ProcessEnv, systemHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, HOME: home, HERMES_HOME: home, LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', YAOVI_KERNEL: '1', HERMES_SKIP_UPDATE_CHECK: '1' }
  if (systemHome && systemHome !== home) env.YAOVI_HERMES_ROOT = systemHome
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'TMPDIR'])
    if (source[key]) env[key] = source[key]
  for (const [key, value] of Object.entries(source)) if (key.startsWith('YAOVI_HERMES_TEST_')) env[key] = value
  return env
}

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g
const ASSIGNMENT = /\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(["']?)([^\s"']{6,})\2/gi
export function scrubSecrets(text: string): string {
  return text.replace(SECRET, '«redacted»').replace(ASSIGNMENT, (_m, key: string, quote: string) => `${key}${quote}«redacted»${quote}`)
}
