import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDataHome, legacyDataHome, legacyUpdateActive } from './data-home.mjs'

const markerName = '.data-home-migration.json'
const read = file => JSON.parse(readFileSync(file, 'utf8'))
function write(file, value) {
  const temporary = file + '.tmp'
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}
export function rebaseDataPath(value, old, home) {
  return typeof value === 'string' && (value === old || value.startsWith(old + '/')) ? home + value.slice(old.length) : value
}
/** Only storage paths are rebased; conversation text and external paths stay intact. */
function rebaseDatabasePaths(home, old) {
  for (const [name, table, columns] of [
    ['uploads.sqlite3', 'uploads', ['path']],
    ['chat-cache.sqlite3', 'chat_attachments', ['local_path', 'source_path']],
  ]) {
    const file = join(home, name)
    if (!existsSync(file)) continue
    const db = new DatabaseSync(file)
    try {
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)) continue
      const fields = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name))
      db.exec('BEGIN IMMEDIATE')
      for (const column of columns) if (fields.has(column)) {
        db.prepare(`UPDATE "${table}" SET "${column}"=? || substr("${column}",?) WHERE "${column}"=? OR substr("${column}",1,?)=?`)
          .run(home, old.length + 1, old, old.length + 1, old + '/')
      }
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
  }
  const rebase = value => typeof value === 'string' ? rebaseDataPath(value, old, home)
    : Array.isArray(value) ? value.map(rebase)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)])) : value
  // Durable update/notification configuration stores absolute paths as well.
  for (const name of ['updates', 'push']) {
    const directory = join(home, name)
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(directory, entry.name), value = read(file), next = rebase(value)
      if (JSON.stringify(value) !== JSON.stringify(next)) write(file, next)
    }
  }
}
export function migrateDataHome(home, { userHome = homedir() } = {}) {
  home = resolve(home)
  const old = legacyDataHome(userHome)
  if (home !== defaultDataHome(userHome)) return false
  const marker = join(home, markerName)
  if (!existsSync(old)) {
    if (existsSync(marker) && read(marker).phase === 'moving') {
      const record = read(marker)
      if (record.source !== old || record.target !== home) throw new Error('数据目录迁移记录不匹配')
      rebaseDatabasePaths(home, old)
      write(marker, { ...record, phase: 'complete' })
    }
    if (process.platform === 'linux' && home === '/home/node/.yaoyao' && existsSync(home)) {
      const lock = new DatabaseSync(join(home, 'service-instance.sqlite3'))
      try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); rebaseDatabasePaths(home, '/var/lib/hermes-yaoyao') }
      finally { lock.close() }
    }
    return false
  }
  if (lstatSync(old).isSymbolicLink() || !lstatSync(old).isDirectory()) throw new Error('旧数据目录不是普通目录，请先核对实际数据位置')
  if (existsSync(home) && (lstatSync(home).isSymbolicLink() || readdirSync(home).length))
    throw new Error('~/.yaoyao 与 ~/.hermes-yaoyao 同时存在数据，已保留两份数据，请先合并确认后重试')
  if (legacyUpdateActive(userHome)) throw new Error('旧版升级事务尚未完成，请完成更新后重试数据迁移')
  const locks = []
  try {
    // Lock every SQLite database, including independent Runner owners, before moving.
    const lockTree = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['backups', 'uploads', 'workspace-files', 'chat-cache-assets'].includes(entry.name)) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { if (['runner-state', 'updates'].includes(entry.name) || directory.startsWith(join(old, 'runner-state'))) lockTree(path) }
        else if (/\.(sqlite3?|db)$/.test(entry.name)) {
          const db = new DatabaseSync(path); locks.push(db)
          db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
        }
      }
    }
    lockTree(old)
    const recordFile = join(old, 'service-instance.json')
    if (existsSync(recordFile)) {
      const { pid } = read(recordFile)
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error('旧版服务仍在运行，请停止后台服务后重试数据迁移') }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    write(join(old, markerName), { source: old, target: home, phase: 'moving', startedAt: new Date().toISOString() })
    if (existsSync(home)) rmdirSync(home)
    renameSync(old, home)
  } catch (error) {
    if (/locked|busy/i.test(error.message)) throw new Error('旧数据仍被服务或执行节点使用，停止后才能迁移')
    throw error
  } finally { for (const db of locks.reverse()) db.close() }
  rebaseDatabasePaths(home, old)
  write(marker, { ...read(marker), phase: 'complete' })
  return true
}
