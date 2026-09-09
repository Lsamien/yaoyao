import { HttpError } from './errors.js'
import type { UpstreamRequestOptions, UpstreamResponse } from './upstream.js'

type Request = (path: string, options: UpstreamRequestOptions) => Promise<UpstreamResponse>
export interface AppliedWorkingDirectory { configured: string; resolved: string }

/** Read the selected Hermes profile, never resolve a remote path on the Web host. */
export async function configuredWorkingDirectory(request: Request, profile: string): Promise<string | undefined> {
  const response = await request('/api/config', {
    search: new URLSearchParams({ profile }), cache: 'reload',
  })
  if (response.status !== 200) {
    throw new HttpError(502, '无法读取 Agent 的 terminal.cwd，未开始执行', 'working_directory_unavailable')
  }
  let config: any
  try { config = JSON.parse(response.body.toString()) } catch {
    throw new HttpError(502, 'Agent 工作目录配置响应无效', 'invalid_working_directory')
  }
  const raw = config?.terminal?.cwd
  // Older Hermes installations may not expose this setting.
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new HttpError(502, 'Agent 的 terminal.cwd 配置无效', 'invalid_working_directory')
  }
  return raw.trim()
}

/** Session-only RPC: updates tool execution and persisted cwd without changing global config. */
export async function applyWorkingDirectory(
  rpc: (method: string, params: Record<string, unknown>) => Promise<any>,
  sessionID: string,
  configured: string | undefined,
  previous?: AppliedWorkingDirectory,
  observedCwd?: string,
): Promise<AppliedWorkingDirectory | undefined> {
  if (!configured) return undefined
  if (previous?.configured === configured) return previous
  if (observedCwd === configured) return { configured, resolved: observedCwd }
  const info = await rpc('session.cwd.set', { session_id: sessionID, cwd: configured })
  if (typeof info?.cwd !== 'string' || !info.cwd.trim()) {
    throw new HttpError(502, 'Hermes 未确认会话工作目录，未开始执行', 'working_directory_unconfirmed')
  }
  return { configured, resolved: info.cwd }
}
