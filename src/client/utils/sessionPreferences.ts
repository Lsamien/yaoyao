const FAST_MODE_PREFIX = 'hermes-yaoyao:fast-mode'
const THINKING_PREFIX = 'hermes-yaoyao:show-thinking'

function scopedKey(prefix: string, userId: string, profile: string, sessionId?: string): string {
  return [prefix, userId || 'local', profile || 'default', sessionId || ''].map(encodeURIComponent).join('|')
}

export function readSessionFastMode(userId: string, profile: string, sessionId: string): boolean {
  try { return localStorage.getItem(scopedKey(FAST_MODE_PREFIX, userId, profile, sessionId)) === '1' } catch { return false }
}

export function writeSessionFastMode(userId: string, profile: string, sessionId: string, enabled: boolean): void {
  try {
    const key = scopedKey(FAST_MODE_PREFIX, userId, profile, sessionId)
    if (enabled) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch { /* optional local mirror */ }
}

export function moveSessionFastMode(userId: string, profile: string, fromSessionId: string, toSessionId: string, enabled: boolean): void {
  writeSessionFastMode(userId, profile, fromSessionId, false)
  writeSessionFastMode(userId, profile, toSessionId, enabled)
}

export function readAgentShowThinking(userId: string, profile: string): boolean {
  try { return localStorage.getItem(scopedKey(THINKING_PREFIX, userId, profile)) === '1' } catch { return false }
}

export function writeAgentShowThinking(userId: string, profile: string, visible: boolean): void {
  try { localStorage.setItem(scopedKey(THINKING_PREFIX, userId, profile), visible ? '1' : '0') } catch { /* optional preference */ }
}
