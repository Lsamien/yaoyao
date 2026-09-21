/** Owner-scoped Bot endpoints. Keep native and administrative surfaces denied. */
export function isWorkspaceAccountPath(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD'
  if (read && /^\/api\/app\/workspace\/(snapshot|projects|memories|memory-export|memory-jobs|collaboration)$/.test(path)) return true
  if (read && /^\/api\/app\/workspace\/memories\/[^/]+\/revisions$/.test(path)) return true
  return method === 'POST' && /^\/api\/app\/workspace\/(projects|memories|memories\/forget|memory-jobs\/[^/]+\/retry|collaboration\/[^/]+\/stop)$/.test(path)
}

/** Bound memory as well as request frequency; untrusted forwarded IPs are not used. */
export class RegistrationLimiter {
  private readonly attempts = new Map<string, { count: number; expires: number }>()
  take(address: string, now = Date.now()): number {
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key)
    let entry = this.attempts.get(address)
    if (!entry) {
      if (this.attempts.size >= 10_000) return 60
      entry = { count: 0, expires: now + 15 * 60_000 }
      this.attempts.set(address, entry)
    }
    if (++entry.count > 10) return Math.ceil((entry.expires - now) / 1000)
    return 0
  }
}
