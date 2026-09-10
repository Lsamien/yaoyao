import type { ChatMessage, JsonValue, SessionSummary } from '@shared/types'
import { apiRequest, apiUrl, unwrapData } from './client'
import { normalizeChatMessage, normalizeSession, number, record, values } from '@/utils/normalize'

const EXCLUDED_SOURCES = 'cron,ios_group,yaoyao_workspace'

export interface SessionPage {
  items: SessionSummary[]
  nextCursor?: string | null
  total?: number
}

export interface MessagePage {
  session?: SessionSummary
  messages: ChatMessage[]
  total: number
  returned: number
  hasMore: boolean
  offset: number
  limit: number
}

export async function getSessions(profile?: string, cursor?: string, limit = 100, view: 'chat' | 'history' = 'chat'): Promise<SessionPage> {
  const offset = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const payload = unwrapData(await apiRequest<unknown>(apiUrl('/api/app/sessions', {
    profile,
    offset,
    limit: Math.max(1, Math.min(200, limit)),
    order: 'recent',
    archived: 'exclude',
    exclude: EXCLUDED_SOURCES,
    view,
  })))
  const source = record(payload)
  const rawItems = values(source.items ?? source.sessions ?? payload)
  const items = rawItems.map(item => normalizeSession(item, profile)).filter(session => session.id)
    .filter(session => !['cron', 'ios_group', 'yaoyao_workspace'].includes(session.source))
  const total = number(source.total)
  const nextOffset = offset + items.length
  return {
    items,
    nextCursor: typeof source.nextCursor === 'string'
      ? source.nextCursor
      : typeof source.next_cursor === 'string'
        ? source.next_cursor
        : total > nextOffset && items.length ? String(nextOffset) : null,
    total: total || undefined,
  }
}

export async function searchSessions(query: string, profile?: string, limit = 100): Promise<SessionSummary[]> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl('/api/app/sessions/search', {
    q: query,
    profile,
    limit: Math.max(1, Math.min(200, limit)),
    exclude: EXCLUDED_SOURCES,
  })))
  const source = record(payload)
  return values(source.items ?? source.sessions ?? source.results ?? payload).map(item => normalizeSession(item, profile))
    .filter(session => session.id && !['cron', 'ios_group', 'yaoyao_workspace'].includes(session.source))
}

export async function getSession(id: string, profile?: string): Promise<SessionSummary> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl(`/api/app/sessions/${encodeURIComponent(id)}`, { profile })))
  const source = record(payload)
  return normalizeSession(source.session ?? payload, profile)
}

export async function getMessages(
  sessionId: string,
  offset: number,
  limit = 150,
  profile?: string,
  forceRefresh = false,
  view: 'chat' | 'history' = 'chat',
): Promise<MessagePage> {
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  const url = apiUrl(`/api/app/sessions/${encodeURIComponent(sessionId)}/messages`, {
    offset: safeOffset,
    limit: safeLimit,
    order: 'latest',
    include_compacted: true,
    profile,
    ...(view === 'history' ? {view} : {}),
  })
  const payload = unwrapData(await apiRequest<unknown>(url, forceRefresh ? { headers: { 'X-Yaoyao-Cache': 'bypass' } } : {}))
  const source = record(payload)
  const pagination = record(source.pagination)
  const messages = values(source.messages ?? source.items ?? payload).map(message => normalizeChatMessage(message, sessionId, profile))
  const returned = Math.max(number(pagination.returned), messages.length)
  const total = Math.max(number(pagination.total ?? source.total), safeOffset + returned)
  const hasMore = typeof pagination.hasMore === 'boolean'
    ? pagination.hasMore
    : typeof pagination.has_more === 'boolean'
      ? pagination.has_more
      : safeOffset + returned < total || returned >= safeLimit
  return {
    session: source.session ? normalizeSession(source.session, profile) : undefined,
    messages,
    total,
    returned,
    hasMore,
    offset: safeOffset,
    limit: safeLimit,
  }
}

export async function createSession(profile: string, title?: string): Promise<SessionSummary> {
  const payload = unwrapData(await apiRequest<unknown>('/api/app/sessions', {
    method: 'POST',
    body: { profile, title: title || null, source: 'web' } as JsonValue,
  }))
  const source = record(payload)
  return normalizeSession(source.session ?? payload, profile)
}

export async function updateSession(
  id: string,
  patch: { title?: string; archived?: boolean; pinned?: boolean },
  profile?: string,
): Promise<SessionSummary> {
  await apiRequest<unknown>(apiUrl(`/api/app/sessions/${encodeURIComponent(id)}`, { profile }), {
    method: 'PATCH', body: patch as JsonValue,
  })
  return getSession(id, profile)
}

export async function deleteSession(id: string, profile?: string): Promise<void> {
  await apiRequest(apiUrl(`/api/app/sessions/${encodeURIComponent(id)}`, { profile }), { method: 'DELETE' })
}

export async function requestHistorySync(sessionId:string,profile?:string):Promise<void>{
  await apiRequest(apiUrl(`/api/app/sessions/${encodeURIComponent(sessionId)}/sync`,{profile}),{method:'POST',body:{}})
}

export async function getSessionUnread(profile?: string): Promise<Record<string, number>> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl('/api/app/sessions/unread', { profile })))
  const source = record(payload)
  const sessionRows = values(source.sessions ?? source.items)
  if (sessionRows.length) {
    const result: Record<string, number> = {}
    for (const value of sessionRows) {
      const item = record(value)
      const id = typeof item.sessionId === 'string'
        ? item.sessionId
        : typeof item.session_id === 'string' ? item.session_id : ''
      if (id) result[id] = Math.max(0, number(item.unreadCount ?? item.unread_count ?? item.count))
    }
    return result
  }
  const raw = record(source.items ?? source.unread ?? source.counts ?? payload)
  const result: Record<string, number> = {}
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof value === 'number' || typeof value === 'string') result[sessionId] = Math.max(0, number(value))
    else {
      const item = record(value)
      const id = typeof item.sessionId === 'string' ? item.sessionId : typeof item.session_id === 'string' ? item.session_id : sessionId
      result[id] = Math.max(0, number(item.unreadCount ?? item.unread_count ?? item.count))
    }
  }
  return result
}

export async function markSessionRead(sessionId: string, readMessageCount: number, profile?: string): Promise<void> {
  await apiRequest(apiUrl(`/api/app/sessions/unread/${encodeURIComponent(sessionId)}`, { profile }), {
    method: 'PATCH', body: { readMessageCount: Math.max(0, Math.trunc(readMessageCount)) },
  })
}
