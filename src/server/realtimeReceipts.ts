import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HttpError } from './errors.js'

export interface CommandReceipt {
  requestId: string
  state: 'pending' | 'confirmed' | 'rejected' | 'unknown'
  response?: Record<string, unknown>
}

interface ReceiptCommand { method?: unknown; params?: Record<string, unknown> }

/** Write-ahead admission, not an event/transcript store. Never stores command bodies. */
export class RealtimeReceipts {
  private db: DatabaseSync
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, 'realtime-receipts.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS receipts (
        owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, response TEXT, updated INTEGER NOT NULL,
        PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS receipt_retention ON receipts(state,updated);
      CREATE TABLE IF NOT EXISTS receipt_tombstones (
        owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(owner,id));
      UPDATE receipts SET state='unknown' WHERE state='pending';`)
  }
  lookup(owner: string, id: string): CommandReceipt | undefined {
    const row = this.db.prepare('SELECT state,response FROM receipts WHERE owner=? AND id=?').get(owner, id)
    if (!row) return this.db.prepare('SELECT 1 FROM receipt_tombstones WHERE owner=? AND id=?').get(owner, id)
      ? { requestId: id, state: 'unknown' } : undefined
    return { requestId: id, state: row.state as CommandReceipt['state'],
      ...(row.response ? { response: JSON.parse(String(row.response)) as Record<string, unknown> } : {}) }
  }
  reserve(owner: string, id: string, frame: string): CommandReceipt | undefined {
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(id)) throw new HttpError(400, 'Invalid request ID', 'invalid_request_id')
    const fingerprint = createHash('sha256').update(frame).digest('hex')
    const row = this.db.prepare(`SELECT fingerprint FROM receipts WHERE owner=? AND id=?
      UNION ALL SELECT fingerprint FROM receipt_tombstones WHERE owner=? AND id=?`).get(owner, id, owner, id)
    if (row) {
      if (row.fingerprint !== fingerprint) throw new HttpError(409, 'Request ID payload conflict', 'idempotency_conflict')
      return this.lookup(owner, id)
    }
    // Retire results, never admission identities. Old clients may retry years later.
    // A compact fingerprint tombstone prevents those retries from executing again.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const cutoff = Date.now() - 86_400_000
      this.db.prepare(`INSERT OR IGNORE INTO receipt_tombstones
        SELECT owner,id,fingerprint FROM receipts WHERE updated<? AND state IN ('confirmed','rejected')`).run(cutoff)
      this.db.prepare("DELETE FROM receipts WHERE updated<? AND state IN ('confirmed','rejected')").run(cutoff)
      if (Number(this.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n) >= 100_000) {
        throw new HttpError(429, 'Command receipt capacity reached', 'receipt_capacity')
      }
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,NULL,?)').run(owner, id, fingerprint, 'pending', Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return undefined
  }
  finish(owner: string, id: string, state: CommandReceipt['state'], response?: Record<string, unknown>, command?: ReceiptCommand): void {
    // Persist bounded recovery metadata, never command bodies, attachment bytes or history.
    const result = response?.result as Record<string, unknown> | undefined
    const safe: Record<string, unknown> = {}
    for (const key of ['status', 'session_id', 'stored_session_id', 'session_key', 'queued', 'running', 'ok']) {
      if (result && ['string', 'number', 'boolean'].includes(typeof result[key])) safe[key] = result[key]
    }
    const strings = command?.method === 'config.set' && ['model', 'reasoning', 'fast'].includes(String(command.params?.key))
      ? ['value', 'confirm_message', 'warning']
      : ['file.attach', 'image.attach_bytes', 'pdf.attach'].includes(String(command?.method))
        ? ['path', 'image_path', 'ref_path', 'ref_text'] : []
    for (const key of strings) {
      if (typeof result?.[key] === 'string' && result[key].length <= 4096) safe[key] = result[key]
    }
    if (command?.method === 'config.set') for (const key of ['deferred', 'confirm_required']) {
      if (typeof result?.[key] === 'boolean') safe[key] = result[key]
    }
    const saved = response?.error ? { error: { message: 'Upstream rejected command' } }
      : response ? { result: safe } : undefined
    this.db.prepare('UPDATE receipts SET state=?,response=?,updated=? WHERE owner=? AND id=?')
      .run(state, saved ? JSON.stringify(saved) : null, Date.now(), owner, id)
  }
  close(): void { this.db.close() }
}
