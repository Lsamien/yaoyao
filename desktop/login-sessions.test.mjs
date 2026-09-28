import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DesktopLoginSessions } from './login-sessions.mjs'

test('native login vault encrypts only session authorization, restores by origin, and durably forgets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yaoyao-login-vault-')), key = randomBytes(32)
  const options = { home,
    encrypt: async value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]) },
    decrypt: async bytes => { const cipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString() },
  }
  try {
    let vault = new DesktopLoginSessions(options)
    const origin = 'https://server.example', cookie = {name:'hermes_yaoyao_session',value:'opaque-revocable-token',httpOnly:true,path:'/',sameSite:'strict'}
    await vault.save(origin,[cookie,{name:'csrf',value:'temporary'}])
    assert.ok(!(await readFile(vault.path(origin))).includes(Buffer.from(cookie.value)))
    assert.equal((await stat(vault.path(origin))).mode & 0o777, 0o600)
    vault = new DesktopLoginSessions(options)
    assert.deepEqual(await vault.read(origin),{origin,cookie})
    assert.equal(await vault.read('https://other.example'),undefined)
    const saving = vault.save(origin,[cookie]); const forgetting = vault.forget(origin)
    await Promise.all([saving,forgetting])
    assert.equal(await new DesktopLoginSessions(options).read(origin),undefined)
  } finally {await rm(home,{recursive:true,force:true})}
})
