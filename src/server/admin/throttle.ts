import { HttpError } from '../errors.js'

/** Failed console logins: 5 per 10 minutes per source IP and per account, then a 15 minute lock. */
export class LoginThrottle {
  readonly #failures = new Map<string, number[]>()
  readonly #locked = new Map<string, number>()
  constructor(readonly limit = 5, readonly windowMs = 10 * 60_000, readonly lockMs = 15 * 60_000, readonly now = () => Date.now()) {}

  #keys(ip: string, username: string): string[] {
    return [`ip:${ip}`, `user:${username.trim().toLocaleLowerCase('en-US')}`]
  }

  assertAllowed(ip: string, username: string): void {
    const now = this.now()
    for (const key of this.#keys(ip, username)) {
      const until = this.#locked.get(key)
      if (until && until > now) {
        const minutes = Math.ceil((until - now) / 60_000)
        throw new HttpError(429, `登录失败次数过多，请 ${minutes} 分钟后再试。`, 'admin_login_locked')
      }
      if (until) this.#locked.delete(key)
    }
  }

  /** Returns true when this failure locked the IP or the account. */
  fail(ip: string, username: string): boolean {
    const now = this.now()
    let locked = false
    for (const key of this.#keys(ip, username)) {
      const recent = (this.#failures.get(key) ?? []).filter(at => now - at < this.windowMs)
      recent.push(now)
      this.#failures.set(key, recent)
      if (recent.length >= this.limit) {
        this.#locked.set(key, now + this.lockMs)
        this.#failures.delete(key)
        locked = true
      }
    }
    return locked
  }

  succeed(ip: string, username: string): void {
    for (const key of this.#keys(ip, username)) this.#failures.delete(key)
  }
}
