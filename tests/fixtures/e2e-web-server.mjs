import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const testHome = mkdtempSync('/tmp/hermes-yaoyao-e2e-home-')
const testUserID = '11111111-1111-4111-8111-111111111112'
process.once('exit', () => rmSync(testHome, { recursive: true, force: true }))
mkdirSync(testHome, { recursive: true, mode: 0o700 })

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

// General media fixtures intentionally span several server directories.
// Permission-specific QA leaves the production cwd-only default intact.
if (process.env.YAOYAO_FILE_ACCESS_TEST_MODE !== 'cwd') {
  const { saveFileAccess } = await import('../../dist-server/server/fileAccess.js')
  saveFileAccess(testHome, { mode: 'all', folders: [] })
}

Object.assign(process.env, {
  NODE_ENV: 'production',
  HERMES_YAOYAO_HOME: testHome,
  HERMES_YAOYAO_HOST: '127.0.0.1',
  HERMES_YAOYAO_PORT: process.env.YAOYAO_E2E_PORT || '18801',
  HERMES_YAOYAO_UPSTREAM: `http://127.0.0.1:${process.env.FAKE_HERMES_PORT || '19119'}`,
  HERMES_YAOYAO_UPSTREAM_USERNAME: 'test',
  HERMES_YAOYAO_UPSTREAM_PASSWORD: 'test',
})

if (process.env.FAKE_HERMES_LOCAL_AUTH === '1') {
  delete process.env.HERMES_YAOYAO_UPSTREAM_USERNAME
  delete process.env.HERMES_YAOYAO_UPSTREAM_PASSWORD
  delete process.env.HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE
}

await import('../../dist-server/server/index.js')
