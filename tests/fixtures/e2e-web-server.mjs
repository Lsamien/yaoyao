import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const testHome = '/tmp/hermes-yaoyao-e2e-home'
const testUserID = '11111111-1111-4111-8111-111111111112'
rmSync(testHome, { recursive: true, force: true })
mkdirSync(testHome, { recursive: true, mode: 0o700 })

// The browser fixture exercises the ownership registry, not the mutable
// upstream `source` field. Seed only the sessions that were explicitly
// created by this local Web user; session-history-only deliberately remains
// unowned even though fake Hermes labels it source=web.
const salt = randomBytes(16)
const now = Date.now()
writeFileSync(`${testHome}/users.json`, JSON.stringify({
  version: 1,
  users: [{
    id: testUserID,
    username: 'admin',
    normalizedUsername: 'admin',
    role: 'admin',
    enabled: true,
    mustChangePassword: false,
    salt: salt.toString('base64'),
    passwordHash: scryptSync('e2e-password', salt, 32, {
      N: 2 ** 14,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString('base64'),
    authVersion: 1,
    createdAt: now,
    updatedAt: now,
  }],
}), { mode: 0o600 })

const ownedSessions = [
  ['session-demo', 'yaoyao'],
  ['session-second', 'yaoyao'],
  ['session-yaoer', 'yaoer'],
  ['session-media', 'yaoer'],
  ['session-user-media', 'yaoer'],
  ...Array.from({ length: 101 }, (_, index) => [`session-page-${index + 1}`, 'yaoyao']),
]
const { ChatCacheStore } = await import('../../dist-server/server/chatCache.js')
const registry = new ChatCacheStore(testHome, testUserID)
for (const [sessionID, profile] of ownedSessions) {
  registry.recordCommand(testUserID, profile, sessionID, 'session.create', {
    profile,
    source: 'web',
  })
}
// These are existing Hermes histories, not empty sessions created by this build.
// Exercise the durable background import, never a blocking list fallback.
registry.db.exec('UPDATE chat_sessions SET metadata_complete=0,complete=0,message_total=NULL')
registry.db.exec('INSERT OR IGNORE INTO chat_recovery_jobs(owner,profile,session_id) SELECT owner,profile,session_id FROM chat_sessions WHERE owned_at IS NOT NULL')
registry.close()

Object.assign(process.env, {
  NODE_ENV: 'production',
  HERMES_YAOYAO_HOME: testHome,
  HERMES_YAOYAO_HOST: '127.0.0.1',
  HERMES_YAOYAO_PORT: '18801',
  HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:19119',
  HERMES_YAOYAO_UPSTREAM_USERNAME: 'test',
  HERMES_YAOYAO_UPSTREAM_PASSWORD: 'test',
})

if (process.env.FAKE_HERMES_LOCAL_AUTH === '1') {
  delete process.env.HERMES_YAOYAO_UPSTREAM_USERNAME
  delete process.env.HERMES_YAOYAO_UPSTREAM_PASSWORD
  delete process.env.HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE
}

await import('../../dist-server/server/index.js')
