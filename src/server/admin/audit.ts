import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface AuditEntry {
  id: number
  at: number
  actor: string
  ip: string
  module: string
  action: string
  target: string
  outcome: 'ok' | 'denied' | 'failed'
  status: number
  detail: string
}

export type AuditInput = Omit<AuditEntry, 'id' | 'at'> & { at?: number }

export interface AuditQuery { module?: string; actor?: string; outcome?: string; since?: number; until?: number; before?: number; limit?: number }

/** Admin console audit log: every login attempt and every write. Secret values are never recorded. */
export class AdminAudit {
  readonly #db: DatabaseSync
  constructor(home: string, readonly retentionDays = 180) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.#db = new DatabaseSync(join(home, 'admin-audit.sqlite'))
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, ip TEXT NOT NULL,
        module TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL,
        status INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);`)
    this.prune()
  }

  record(entry: AuditInput): void {
    this.#db.prepare('INSERT INTO audit(at,actor,ip,module,action,target,outcome,status,detail) VALUES(?,?,?,?,?,?,?,?,?)').run(
      entry.at ?? Date.now(), entry.actor.slice(0, 200), entry.ip.slice(0, 64), entry.module.slice(0, 40), entry.action.slice(0, 200),
      entry.target.slice(0, 300), entry.outcome, entry.status, entry.detail.slice(0, 1000))
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [], args: Array<string | number> = []
    if (query.module) { where.push('module = ?'); args.push(query.module) }
    if (query.actor) { where.push('actor = ?'); args.push(query.actor) }
    if (query.outcome) { where.push('outcome = ?'); args.push(query.outcome) }
    if (query.since) { where.push('at >= ?'); args.push(query.since) }
    if (query.until) { where.push('at <= ?'); args.push(query.until) }
    if (query.before) { where.push('id < ?'); args.push(query.before) }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 5000)
    const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`
    return this.#db.prepare(sql).all(...args) as unknown as AuditEntry[]
  }

  modules(): string[] {
    return (this.#db.prepare('SELECT DISTINCT module FROM audit ORDER BY module').all() as Array<{ module: string }>).map(row => row.module)
  }

  prune(now = Date.now()): void {
    this.#db.prepare('DELETE FROM audit WHERE at < ?').run(now - this.retentionDays * 86_400_000)
  }

  close(): void { if (this.#db.isOpen) this.#db.close() }
}

/** Fields whose values are secrets. `value` carries a key's content when an environment variable is set. */
const SECRET_FIELD = /^(?:value|.*(?:pass(?:word)?|secret|token|api_?key|credential|private_?key|p8|json|cert(?:ificate)?).*)$/i

/** A short, secret-free summary of a JSON body for the audit log: field names, and values only for non-secret scalars. */
export function auditDetail(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'requestId' || key === 'profile' && value === 'default') continue
    if (SECRET_FIELD.test(key)) { parts.push(`${key}=已修改`); continue }
    if (typeof value === 'string') parts.push(`${key}=${value.length > 80 ? value.slice(0, 80) + '…' : value}`)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) parts.push(`${key}=${String(value)}`)
    else parts.push(key)
  }
  return parts.join(', ')
}

export function auditCsv(rows: AuditEntry[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    // Neutralise spreadsheet formulas and quote every cell.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const header = ['时间', '账号', '来源', '模块', '动作', '目标', '结果', '状态码', '摘要']
  const lines = rows.map(row => [new Date(row.at).toISOString(), row.actor, row.ip, row.module, row.action, row.target, row.outcome, row.status, row.detail].map(cell).join(','))
  return '﻿' + [header.map(cell).join(','), ...lines].join('\r\n') + '\r\n'
}
