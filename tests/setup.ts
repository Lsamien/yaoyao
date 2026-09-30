import { afterEach, beforeEach } from 'vitest'

beforeEach(() => {
  // Node's native storage globals can shadow jsdom's browser storage.
  const browser = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window
  if (!browser) return
  for (const key of ['localStorage', 'sessionStorage'] as const)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] })
})

afterEach(() => {
  if (typeof document !== 'undefined') document.body.innerHTML = ''
  if (typeof localStorage !== 'undefined') localStorage.clear()
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})
