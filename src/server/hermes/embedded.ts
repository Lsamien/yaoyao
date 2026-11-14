import { join } from 'node:path'
import { HermesApi } from './api.js'
import { HermesServicePool, type HermesServiceOptions } from './service.js'
import { EmbeddedSessions } from './sessions.js'

/** The embedded Hermes runtime owned by one Yaoyao server: service processes, sessions and the in-process API. */
export interface EmbeddedHermes {
  readonly home: string
  readonly pool: HermesServicePool
  readonly sessions: EmbeddedSessions
  readonly api: HermesApi
  close(): void
}

export function createEmbeddedHermes(dataHome: string, options: HermesServiceOptions = {}): EmbeddedHermes {
  const pool = new HermesServicePool(dataHome, options)
  const sessions = new EmbeddedSessions(join(dataHome, 'hermes'))
  const api = new HermesApi(pool, sessions)
  return { home: pool.systemHome, pool, sessions, api, close: () => pool.close() }
}
