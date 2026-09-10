// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDataHome } from '../../bin/lib/data-home.mjs'
import { migrateDataHome } from '../../bin/lib/data-migration.mjs'
const roots: string[] = []
function fixture() {
  const userHome = mkdtempSync(join(tmpdir(), 'yaoyao-migration-')); roots.push(userHome)
  const old = join(userHome, '.hermes-yaoyao'), home = join(userHome, '.yaoyao')
  mkdirSync(old, { mode: 0o700 })
  return { userHome, old, home }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('data directory migration', () => {
  it('normalizes the old default and preserves explicit custom homes', () => {
    const { userHome, old, home } = fixture()
    expect(resolveDataHome(undefined, { userHome })).toBe(home)
    expect(resolveDataHome(old, { userHome })).toBe(home)
    expect(resolveDataHome('/srv/custom', { userHome })).toBe('/srv/custom')
  })
  it('moves accounts, binary keys, WAL data, Runner state and files and rebases only internal paths', () => {
    const { userHome, old, home } = fixture(), key = Buffer.from([0, 23, 255, 8])
    writeFileSync(join(old, 'workspace-key.bin'), key)
    writeFileSync(join(old, 'users.json'), '{"id":"same-user"}')
    mkdirSync(join(old, 'runner-state', 'runner'), { recursive: true })
    writeFileSync(join(old, 'runner-state', 'runner', 'config.enc'), key)
    mkdirSync(join(old, 'uploads')); writeFileSync(join(old, 'uploads', 'example.txt'), 'file-content')
    mkdirSync(join(old, 'updates')); writeFileSync(join(old, 'updates', 'last-success.json'), JSON.stringify({snapshot: old + '/updates/backups/1', previous: {plist: {EnvironmentVariables: {HERMES_YAOYAO_HOME: old}}}}))
    const db = new DatabaseSync(join(old, 'uploads.sqlite3'))
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE uploads(id TEXT, path TEXT, message TEXT)')
    db.prepare('INSERT INTO uploads VALUES(?,?,?)').run('1', old + '/uploads/example.txt', old + '/leave-message-text')
    db.prepare('INSERT INTO uploads VALUES(?,?,?)').run('2', old + '-other/file', 'external')
    db.close()
    expect(migrateDataHome(home, { userHome })).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(home, 'workspace-key.bin'))).toEqual(key)
    expect(readFileSync(join(home, 'runner-state/runner/config.enc'))).toEqual(key)
    expect(readFileSync(join(home, 'users.json'), 'utf8')).toContain('same-user')
    const moved = new DatabaseSync(join(home, 'uploads.sqlite3'))
    expect(moved.prepare('SELECT * FROM uploads ORDER BY id').all()).toEqual([
      { id: '1', path: home + '/uploads/example.txt', message: old + '/leave-message-text' },
      { id: '2', path: old + '-other/file', message: 'external' },
    ])
    expect(moved.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); moved.close()
    expect(JSON.parse(readFileSync(join(home, 'updates/last-success.json'), 'utf8')).snapshot).toBe(home + '/updates/backups/1')
    expect(migrateDataHome(home, { userHome })).toBe(false)
  })
  it('refuses live service or Runner locks without moving either directory', () => {
    const { userHome, old, home } = fixture()
    mkdirSync(join(old, 'runner-state/r1'), { recursive: true })
    const db = new DatabaseSync(join(old, 'runner-state/r1/service-instance.sqlite3')); db.exec('BEGIN EXCLUSIVE')
    try { expect(() => migrateDataHome(home, { userHome })).toThrow('使用'); expect(existsSync(old)).toBe(true); expect(existsSync(home)).toBe(false) }
    finally { db.close() }
  })
  it('preserves both populated directories rather than overwriting a newer installation', () => {
    const { userHome, old, home } = fixture(); mkdirSync(home)
    writeFileSync(join(old, 'users.json'), 'old'); writeFileSync(join(home, 'users.json'), 'new')
    expect(() => migrateDataHome(home, { userHome })).toThrow('同时存在')
    expect(readFileSync(join(old, 'users.json'), 'utf8')).toBe('old'); expect(readFileSync(join(home, 'users.json'), 'utf8')).toBe('new')
  })
  it('defers old updater transactions and resumes a crash after the directory rename', () => {
    const { userHome, old, home } = fixture(); mkdirSync(join(old, 'updates'))
    writeFileSync(join(old, 'updates/active.lock'), JSON.stringify({ pid: process.pid }))
    expect(resolveDataHome(undefined, { userHome, preserveActiveUpdate: true })).toBe(old)
    expect(() => migrateDataHome(home, { userHome })).toThrow('事务')
    rmSync(join(old, 'updates/active.lock')); expect(migrateDataHome(home, { userHome })).toBe(true)
    const marker = join(home, '.data-home-migration.json'); writeFileSync(marker, JSON.stringify({ source: old, target: home, phase: 'moving' }))
    migrateDataHome(home, { userHome }); expect(JSON.parse(readFileSync(marker, 'utf8')).phase).toBe('complete')
  })
})
