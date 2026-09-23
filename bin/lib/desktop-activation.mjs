import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const desktopActivationPath = home => join(home, 'desktop-runtime-activation.json')
export function hasDesktopActivation(home) {
  try { return JSON.parse(readFileSync(desktopActivationPath(home), 'utf8')).version === 1 }
  catch { return false }
}
export function grantDesktopActivation(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = desktopActivationPath(home), temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1 }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
export function deferDesktopActivation(home) { rmSync(desktopActivationPath(home), { force: true }) }
