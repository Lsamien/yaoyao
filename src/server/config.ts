import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { APNsEnvironment } from './apns.js'
import { loadAPNsConfiguration, type APNsConfigurationSnapshot } from './apnsConfiguration.js'
import { loadFCMConfiguration, type FCMConfigurationSnapshot } from './fcmConfiguration.js'
import {
  loadAllowedHostsConfiguration,
  type AllowedHostsConfigurationSnapshot,
} from './allowedHostsConfiguration.js'
import type { ChatCacheMode } from './chatCache.js'
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

export interface ServerConfig {
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
  superviseDashboard?: boolean
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
  chatCacheMode?: ChatCacheMode
}

export const DEFAULT_YAOYAO_RELEASE_SOURCE = 'https://git.samien.cn/samien/hermes-yaoyao.git'

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

function parseChatCacheMode(value: string | undefined): ChatCacheMode {
  const mode = value?.trim() || 'prefer-local'
  if (!['upstream-only', 'shadow', 'prefer-local'].includes(mode)) {
    throw new Error('HERMES_YAOYAO_CHAT_CACHE_MODE must be upstream-only, shadow, or prefer-local')
  }
  return mode as ChatCacheMode
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
  const source = value?.trim() || DEFAULT_YAOYAO_RELEASE_SOURCE
  if (source.length > 2_048 || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('HERMES_YAOYAO_RELEASE_SOURCE is invalid')
  }
  if (source.startsWith('https://')) {
    const url = new URL(source)
    if (url.username || url.password || url.search || url.hash) {
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
  const home = resolve(env.HERMES_YAOYAO_HOME?.trim() || `${homedir()}/.hermes-yaoyao`)
  const mediaRoot = resolve(env.HERMES_YAOYAO_MEDIA_ROOT?.trim() || `${homedir()}/Agents`)
  const attachmentsRoot = resolve(`${homedir()}/.hermes/attachments`)
  const imagesRoot = resolve(`${homedir()}/.hermes/images`)
  const tlsCert = env.HERMES_YAOYAO_TLS_CERT?.trim() || undefined
  const tlsKey = env.HERMES_YAOYAO_TLS_KEY?.trim() || undefined
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error('HERMES_YAOYAO_TLS_CERT and HERMES_YAOYAO_TLS_KEY must be set together')
  }
  const allowInsecureLan = flag(env.HERMES_YAOYAO_ALLOW_INSECURE_LAN)
  const production = env.NODE_ENV === 'production'
  const superviseDashboard = flag(env.HERMES_YAOYAO_SUPERVISE_DASHBOARD)
  const chatCacheMode = parseChatCacheMode(env.HERMES_YAOYAO_CHAT_CACHE_MODE)
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
    tlsCert,
    tlsKey,
    allowInsecureLan,
    insecureLan,
    production,
    superviseDashboard,
    chatCacheMode,
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
