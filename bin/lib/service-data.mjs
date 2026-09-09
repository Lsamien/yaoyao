import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// These are process/desktop state, not Web application data. Runner databases
// have their own owner and must never be restored by a Web update.
const excluded = name => ['updates', 'desktop', 'runner-state'].includes(name) || name.startsWith('service-instance')
export function databaseSchema(home) {
  const result = {}
  for (const name of readdirSync(home).sort()) {
    if (excluded(name) || !/\.(?:sqlite3?|db)$/.test(name) || lstatSync(join(home, name)).isSymbolicLink()) continue
    const db = new DatabaseSync(join(home, name), { readOnly: true })
    try {
      result[name] = { schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), version: db.prepare('PRAGMA user_version').get() }
    } finally { db.close() }
  }
  return createHash('sha256').update(JSON.stringify(result)).digest('hex')
}
export function assertRollbackCompatible(home, record) {
  if (!record.beforeSchema || record.beforeSchema !== record.afterSchema || databaseSchema(home) !== record.afterSchema)
    throw new Error('数据库结构已变化或缺少兼容性记录，不能直接降级；请使用独立的数据恢复流程')
}
export function backupData(home, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const names = readdirSync(home).filter(name => !excluded(name))
  for (const name of names) cpSync(join(home, name), join(directory, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
  const schema = databaseSchema(home)
  writeFileSync(join(directory, '.snapshot.json'), JSON.stringify({ names, schema }), { mode: 0o600 })
  return schema
}
export function restoreData(home, directory) {
  const { names } = JSON.parse(readFileSync(join(directory, '.snapshot.json'), 'utf8'))
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || name.includes('/') || name === '..' || excluded(name))) throw new Error('数据备份清单无效')
  for (const name of readdirSync(home)) if (!excluded(name)) rmSync(join(home, name), { recursive: true, force: true })
  for (const name of names) cpSync(join(directory, name), join(home, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
}
/** Conservative admission for pre-maintenance releases. No cache means an
 * existing ordinary-chat workload cannot be proven idle. */
export function legacyDataIdle(home) {
  const workspace = join(home, 'workspace.sqlite3')
  if (existsSync(workspace)) {
    const db = new DatabaseSync(workspace, { readOnly: true })
    try {
      if (db.prepare("SELECT 1 FROM workspace_entities WHERE kind IN ('run','turn') AND COALESCE(json_extract(data,'$.status'),'unknown') NOT IN ('complete','failed','interrupted') LIMIT 1").get()) return false
    } finally { db.close() }
  }
  const cache = join(home, 'chat-cache.sqlite3')
  if (!existsSync(cache)) return !existsSync(workspace)
  const db = new DatabaseSync(cache, { readOnly: true })
  try {
    // Compare event sequence within each session, never across sessions.
    return !db.prepare(`SELECT 1 FROM chat_events e WHERE e.event_type IN ('message.start','message.delta','approval.request','clarify.request','command:prompt.submit','command:session.steer')
      AND NOT EXISTS(SELECT 1 FROM chat_events done WHERE done.owner=e.owner AND done.profile=e.profile AND done.session_id=e.session_id
        AND done.event_type='message.complete' AND done.received_at>=e.received_at) LIMIT 1`).get()
  } finally { db.close() }
}
