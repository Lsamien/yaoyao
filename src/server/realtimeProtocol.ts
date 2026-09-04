import type { RawData } from 'ws'
import { HttpError } from './errors.js'

export const CHAT_MAX_PAYLOAD = 36 * 1_024 * 1_024
const CHAT_METHODS = new Set([
  'approval.respond',
  'clarify.respond',
  'config.set',
  'file.attach',
  'image.attach_bytes',
  'pdf.attach',
  'profiles.configure',
  'profiles.get_asset',
  'profiles.list',
  'profiles.set_asset',
  'prompt.submit',
  'session.branch',
  'session.close',
  'session.context_breakdown',
  'session.create',
  'session.interrupt',
  'session.resume',
  'session.steer',
  'session.usage',
])
const SESSION_ID_REQUIRED_METHODS = new Set([
  'config.set',
  'file.attach',
  'image.attach_bytes',
  'pdf.attach',
  'prompt.submit',
  'session.branch',
  'session.close',
  'session.context_breakdown',
  'session.interrupt',
  'session.resume',
  'session.steer',
  'session.usage',
])

function safeString(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`)
  const normalized = value.trim()
  if ((!normalized && required) || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, `${label} is invalid`)
  }
  return normalized
}

function normalizedCreateSource(value: unknown, fallback = 'web'): 'web' | 'ios' {
  const source = safeString(value, 'source') ?? fallback
  if (source !== 'web' && source !== 'ios') {
    throw new HttpError(400, 'source must be web or ios', 'invalid_source')
  }
  return source
}

function normalizedConfigParams(params: Record<string, unknown>): Record<string, unknown> {
  const sessionID = safeString(params.session_id, 'session_id', true)!
  const key = safeString(params.key, 'config key', true)
  if (key === 'model') {
    const value = typeof params.value === 'string' ? params.value.trim() : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511} --provider [A-Za-z0-9][A-Za-z0-9._:-]{0,127}( --session)?$/.test(value)) {
      throw new HttpError(400, 'Model selection is invalid')
    }
    return {
      session_id: sessionID,
      key,
      value,
      ...(params.confirm_expensive_model === true ? { confirm_expensive_model: true } : {}),
    }
  }
  if (key === 'reasoning') {
    const value = safeString(params.value, 'reasoning value', true)!
    if (!new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).has(value)) {
      throw new HttpError(400, 'Reasoning value is invalid')
    }
    return { session_id: sessionID, key, value, scope: 'session' }
  }
  if (key === 'fast') {
    const value = safeString(params.value, 'fast value', true)!
    if (value !== 'fast' && value !== 'normal') throw new HttpError(400, 'Fast value is invalid')
    return { session_id: sessionID, key, value, scope: 'session' }
  }
  throw new HttpError(403, 'Config key is not allowed')
}

function normalizedSessionOpenParams(
  method: 'session.create' | 'session.resume',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const profile = safeString(params.profile, 'profile', true)!
  const columns = typeof params.cols === 'number' && Number.isInteger(params.cols)
    ? Math.min(500, Math.max(20, params.cols))
    : 80
  if (method === 'session.resume') {
    return {
      session_id: safeString(params.session_id, 'session_id', true)!,
      profile,
      close_on_disconnect: false,
      omit_messages: params.omit_messages === true,
      cols: columns,
    }
  }
  const source = normalizedCreateSource(params.source)
  const title = safeString(params.title, 'title')
  const reasoning = safeString(params.reasoning_effort, 'reasoning effort')
  const allowedReasoning = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  if (reasoning && !allowedReasoning.has(reasoning)) throw new HttpError(400, 'Reasoning effort is invalid')
  return {
    profile,
    source,
    close_on_disconnect: false,
    cols: columns,
    ...(title ? { title } : {}),
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(typeof params.fast === 'boolean' ? { fast: params.fast } : {}),
  }
}

function normalizedPairedSessionOpenParams(
  method: 'session.create' | 'session.resume',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const profile = safeString(params.profile, 'profile', true)!
  const columns = typeof params.cols === 'number' && Number.isInteger(params.cols)
    ? Math.min(500, Math.max(20, params.cols))
    : 80
  if (method === 'session.resume') {
    return {
      session_id: safeString(params.session_id, 'session_id', true)!,
      profile,
      close_on_disconnect: false,
      omit_messages: params.omit_messages === true,
      cols: columns,
    }
  }
  const source = safeString(params.source, 'source') ?? 'mobile'
  const title = safeString(params.title, 'title')
  const cwd = typeof params.cwd === 'string' && params.cwd.length <= 4_096 ? params.cwd : ''
  const reasoning = safeString(params.reasoning_effort, 'reasoning effort')
  const allowedReasoning = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  if (reasoning && !allowedReasoning.has(reasoning)) throw new HttpError(400, 'Reasoning effort is invalid')
  const model = safeString(params.model, 'model')
  const provider = safeString(params.provider, 'provider')
  if ((model === undefined) !== (provider === undefined)) {
    throw new HttpError(400, 'Model and provider must be set together')
  }
  const messages = params.messages
  if (messages !== undefined && (!Array.isArray(messages) || messages.length > 256)) {
    throw new HttpError(400, 'Seed messages are invalid')
  }
  return {
    profile,
    source,
    close_on_disconnect: false,
    cols: columns,
    cwd,
    hidden: params.hidden === true,
    ...(title ? { title } : {}),
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(model && provider ? { model, provider } : {}),
    ...(typeof params.fast === 'boolean' ? { fast: params.fast } : {}),
    ...(messages !== undefined ? { messages } : {}),
  }
}

export function checkedChatFrame(data: RawData, isBinary: boolean, paired = false): string {
  if (isBinary) throw new HttpError(400, 'Binary chat frames are not accepted')
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  if (bytes.byteLength > CHAT_MAX_PAYLOAD) throw new HttpError(413, 'Chat frame is too large')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Chat frame must be JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Chat frame must be a JSON-RPC object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.method !== 'string' || !CHAT_METHODS.has(request.method)) {
    throw new HttpError(403, 'Chat RPC method is not allowed')
  }
  if (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number') {
    throw new HttpError(400, 'Chat RPC id is invalid')
  }
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new HttpError(400, 'Chat RPC params must be an object')
  }
  let params = { ...(request.params as Record<string, unknown>) }
  safeString(params.session_id, 'session_id', SESSION_ID_REQUIRED_METHODS.has(request.method))
  const profileRequired = request.method === 'session.create' || request.method === 'session.resume'
  safeString(params.profile, 'profile', profileRequired)
  if (request.method === 'session.create' || request.method === 'session.resume') {
    params = paired
      ? normalizedPairedSessionOpenParams(request.method, params)
      : normalizedSessionOpenParams(request.method, params)
  }
  if (request.method === 'profiles.list') {
    const preferred = params.preferred_session_ids
    if (preferred !== undefined && (!preferred || typeof preferred !== 'object' || Array.isArray(preferred))) {
      throw new HttpError(400, 'preferred_session_ids must be an object')
    }
    params = {
      ...(typeof params.include_sessions === 'boolean' ? { include_sessions: params.include_sessions } : {}),
      ...(preferred !== undefined ? { preferred_session_ids: preferred } : {}),
    }
  }
  if (request.method === 'profiles.get_asset') {
    params = {
      name: safeString(params.name, 'profile name', true)!,
      asset: safeString(params.asset, 'profile asset', true)!,
    }
  }
  if (request.method === 'profiles.set_asset') {
    const clear = params.clear === true
    const data = typeof params.data === 'string' ? params.data.trim() : ''
    if (!clear && !data) throw new HttpError(400, 'profile asset data is required')
    if (data.length > 2_800_000) throw new HttpError(413, 'profile asset exceeds 2 MiB')
    params = {
      name: safeString(params.name, 'profile name', true)!,
      asset: safeString(params.asset, 'profile asset', true)!,
      ...(clear ? { clear: true } : { data }),
    }
  }
  if (request.method === 'profiles.configure') {
    if (!params.ui_meta || typeof params.ui_meta !== 'object' || Array.isArray(params.ui_meta)) {
      throw new HttpError(400, 'ui_meta must be an object')
    }
    if (params.ui_meta_expected_revisions !== undefined
      && (!params.ui_meta_expected_revisions
        || typeof params.ui_meta_expected_revisions !== 'object'
        || Array.isArray(params.ui_meta_expected_revisions))) {
      throw new HttpError(400, 'ui_meta_expected_revisions must be an object')
    }
    params = {
      name: safeString(params.name, 'profile name', true)!,
      ui_meta: params.ui_meta,
      ...(params.ui_meta_expected_revisions !== undefined
        ? { ui_meta_expected_revisions: params.ui_meta_expected_revisions }
        : {}),
    }
  }
  if (request.method === 'config.set') params = normalizedConfigParams(params)
  if (request.method === 'prompt.submit' || request.method === 'session.steer') {
    const text = typeof params.text === 'string' ? params.text.trim() : ''
    if (!text || text.length > 200_000) throw new HttpError(400, 'Prompt text is invalid')
    params = {
      session_id: safeString(params.session_id, 'session_id', true)!,
      text,
      ...(request.method === 'prompt.submit' && params.queued === true ? { queued: true } : {}),
    }
  }

  if (request.method === 'image.attach_bytes' || request.method === 'pdf.attach') {
    const encoded = typeof params.content_base64 === 'string' ? params.content_base64 : ''
    const estimated = Math.floor(encoded.length * 0.75)
    if (!encoded || estimated > 25 * 1_024 * 1_024) {
      throw new HttpError(413, 'Attachment exceeds 25 MiB')
    }
  }
  if (request.method === 'file.attach') {
    const dataURL = typeof params.data_url === 'string' ? params.data_url : ''
    const marker = dataURL.indexOf(',')
    if (marker < 0 || Math.floor((dataURL.length - marker - 1) * 0.75) > 25 * 1_024 * 1_024) {
      throw new HttpError(413, 'Attachment exceeds 25 MiB')
    }
  }
  return JSON.stringify({ ...request, params })
}

export class GroupFrameValidator {
  #ready = false
  #cursor: number

  constructor(readonly epoch: string, cursor: number) {
    this.#cursor = cursor
  }

  accept(data: RawData, isBinary: boolean): boolean {
    if (isBinary) throw new HttpError(400, 'Binary group frames are not accepted')
    let envelope: Record<string, unknown>
    try {
      const value = JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
      envelope = value as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'Malformed group event frame')
    }
    const type = envelope.type
    const cursor = Number(envelope.cursor)
    if (type === 'group.ready') {
      const heartbeat = Number(envelope.heartbeatSeconds)
      if (this.#ready || envelope.epoch !== this.epoch || !Number.isSafeInteger(cursor)
        || cursor !== this.#cursor || !Number.isFinite(heartbeat) || heartbeat <= 0) {
        throw new HttpError(409, 'Invalid group.ready frame')
      }
      this.#ready = true
      return true
    }
    if (type === 'group.reset_required') {
      if (typeof envelope.epoch !== 'string' || !Number.isSafeInteger(cursor)
        || typeof envelope.reason !== 'string') {
        throw new HttpError(400, 'Invalid group.reset_required frame')
      }
      return true
    }
    if (!this.#ready) throw new HttpError(409, 'Group event arrived before group.ready')
    if (type === 'group.event') {
      if (envelope.epoch !== this.epoch || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new HttpError(409, 'Group event epoch or cursor is invalid')
      }
      if (cursor <= this.#cursor) return false
      if (cursor !== this.#cursor + 1) throw new HttpError(409, 'Group event cursor gap')
      this.#cursor = cursor
      return true
    }
    if (type === 'group.heartbeat') {
      if ((envelope.epoch !== undefined && envelope.epoch !== this.epoch)
        || !Number.isSafeInteger(cursor) || cursor !== this.#cursor) {
        throw new HttpError(409, 'Group heartbeat cursor mismatch')
      }
      return true
    }
    throw new HttpError(400, 'Unknown group event frame')
  }

  resetFrame(reason: string): string {
    return JSON.stringify({
      type: 'group.reset_required',
      epoch: this.epoch,
      cursor: this.#cursor,
      reason,
    })
  }
}

export function canonicalEpoch(value: unknown): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new HttpError(400, 'epoch must be a canonical lowercase UUID', 'invalid_epoch')
  }
  return value
}

export function groupCursor(value: unknown): number {
  const cursor = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, 'cursor must be a non-negative integer', 'invalid_cursor')
  }
  return cursor
}
