import { isIP } from 'node:net'
import { normalizeReleaseSource } from '../../bin/lib/release-source.mjs'
import { resolveDataHome } from '../../bin/lib/data-home.mjs'
import { homedir } from 'node:os'
import { basename, resolve, isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import type { APNsEnvironment } from './apns.js'
import { loadAPNsConfiguration, type APNsConfigurationSnapshot } from './apnsConfiguration.js'
import { loadFCMConfiguration, type FCMConfigurationSnapshot } from './fcmConfiguration.js'
import {
  loadAllowedHostsConfiguration,
  type AllowedHostsConfigurationSnapshot,
} from './allowedHostsConfiguration.js'
export { DEFAULT_APNS_TOPIC } from './apnsConfiguration.js'

export interface APNsProviderConfig {
  keyFile: string
  keyId: string
  teamId: string
  topic: string
  environments?: APNsEnvironment[]
}

export interface FCMProviderConfig {
  serviceAccountFile: string
  projectId: string
  packageName: string
}

/** Separate management listener (the admin console). */
export interface AdminConsoleConfig {
  enabled: boolean
  host: string
  port: number
  /** Client IPs/CIDRs allowed on a non-loopback listener; loopback clients are always allowed. */
  allowIps: string[]
  /** Explicit opt-out of TLS for a non-loopback listener (Docker port published on 127.0.0.1 only). */
  insecureHttp: boolean
  /** Listener is reachable from other machines: an IP allowlist and TLS (or loopback-only publishing) are required. */
  external: boolean
}

export interface ServerConfig {
  admin: AdminConsoleConfig
  credentialVault?: { socket: string; tokenFile: string; hermesUid: number }
  host: string
  port: number
  upstream: URL
  allowedHosts: ReadonlySet<string>
  home: string
  mediaRoot: string
  attachmentsRoot: string
  imagesRoot: string
  mediaOwner: string
  tlsCert?: string
  tlsKey?: string
  allowInsecureLan: boolean
  insecureLan: boolean
  production: boolean
  /** Docker deployments never run virtual machines. */
  deployment?: 'native' | 'docker'
  releaseSource?: string
  releaseRoot?: string
  allowRemoteUpdate?: boolean
  upstreamUsername?: string
  upstreamPassword?: string
  apns?: APNsProviderConfig
  apnsConfigurationError?: string
  apnsSettings?: APNsConfigurationSnapshot
  fcm?: FCMProviderConfig
  fcmConfigurationError?: string
  fcmSettings?: FCMConfigurationSnapshot
  allowedHostsSettings?: AllowedHostsConfigurationSnapshot
}

export { DEFAULT_RELEASE_SOURCE as DEFAULT_YAOYAO_RELEASE_SOURCE } from '../../bin/lib/release-source.mjs'

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '15300')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HERMES_YAOYAO_PORT must be an integer between 1 and 65535')
  }
  return port
}


const CIDR = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)(?:\/\d{1,3})?$/i

/** Admin console listener. A non-loopback listener must name its clients and use TLS (or opt out explicitly). */
export function loadAdminConsoleConfig(env: NodeJS.ProcessEnv, mainPort: number, tls: boolean): AdminConsoleConfig {
  const rawPort = env.YAOYAO_ADMIN_PORT?.trim()
  const enabled = rawPort?.toLowerCase() !== 'off'
  const port = enabled ? Number(rawPort || '15301') : 0
  if (enabled && (!Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('YAOYAO_ADMIN_PORT must be an integer between 1 and 65535, or off')
  if (enabled && port === mainPort) throw new Error('YAOYAO_ADMIN_PORT must differ from the Web port')
  const host = env.YAOYAO_ADMIN_HOST?.trim() || '127.0.0.1'
  const allowIps = (env.YAOYAO_ADMIN_ALLOW_IPS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  for (const item of allowIps) if (!CIDR.test(item)) throw new Error(`YAOYAO_ADMIN_ALLOW_IPS has an invalid entry: ${item}`)
  const insecureHttp = flag(env.YAOYAO_ADMIN_INSECURE_HTTP)
  const external = enabled && !isLoopbackHost(host)
  if (external) {
    if (!allowIps.length) throw new Error('A non-loopback YAOYAO_ADMIN_HOST requires YAOYAO_ADMIN_ALLOW_IPS')
    if (!tls && !insecureHttp) throw new Error('A non-loopback YAOYAO_ADMIN_HOST requires HERMES_YAOYAO_TLS_CERT/KEY, or YAOYAO_ADMIN_INSECURE_HTTP=1 when the port is only published on the host loopback')
  }
  return { enabled, host, port, allowIps, insecureHttp, external }
}

function parseUpstream(value: string | undefined): URL {
  const upstream = new URL(value ?? 'http://127.0.0.1:9119')
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('HERMES_YAOYAO_UPSTREAM must use http or https')
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('HERMES_YAOYAO_UPSTREAM must not contain credentials, query, or fragment')
  }
  upstream.pathname = upstream.pathname.replace(/\/+$/, '') || '/'
  return upstream
}

function parseReleaseSource(value: string | undefined): string {
  const source = normalizeReleaseSource(value)
  if (source === 'npm:@lsamien/yaoyao') return source
  if (source.length > 2_048 || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('HERMES_YAOYAO_RELEASE_SOURCE is invalid')
  }
  if (source.startsWith('https://') || source.startsWith('ssh://')) {
    const url = new URL(source)
    if ((url.protocol === 'https:' && url.username) || url.password || url.search || url.hash) {
      throw new Error('HERMES_YAOYAO_RELEASE_SOURCE must not contain credentials, query, or fragment')
    }
  } else if (!source.startsWith('git@') && !source.startsWith('ssh://')) {
    throw new Error('HERMES_YAOYAO_RELEASE_SOURCE must be an HTTPS or SSH Git source')
  }
  return source
}

function normalizeConfiguredHost(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value) return ''
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1)
  return value.replace(/\.$/, '')
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeConfiguredHost(host)
  if (normalized === 'localhost' || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.split('.')[0] === '127'
  return false
}

export function isPrivateHost(host: string): boolean {
  const normalized = normalizeConfiguredHost(host)
  if (isLoopbackHost(normalized)) return true
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    return parts[0] === 10
      || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168)
  }
  if (isIP(normalized) === 6) {
    return normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
  }
  return false
}

export function isLoopbackUpstream(upstream: URL): boolean {
  return isLoopbackHost(upstream.hostname)
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const host = env.HERMES_YAOYAO_HOST?.trim() || '127.0.0.1'
  const port = parsePort(env.HERMES_YAOYAO_PORT)
  const upstream = parseUpstream(env.HERMES_YAOYAO_UPSTREAM)
  const home = resolveDataHome(env.YAOYAO_HOME || env.HERMES_YAOYAO_HOME, { preserveActiveUpdate: true })
  const mediaRoot = resolve(env.HERMES_YAOYAO_MEDIA_ROOT?.trim() || `${homedir()}/Agents`)
  // Embedded Hermes keeps generated attachments and images inside the Yaoyao data directory.
  const attachmentsRoot = resolve(home, 'hermes', 'attachments')
  const imagesRoot = resolve(home, 'hermes', 'images')
  const tlsCert = env.HERMES_YAOYAO_TLS_CERT?.trim() || undefined
  const tlsKey = env.HERMES_YAOYAO_TLS_KEY?.trim() || undefined
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error('HERMES_YAOYAO_TLS_CERT and HERMES_YAOYAO_TLS_KEY must be set together')
  }
  const allowInsecureLan = flag(env.HERMES_YAOYAO_ALLOW_INSECURE_LAN)
  const production = env.NODE_ENV === 'production'
  // HERMES_YAOYAO_LOCAL_VM_HOST=runner was the marker of older Docker images.
  const deployment = env.YAOYAO_DEPLOYMENT?.trim() === 'docker' || env.HERMES_YAOYAO_LOCAL_VM_HOST?.trim() === 'runner' ? 'docker' : 'native'
  const releaseSource = parseReleaseSource(env.HERMES_YAOYAO_RELEASE_SOURCE)
  const releaseRoot = resolve(env.HERMES_YAOYAO_RELEASE_ROOT?.trim() || `${homedir()}/.local/share/hermes-yaoyao`)
  const allowRemoteUpdate = flag(env.HERMES_YAOYAO_ALLOW_REMOTE_UPDATE)
  const upstreamUsername = env.HERMES_YAOYAO_UPSTREAM_USERNAME?.trim() || undefined
  const upstreamPasswordFile = env.HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE?.trim()
  if (env.HERMES_YAOYAO_UPSTREAM_PASSWORD && upstreamPasswordFile) {
    throw new Error('Set only one of HERMES_YAOYAO_UPSTREAM_PASSWORD or HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE')
  }
  const upstreamPassword = env.HERMES_YAOYAO_UPSTREAM_PASSWORD
    || (upstreamPasswordFile ? readFileSync(resolve(upstreamPasswordFile), 'utf8').replace(/[\r\n]+$/, '') : undefined)
  const apnsSettings = loadAPNsConfiguration(home, env)
  const fcmSettings = loadFCMConfiguration(home, env)
  const insecureLan = !tlsCert && !isLoopbackHost(host)
  if (production && insecureLan && !allowInsecureLan) {
    throw new Error(
      'Plain HTTP on a non-loopback host requires HERMES_YAOYAO_ALLOW_INSECURE_LAN=1',
    )
  }
  const allowedHostsSettings = loadAllowedHostsConfiguration(home, env)
  const allowedHosts = new Set(allowedHostsSettings.hosts)
  return {
    admin: loadAdminConsoleConfig(env, port, Boolean(tlsCert)),
    host,
    port,
    upstream,
    allowedHosts,
    allowedHostsSettings,
    home,
    mediaRoot,
    attachmentsRoot,
    imagesRoot,
    mediaOwner: basename(homedir()),
    ...(env.HERMES_YAOYAO_VAULT_SOCKET || env.HERMES_YAOYAO_VAULT_TOKEN_FILE ? { credentialVault: {
      socket: env.HERMES_YAOYAO_VAULT_SOCKET || '', tokenFile: env.HERMES_YAOYAO_VAULT_TOKEN_FILE || '', hermesUid: Number(env.HERMES_YAOYAO_VAULT_HERMES_UID),
    } } : {}),
    tlsCert,
    tlsKey,
    allowInsecureLan,
    insecureLan,
    production,
    deployment,
    releaseSource,
    releaseRoot,
    allowRemoteUpdate,
    upstreamUsername,
    upstreamPassword,
    ...(apnsSettings.config ? { apns: apnsSettings.config } : {}),
    ...(apnsSettings.configurationError ? { apnsConfigurationError: apnsSettings.configurationError } : {}),
    apnsSettings,
    ...(fcmSettings.config ? { fcm: fcmSettings.config } : {}),
    ...(fcmSettings.configurationError ? { fcmConfigurationError: fcmSettings.configurationError } : {}),
    fcmSettings,
  }
}
