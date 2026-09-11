import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serverFilePath } from '../shared/serverFiles.js'
import type { ServerConfig } from './config.js'
import type { UpstreamServiceSession } from './localAuth.js'
import { HttpError } from './errors.js'
import { configuredWorkingDirectory } from './sessionWorkingDirectory.js'
type FileHost = Pick<UpstreamServiceSession, 'request'>

export interface FileAccessSettings { mode: 'all' | 'folders'; folders: string[] }
const settingsPath = (home: string) => join(home, 'file-access.json')

export function parseFileAccess(value: unknown): FileAccessSettings {
  const input = value as Partial<FileAccessSettings> | null
  if (!input || !['all', 'folders'].includes(String(input.mode)) || !Array.isArray(input.folders) || input.folders.length > 100)
    throw new HttpError(400, '请选择全部目录或指定目录，目录最多 100 个', 'invalid_file_access')
  const folders = input.folders.map(folder => {
    const path = typeof folder === 'string' && folder.length <= 8192 ? serverFilePath(folder, false) : undefined
    if (!path) throw new HttpError(400, '目录必须使用服务器上的绝对路径，不能包含 ..', 'invalid_file_access_folder')
    return posix.normalize(path)
  })
  return { mode: input.mode!, folders: [...new Set(folders)] }
}

export function readFileAccess(home: string): FileAccessSettings {
  if (!existsSync(settingsPath(home))) return { mode: 'folders', folders: [] }
  try { return parseFileAccess(JSON.parse(readFileSync(settingsPath(home), 'utf8'))) }
  catch { throw new HttpError(503, '文件访问设置无法读取，请由管理员重新保存', 'file_access_configuration_error') }
}

export function saveFileAccess(home: string, value: unknown): FileAccessSettings {
  const settings = parseFileAccess(value)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const temporary = settingsPath(home) + '.' + randomUUID()
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, settingsPath(home))
  return settings
}

export async function fileAccessWorkingDirectory(upstream: FileHost, profile: string): Promise<string> {
  const configured = await configuredWorkingDirectory((path, options) => upstream.request(path, options), profile)
  const absolute = configured ? serverFilePath(configured, false) : undefined
  if (absolute) return absolute
  // Let Hermes expand its own home/relative directory; never use the Web process cwd.
  const response = await upstream.request('/api/fs/default-cwd', { search: new URLSearchParams({ profile }), cache: 'reload' })
  let path: string | undefined
  try { path = serverFilePath(JSON.parse(response.body.toString()).cwd ?? '', false) } catch { /* Refuse an unresolved cwd. */ }
  if (response.status !== 200 || !path) throw new HttpError(503, '无法解析服务端 terminal.cwd，请在服务器配置有效工作目录', 'file_cwd_unavailable')
  return path
}

export async function authorizeFileRead(config: ServerConfig, upstream: FileHost, raw: string, profile = 'default', directoryRequest = false): Promise<string> {
  const path = serverFilePath(raw, false)
  if (!path) throw new HttpError(400, '文件路径无效', 'invalid_file_path')
  const policy = readFileAccess(config.home)
  if (policy.mode === 'all') return path // Upstream authentication and filesystem restrictions still apply.
  const cwd = await fileAccessWorkingDirectory(upstream, profile)
  const allowed = [cwd, ...policy.folders]
  const contains = (file: string, roots: string[]) => roots.some(root => file === root || file.startsWith(root.replace(/\/$/, '') + '/'))
  // Even a loopback gateway can be in a container. Canonical paths must come
  // from Hermes, never from the Web process's filesystem or working directory.
  const directories = new Map<string, Promise<{path: string; entries: Array<{name: string; path: string}>}>>()
  const directory = (folder: string) => {
    if (!directories.has(folder)) directories.set(folder, (async () => {
      const response = await upstream.request('/api/files', { search: new URLSearchParams({ path: folder, profile }), cache: 'reload' })
      if (response.status !== 200) throw new HttpError(response.status === 404 ? 404 : 403, '无法核对服务器文件目录，请检查目录权限或文件是否存在', 'remote_file_directory_unverified')
      try {
        const value = JSON.parse(response.body.toString())
        if (typeof value.path !== 'string' || !Array.isArray(value.entries)) throw new Error()
        return value
      } catch { throw new HttpError(502, '服务器文件目录响应无效', 'remote_file_directory_unverified') }
    })())
    return directories.get(folder)!
  }
  const roots = (await Promise.all(allowed.map(async root => {
    try { return serverFilePath((await directory(root)).path, false) } catch { return undefined }
  }))).filter((value): value is string => Boolean(value))
  if (!contains(path, [...allowed, ...roots])) throw new HttpError(403, '文件不在工作目录或额外授权目录内，请检查服务端「设置 → 文件访问」', 'file_directory_not_allowed')
  const parent = directoryRequest ? undefined : await directory(dirname(path))
  const selected = parent?.entries.find(entry => entry.name === basename(path))
  if (!directoryRequest && !selected) throw new HttpError(404, '服务器文件不存在、已被移动或不可读取', 'file_not_found')
  const canonical = serverFilePath(directoryRequest ? (await directory(path)).path : selected!.path, false)
  if (!canonical || !contains(canonical, roots)) throw new HttpError(403, '文件不在工作目录或额外授权目录内，请检查服务端「设置 → 文件访问」', 'file_directory_not_allowed')
  return canonical
}
