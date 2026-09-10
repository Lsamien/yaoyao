import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const legacyDataHome = (userHome = homedir()) => join(userHome, '.hermes-yaoyao')
export const defaultDataHome = (userHome = homedir()) => join(userHome, '.yaoyao')
export function legacyUpdateActive(userHome = homedir()) {
  const old = legacyDataHome(userHome)
  try {
    const { pid } = JSON.parse(readFileSync(join(old, 'updates', 'active.lock'), 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return true } catch (error) { if (error.code !== 'ESRCH') return true }
    }
  } catch { /* No active updater. */ }
  return existsSync(join(old, 'updates', 'transition.json'))
}
/** Preserve explicit custom directories. Old official defaults migrate together. */
export function resolveDataHome(value, { userHome = homedir(), preserveActiveUpdate = false } = {}) {
  const requested = resolve(value?.trim() || defaultDataHome(userHome))
  if (![legacyDataHome(userHome), defaultDataHome(userHome)].includes(requested)) return requested
  // An old updater must finish its transaction against the original directory.
  if (preserveActiveUpdate && legacyUpdateActive(userHome)) return legacyDataHome(userHome)
  return defaultDataHome(userHome)
}
