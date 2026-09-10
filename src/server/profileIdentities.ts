import WebSocket from 'ws'
import type { ServerConfig } from './config.js'
import { HttpError } from './errors.js'
import type { UpstreamServiceSession } from './localAuth.js'
import {
  agentIdentityFromProfile,
  encodeAgentAvatar,
} from '../shared/agentIdentity.js'

export interface RemoteProfileIdentity {
  name: string
  displayName: string
  model: string
  color?: string
  avatar?: string
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {}
}

export class UpstreamProfileIdentityService {
  constructor(
    readonly config: ServerConfig,
    readonly upstream: UpstreamServiceSession,
  ) {}

  async load(): Promise<RemoteProfileIdentity[]> {
    const credential = await this.upstream.webSocketCredential()

    const url = new URL(this.config.upstream)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const prefix = this.config.upstream.pathname === '/'
      ? '' : this.config.upstream.pathname.replace(/\/$/, '')
    url.pathname = `${prefix}/api/ws`
    url.search = ''
    url.searchParams.set(credential.name, credential.value)

    return new Promise<RemoteProfileIdentity[]>((resolve, reject) => {
      const socket = new WebSocket(url, {
        agent: this.upstream.client.directAgent,
        headers: { Origin: this.config.upstream.origin },
        handshakeTimeout: 15_000,
        maxPayload: 36 * 1_024 * 1_024,
      })
      const identities = new Map<string, RemoteProfileIdentity>()
      let requestedProfiles = false
      let finished = false
      const timeout = setTimeout(() => finishError(new Error('profile identity request timed out')), 30_000)
      timeout.unref()

      const cleanup = () => {
        clearTimeout(timeout)
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      }
      const finish = () => {
        if (finished) return
        finished = true
        cleanup()
        resolve([...identities.values()])
      }
      const finishError = (error: Error) => {
        if (finished) return
        finished = true
        cleanup()
        reject(new HttpError(502, `无法读取机器人身份：${error.message}`, 'profile_identity_failed'))
      }
      const send = (id: string, method: string, params: JsonObject) => {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      }

      socket.on('message', raw => {
        let frame: JsonObject
        try { frame = object(JSON.parse(String(raw))) } catch { return }
        if (!requestedProfiles && object(frame.params).type === 'gateway.ready') {
          requestedProfiles = true
          send('profiles', 'profiles.list', { include_sessions: false })
          return
        }
        if (String(frame.id ?? '') === 'profiles') {
          const profiles = Array.isArray(object(frame.result).profiles)
            ? object(frame.result).profiles as unknown[] : []
          for (const entry of profiles) {
            const outer = object(entry)
            const profile = Object.keys(object(outer.profile)).length
              ? object(outer.profile) : outer
            const name = typeof profile.name === 'string' ? profile.name.trim() : ''
            if (!name) continue
            const agentIdentity = agentIdentityFromProfile(profile)
            const identity: RemoteProfileIdentity = {
              name,
              displayName: agentIdentity.displayName,
              model: typeof profile.model === 'string' ? profile.model : '',
              color: agentIdentity.color,
              avatar: encodeAgentAvatar(agentIdentity),
            }
            identities.set(name, identity)
          }
          finish()
          return
        }
      })
      socket.once('error', finishError)
      socket.once('unexpected-response', () => finishError(new Error('Hermes rejected identity socket')))
      socket.once('close', () => {
        if (!finished) finishError(new Error('Hermes closed identity socket'))
      })
    })
  }
}
