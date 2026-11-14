import { join } from 'node:path'
import { HermesApi } from './api.js'
import { HermesServicePool, type HermesServiceOptions } from './service.js'
import { EmbeddedSessions } from './sessions.js'
import { EmbeddedGateway, type GatewayPolicy } from './gateway.js'

/** The embedded Hermes runtime owned by one Yaoyao server: service processes, sessions and the in-process API. */
export interface EmbeddedHermes {
  readonly home: string
  readonly pool: HermesServicePool
  readonly sessions: EmbeddedSessions
  readonly api: HermesApi
  readonly gateway: EmbeddedGateway
  close(): void
}

export interface EmbeddedHermesOptions extends HermesServiceOptions {
  policy?: () => GatewayPolicy
  defaultCwd?: string
}

export function createEmbeddedHermes(dataHome: string, options: EmbeddedHermesOptions = {}): EmbeddedHermes {
  const pool = new HermesServicePool(dataHome, options)
  const sessions = new EmbeddedSessions(join(dataHome, 'hermes'))
  const api = new HermesApi(pool, sessions)
  const gateway = new EmbeddedGateway({ pool, sessions, ...(options.policy ? { policy: options.policy } : {}), ...(options.defaultCwd ? { defaultCwd: options.defaultCwd } : {}), ...(options.env ? { env: options.env } : {}) })
  return { home: pool.systemHome, pool, sessions, api, gateway, close: () => { gateway.close(); pool.close() } }
}
