import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from '../errors.js'
import type { HermesScope } from './service.js'

/** Per-session model selection made through `config.set` (native chat model picker, Bot settings). */
export interface SessionModel { provider?: string; model?: string; reasoningEffort?: string; fastMode?: 'normal' | 'fast' }

/**
 * One embedded conversation. Hermes owns the transcript in the home's `state.db`; this record holds
 * what the dashboard gateway used to keep in memory: which home serves the session and its
 * per-session settings.
 */
export interface EmbeddedSession {
  id: string
  profile: string
  /** Workspace Bot whose runtime home stores this session; absent for native chats. */
  botId?: string
  title?: string
  source?: string
  hidden?: boolean
  cwd?: string
  model?: SessionModel
  createdAt: number
  updatedAt: number
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export class EmbeddedSessions {
  private readonly path: string
  private readonly sessions = new Map<string, EmbeddedSession>()

  constructor(hermesHome: string) {
    this.path = join(hermesHome, 'yaoyao-sessions.json')
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { sessions?: EmbeddedSession[] }
      for (const session of parsed.sessions ?? []) if (SESSION_ID.test(session.id)) this.sessions.set(session.id, session)
    }
  }

  get(id: string): EmbeddedSession | undefined { return SESSION_ID.test(id) ? this.sessions.get(id) : undefined }

  require(id: string): EmbeddedSession {
    const session = this.get(id)
    if (!session) throw new HttpError(404, '会话不存在', 'session_not_found')
    return session
  }

  list(): EmbeddedSession[] { return [...this.sessions.values()] }

  put(session: EmbeddedSession): EmbeddedSession {
    if (!SESSION_ID.test(session.id)) throw new HttpError(400, '会话标识无效', 'invalid_session')
    this.sessions.set(session.id, { ...session, updatedAt: Date.now() })
    this.save()
    return this.sessions.get(session.id)!
  }

  update(id: string, patch: Partial<Omit<EmbeddedSession, 'id' | 'createdAt'>>): EmbeddedSession {
    return this.put({ ...this.require(id), ...patch })
  }

  delete(id: string): void { if (this.sessions.delete(id)) this.save() }

  /** Hermes home serving a session id; unknown ids belong to the profile they are addressed under. */
  scope(id: string | undefined, profile = 'default'): HermesScope {
    const session = id ? this.get(id) : undefined
    if (session?.botId) return { botId: session.botId, profile: session.profile }
    const name = session?.profile ?? profile
    return name === 'default' ? 'system' : { profile: name }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] }), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
