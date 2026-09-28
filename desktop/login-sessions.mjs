import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Native-only vault. Passwords are never retained; each origin owns one revocable session. */
export class DesktopLoginSessions {
  constructor({ home, encrypt, decrypt }) {
    this.root = join(home, 'desktop-login-sessions')
    this.encrypt = encrypt; this.decrypt = decrypt
    this.pending = Promise.resolve()
  }
  path(origin) { return join(this.root, createHash('sha256').update(new URL(origin).origin).digest('hex') + '.enc') }
  serial(run) {
    const next = this.pending.then(run)
    this.pending = next.catch(() => {})
    return next
  }
  read(origin) {
    return this.serial(async () => {
      let bytes
      try { bytes = await readFile(this.path(origin)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      const value = JSON.parse(await this.decrypt(bytes))
      if (value.origin !== new URL(origin).origin || value.cookie?.name !== 'hermes_yaoyao_session' || typeof value.cookie.value !== 'string' || !value.cookie.value)
        throw new Error('保存的登录授权无效，请重新登录')
      return value
    })
  }
  save(origin, cookies) {
    return this.serial(async () => {
      const cookie = cookies.find(value => value.name === 'hermes_yaoyao_session' && value.value)
      if (!cookie) throw new Error('服务器没有返回登录授权')
      const bytes = await this.encrypt(JSON.stringify({ origin: new URL(origin).origin, cookie }))
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const path = this.path(origin), temporary = path + '.' + randomUUID()
      try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
      finally { await rm(temporary, { force: true }) }
    })
  }
  forget(origin) { return this.serial(() => rm(this.path(origin), { force: true })) }
}
