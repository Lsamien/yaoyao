import { acknowledgeUnread, unreadSnapshot } from './unreadCenter.js'
import { z } from 'zod'
import { RegistrationLimiter } from './subaccountAccess.js'
import { readServerIdentity, updateServerIdentity } from './serverIdentity.js'
import { authorizeFileRead, fileAccessWorkingDirectory, readFileAccess, saveFileAccess } from './fileAccess.js'
import { readHostTools, saveHostTools, vmSupported } from './hostToolSettings.js'
import type { ServerIdentity } from '../shared/serverIdentity.js'
import type Koa from 'koa'
import type { WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceConversation } from '../shared/workspace.js'
import Router from '@koa/router'
import { parse } from 'cookie'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { lookup as mimeLookup } from 'mime-types'
import { isSupportedGroupProtocolVersion, SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '../shared/types.js'
import type { ServerConfig } from './config.js'
import { isLoopbackHost, isLoopbackUpstream, isPrivateHost } from './config.js'
import { HttpError } from './errors.js'
import { kernelPaths, requireKernel } from './hermes/paths.js'
import { registerHermesAdminRoutes } from './hermesAdminRoutes.js'
import { compareReleaseVersions } from './releases.js'
import {
  bearerToken,
  DEFAULT_NODE_SCOPES,
  NODE_PAIRING_PROTOCOL_VERSION,
  type NodeScope,
  NodePairingStore,
} from './pairing.js'
import { CsrfProtection, requestAccountKey } from './security.js'
import {
  applyUpstreamCookies,
  CookieJar,
  decodeUpstreamError,
  sendUpstreamResponse,
  type UpstreamResponse,
  UpstreamClient,
} from './upstream.js'
import { receiveGroupUploads, uploadMarkdown, UploadStore } from './uploads.js'
import { SystemUpdateManager, type SystemUpdateStatus } from './updateManager.js'
import { LocalAuthStore, type LocalUser, UpstreamServiceSession } from './localAuth.js'
import { AccountLoginPairingStore } from './accountPairing.js'
import { UpstreamProfileIdentityService } from './profileIdentities.js'
import { PushCoordinator } from './pushCoordinator.js'
import {
  APNsConfigurationManager,
  type APNsConfigurationInput,
} from './apnsConfiguration.js'
import {
  FCMConfigurationManager,
  type FCMConfigurationInput,
} from './fcmConfiguration.js'
import type { OpenVikingConfigurationManager } from './openVikingConfiguration.js'
import type { OpenVikingService } from './openVikingService.js'
import type { OpenVikingSessionSync } from './openVikingSessionSync.js'
import {
  AllowedHostsConfigurationManager,
  canonicalAllowedHosts,
  normalizeAllowedHost,
} from './allowedHostsConfiguration.js'

type JsonObject = Record<string, unknown>

export interface RouteDependencies {
  hermes?: import('./hermes/embedded.js').EmbeddedHermes
  onServerIdentityChanged?: (identity: ServerIdentity) => void
  onUserAccessChanged?: (owner: string) => Promise<void>
  workspace: WorkspaceStore
  config: ServerConfig
  csrf: CsrfProtection
  upstream: UpstreamClient
  pairings: NodePairingStore
  uploads: UploadStore
  updates: SystemUpdateManager
  auth: LocalAuthStore
  upstreamSession: UpstreamServiceSession
  accountPairings: AccountLoginPairingStore
  profileIdentities: UpstreamProfileIdentityService
  push: PushCoordinator
  apnsConfiguration: APNsConfigurationManager
  fcmConfiguration: FCMConfigurationManager
  openVikingConfiguration: OpenVikingConfigurationManager
  openVikingService: OpenVikingService
  openVikingSessionSync: OpenVikingSessionSync
  allowedHostsConfiguration: AllowedHostsConfigurationManager
}

function body(ctx: Koa.Context): JsonObject {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'A JSON object body is required', 'invalid_json_body')
  }
  return value as JsonObject
}

function optionalBody(ctx: Koa.Context): JsonObject | undefined {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}


function parseJson(response: UpstreamResponse): JsonObject {
  try {
    const value = JSON.parse(response.body.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as JsonObject
  } catch {
    throw new HttpError(502, 'Hermes returned invalid JSON', 'invalid_upstream_json')
  }
}

function requireSuccess(response: UpstreamResponse): JsonObject {
  if (response.status < 200 || response.status >= 300) {
    const decoded = decodeUpstreamError(response)
    throw new HttpError(response.status, decoded.error, decoded.code)
  }
  return parseJson(response)
}

function searchFrom(ctx: Koa.Context, allowed: readonly string[]): URLSearchParams {
  const incoming = new URLSearchParams(ctx.querystring)
  const outgoing = new URLSearchParams()
  for (const name of allowed) {
    for (const value of incoming.getAll(name)) outgoing.append(name, value)
  }
  return outgoing
}

function safeIdentifier(value: string, label = 'identifier'): string {
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..'
    || normalized.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(normalized)) {
    throw new HttpError(400, `Invalid ${label}`, 'invalid_identifier')
  }
  return normalized
}

function canonicalUUID(value: string, label: string): string {
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, `${label} must be a UUID`, 'invalid_identifier')
  }
  return normalized
}

function normalizedProfiles(value: JsonObject): unknown[] {
  const profiles = Array.isArray(value.profiles) ? value.profiles : []
  return profiles.map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const object = entry as JsonObject
      return object.profile && typeof object.profile === 'object' ? object.profile : object
    }
    return entry
  })
}

function profilesWithCoreNames(profiles: unknown[]): unknown[] {
  return profiles.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const profile = entry as JsonObject
    const meta = profile.ui_meta as Record<string, any> | undefined
    const title = meta?.['hermes-bots']?.title ?? profile.display_name
    return typeof title === 'string' && title.trim() ? { ...profile, agentName:title.trim(), display_name:title.trim(), description:title.trim() } : profile
  })
}

function authRequired(status: JsonObject): boolean {
  return status.auth_required === true || status.authRequired === true
}

function publicStatus(status: JsonObject): JsonObject {
  return {
    state: typeof status.overall === 'string' ? status.overall : 'unknown',
    version: typeof status.version === 'string' ? status.version : undefined,
    gatewayRunning: status.gateway_running === true || status.gatewayRunning === true,
    gatewayState: typeof status.gateway_state === 'string'
      ? status.gateway_state
      : typeof status.gatewayState === 'string' ? status.gatewayState : undefined,
  }
}

export function systemUpdateRequestAllowed(address: string, allowRemoteUpdate = false): boolean {
  if (allowRemoteUpdate) return true
  return isLoopbackHost(address.replace(/^::ffff:/, ''))
}

function localSystemUpdateAllowed(ctx: Koa.Context, dependencies: RouteDependencies): boolean {
  const address = (ctx.req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  return systemUpdateRequestAllowed(address, dependencies.config.allowRemoteUpdate)
}

function systemUpdateStatusForRequest(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  status: SystemUpdateStatus,
): SystemUpdateStatus {
  if (!status.supported || localSystemUpdateAllowed(ctx, dependencies)) return status
  return {
    ...status,
    supported: false,
    unsupportedReason: '系统升级默认只允许在本机执行；可通过服务配置显式允许远程升级',
  }
}

function requireLocalSystemUpdate(ctx: Koa.Context, dependencies: RouteDependencies): void {
  if (!localSystemUpdateAllowed(ctx, dependencies)) {
    throw new HttpError(
      403,
      '系统升级默认只允许在本机执行',
      'remote_system_update_disabled',
    )
  }
}

function updateFailure(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error)
  if (/最新版本|目标版本|正在执行|可回滚|不支持|没有可生效|已准备更新/.test(message)) {
    return new HttpError(409, message, 'system_update_conflict')
  }
  return new HttpError(502, `无法访问系统发布源：${message}`, 'system_update_source_failed')
}

async function withJar<T>(ctx: Koa.Context, run: (jar: CookieJar) => Promise<T>): Promise<T> {
  const service = ctx.state.upstreamSession as UpstreamServiceSession | undefined
  if (service) {
    await service.ensure()
    return run(service.jar)
  }
  const jar = new CookieJar(ctx.get('cookie'))
  try { return await run(jar) } finally { applyUpstreamCookies(ctx, jar) }
}

function json(ctx: Koa.Context, status: number, value: unknown): void {
  ctx.status = status
  ctx.type = 'application/json; charset=utf-8'
  ctx.body = value
}

function pushSystemStatus(dependencies: RouteDependencies): Record<string, unknown> {
  const runtime = dependencies.push.status()
  const settings = dependencies.apnsConfiguration.snapshot()
  const input = settings.input
  const apns = {
    ...runtime,
    source: settings.source,
    editable: settings.editable,
    keyFile: input?.keyFile,
    keyId: input?.keyId,
    teamId: input?.teamId,
    topic: input?.topic ?? runtime.topic,
    environments: input?.environments ?? runtime.environments,
    warnings: settings.warnings,
    ...(settings.configurationError ? { configurationError: settings.configurationError } : {}),
  }
  const fcmRuntime = dependencies.push.fcmStatus()
  const fcmSettings = dependencies.fcmConfiguration.snapshot()
  const fcmInput = fcmSettings.input
  const fcm = {
    ...fcmRuntime,
    source: fcmSettings.source,
    editable: fcmSettings.editable,
    serviceAccountFile: fcmInput?.serviceAccountFile,
    projectId: fcmInput?.projectId ?? fcmRuntime.projectId,
    packageName: fcmInput?.packageName ?? fcmRuntime.packageName,
    warnings: fcmSettings.warnings,
    ...(fcmSettings.configurationError ? { configurationError: fcmSettings.configurationError } : {}),
  }
  return { ...apns, providers: { apns, fcm } }
}

function pushRequest<T>(operation: () => T): T {
  try {
    return operation()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '推送请求无效'
    throw new HttpError(400, message, 'invalid_push_request')
  }
}

function bestEffortRemoveUserPush(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  userID: string,
): void {
  try {
    dependencies.push.removeUser(userID)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    ctx.app.emit('error', new Error(`用户权限已更新，但推送状态清理失败：${detail}`), ctx)
  }
}

async function latestGroupMessageSequence(dependencies: RouteDependencies, roomID: string, owner: string): Promise<number> {
  const room = dependencies.workspace.require<WorkspaceConversation>(owner, 'conversation', roomID)
  if (room.kind !== 'group') throw new HttpError(404,'群聊不存在','group_not_found')
  return room.lastSeq
}

function requestOrigin(ctx: Koa.Context, config: ServerConfig): string {
  const secure = ctx.secure || Boolean(config.tlsCert)
  return `${secure ? 'https' : 'http'}://${ctx.host}`
}

async function proxy(
  ctx: Koa.Context,
  upstream: UpstreamClient,
  path: string,
  options: {
    search?: URLSearchParams
    method?: string
    requestBody?: unknown
    requestHeaders?: Record<string, string>
    maxResponseBytes?: number
  } = {},
): Promise<void> {
  await withJar(ctx, async (jar) => {
    const response = await upstream.request(path, jar, {
      method: options.method,
      search: options.search,
      body: options.requestBody,
      headers: options.requestHeaders,
      maxResponseBytes: options.maxResponseBytes,
    })
    sendUpstreamResponse(ctx, response, jar)
  })
}

async function proxyAdminFeature(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  path: string,
  options: {
    search?: URLSearchParams
    method?: string
    requestBody?: unknown
  } = {},
): Promise<void> {
  dependencies.auth.requireAdmin(ctx)
  await withJar(ctx, async (jar) => {
    const response = await dependencies.upstream.request(path, jar, {
      method: options.method,
      search: options.search,
      body: options.requestBody,
    })
    if (response.status === 404 || response.status === 405) {
      throw new HttpError(501, '当前上游版本不支持此管理功能', 'upstream_feature_unsupported')
    }
    sendUpstreamResponse(ctx, response, jar)
  })
}

async function bootstrap(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  rotateCsrf = false,
  inspectOnly = false,
): Promise<void> {
  const user = dependencies.auth.current(ctx)
  const csrfToken = dependencies.csrf.issue(ctx, rotateCsrf)
  if (!user) {
    json(ctx, 200, {
      status: { state: 'ready' },
      authRequired: true,
      authenticated: false,
      setupRequired: dependencies.auth.setupRequired,
      registrationAvailable: !dependencies.auth.setupRequired,
      profiles: [],
      csrfToken,
      insecureLan: dependencies.config.insecureLan,
      groupUploadsEnabled: true,
      upstreamReady: false,
      serverKind: 'yaoyao-web',
    })
    return
  }
  let status: JsonObject = { state: user.mustChangePassword ? 'password_change_required' : inspectOnly ? 'ready' : 'degraded' }
  let profiles: unknown[] = []
  let upstreamReady = false
  let upstreamError: string | undefined
  // Desktop connection checks need only local account state. Even an existing
  // login must not acquire Hermes credentials or open its service session here.
  if (!user.mustChangePassword && !inspectOnly) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // Local login/settings must remain usable even when 9119 never responds.
      // Publish only a complete result; a late probe cannot mutate this response.
      const upstream = await Promise.race([
        (async () => {
          const statusResponse = await dependencies.upstreamSession.request('/api/status')
          const rawStatus = requireSuccess(statusResponse)
          const profilesResponse = await dependencies.upstreamSession.request('/api/profiles')

          return {
            status: publicStatus(rawStatus),
            profiles: profilesWithCoreNames(normalizedProfiles(requireSuccess(profilesResponse))),
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('9119 连接超时；仍可管理 15300 和升级 Web')), 3_000)
          timeout.unref()
        }),
      ])
      status = upstream.status
      profiles = user.role === 'admin' ? upstream.profiles : []
      upstreamReady = true
    } catch (error) {
      upstreamError = error instanceof Error ? error.message : '9119 不可用'
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  json(ctx, 200, {
    status,
    authRequired: true,
    authenticated: true,
    registrationAvailable: true,
    serverIdentity: readServerIdentity(dependencies.workspace),
    user,
    profiles,
    csrfToken,
    insecureLan: dependencies.config.insecureLan,
    groupUploadsEnabled: true,
    upstreamReady,
    upstreamError,
    serverKind: 'yaoyao-web',
  })
}

async function login(ctx: Koa.Context, dependencies: RouteDependencies): Promise<void> {
  const request = body(ctx)
  const username = typeof request.username === 'string' ? request.username.trim() : ''
  const password = typeof request.password === 'string' ? request.password : ''
  if (!username || !password || username.length > 320 || password.length > 4_096) {
    throw new HttpError(400, 'Username and password are required', 'invalid_credentials')
  }

  dependencies.auth.login(ctx, username, password, request.desktop === true)
  await bootstrap(ctx, dependencies, true)
}

async function setup(ctx: Koa.Context, dependencies: RouteDependencies): Promise<void> {
  const request = body(ctx)
  const username = typeof request.username === 'string' ? request.username : ''
  const password = typeof request.password === 'string' ? request.password : ''
  dependencies.auth.setupAdmin(ctx, username, password)
  await bootstrap(ctx, dependencies, true)
}

async function requireGatewayAuthentication(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  jar: CookieJar,
): Promise<void> {
  const status = requireSuccess(await dependencies.upstream.request('/api/status', jar))
  if (!authRequired(status)) return
  const identity = await dependencies.upstream.request('/api/auth/me', jar, {
    clientAddress: ctx.req.socket.remoteAddress,
  })
  if (identity.status === 401 || identity.status === 403) {
    throw new HttpError(401, 'Hermes authentication is required', 'authentication_required')
  }
  requireSuccess(identity)
}

function localMediaPath(root: string, relativePath: string): string {
  let resolvedRoot: string
  let resolvedFile: string
  try {
    resolvedRoot = realpathSync(root)
    resolvedFile = realpathSync(resolve(resolvedRoot, relativePath))
  } catch {
    throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
  }
  if (!resolvedFile.startsWith(`${resolvedRoot}${sep}`) || !statSync(resolvedFile).isFile()) {
    throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
  }
  return resolvedFile
}

function sendLocalMedia(ctx: Koa.Context, path: string, contentType?: string, displayName?: string): void {
  const size = statSync(path).size
  const type = contentType || mimeLookup(path) || 'application/octet-stream'
  const fileName = displayName || basename(path)
  const range = ctx.get('range').match(/^bytes=(\d*)-(\d*)$/)
  ctx.set('Accept-Ranges', 'bytes')
  ctx.set('Cache-Control', 'private, no-store')
  ctx.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  ctx.type = type
  if (!range) {
    ctx.length = size
    ctx.body = createReadStream(path)
    return
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
  const end = range[2] ? Number(range[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    ctx.status = 416
    ctx.set('Content-Range', `bytes */${size}`)
    return
  }
  const boundedEnd = Math.min(end, size - 1)
  ctx.status = 206
  ctx.set('Content-Range', `bytes ${start}-${boundedEnd}/${size}`)
  ctx.length = boundedEnd - start + 1
  ctx.body = createReadStream(path, { start, end: boundedEnd })
}

function prepareFilePreview(ctx: Koa.Context, name: string, preserveDisposition = false): void {
  const type = ctx.response.get('content-type').split(';', 1)[0]?.trim().toLowerCase()
  const activeContent = type === 'text/html'
    || type === 'application/xhtml+xml'
    || type === 'image/svg+xml'
    || Boolean(type?.endsWith('/xml') || type?.endsWith('+xml'))
  if (activeContent) {
    ctx.type = 'application/octet-stream'
    ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  } else if (!preserveDisposition) {
    ctx.remove('Content-Disposition')
  }
}

function hermesMediaPath(ctx: Koa.Context, rootDirectory = 'cache'): string {
  const segment = (value: string): string => {
    if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) {
      throw new HttpError(400, '媒体路径无效', 'invalid_media_path')
    }
    return value
  }
  const owner = segment(ctx.params.owner)
  const profile = ctx.params.profile ? segment(ctx.params.profile) : undefined
  const directory = profile ? ctx.params.mediaDir : rootDirectory
  if (!['cache', 'images', 'screenshots', 'attachments', 'workspace'].includes(directory)) {
    throw new HttpError(404, '媒体目录不存在', 'media_not_found')
  }
  const raw = ctx.params.filePath
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(part => part.split('/')).map(segment)
  return `/Users/${owner}/.hermes/${profile ? `profiles/${profile}/` : ''}${directory}/${parts.join('/')}`
}

async function proxyHermesMedia(ctx: Koa.Context, dependencies: RouteDependencies, rootDirectory = 'cache'): Promise<void> {
  dependencies.auth.require(ctx)
  const path = await authorizeFileRead(dependencies.config, dependencies.upstreamSession, hermesMediaPath(ctx, rootDirectory), ctx.params.profile || String(ctx.query.profile || ctx.get('x-hermes-profile') || 'default'))
  // Generated media belongs to Hermes, which may run on a different machine
  // or inside a container. Let its file API enforce the managed-root policy.
  const response = await dependencies.upstreamSession.request('/api/files/download', {
    search: new URLSearchParams({ path }),
    headers: ctx.get('range') ? { range: ctx.get('range') } : undefined,
    maxResponseBytes: 100 * 1_024 * 1_024,
  })
  sendUpstreamResponse(ctx, response, dependencies.upstreamSession.jar)
  ctx.set('Cache-Control', 'private, no-store')
  if (response.status >= 200 && response.status < 300) prepareFilePreview(ctx, basename(path))
}

export function createApiRouter(dependencies: RouteDependencies): Router {
  const router = new Router()
  const registrations = new RegistrationLimiter()
  const fileReadRequest = (ctx: Koa.Context, path: string) => ['GET', 'HEAD'].includes(ctx.method)
    && /^\/api\/(?:files(?:\/[^/]+)?|fs\/[^/]+|media|hermes\/download)$/.test(path)
  const authorizeFileQuery = async (ctx: Koa.Context, route: string, host: Pick<UpstreamServiceSession, 'request'> = dependencies.upstreamSession) => {
    const profile = String(ctx.query.profile || ctx.get('x-hermes-profile') || 'default')
    const directoryRequest = ['/api/files', '/api/fs/list', '/api/fs/git-root'].includes(route)
    const rawPath = ctx.query.path || (directoryRequest ? await fileAccessWorkingDirectory(host, profile) : undefined)
    if (typeof rawPath === 'string') {
      const path = await authorizeFileRead(dependencies.config, host, rawPath, profile, directoryRequest)
      const search = new URLSearchParams(ctx.querystring)
      search.set('path', path)
      search.set('profile', profile)
      ctx.querystring = search.toString()
    }
  }
  router.use(async (ctx, next) => {
    if (fileReadRequest(ctx, ctx.path)) {
      dependencies.auth.require(ctx)
      await authorizeFileQuery(ctx, ctx.path)
    }
    await next()
  })
  router.get('/api/app/settings/file-access', async ctx => {
    dependencies.auth.require(ctx)
    const settings = readFileAccess(dependencies.config.home)
    const profile = String(ctx.query.profile || ctx.get('x-hermes-profile') || 'default')
    try { json(ctx, 200, { ...settings, profile, workingDirectory: await fileAccessWorkingDirectory(dependencies.upstreamSession, profile) }) }
    catch (error) { json(ctx, 200, { ...settings, profile, workingDirectory: null, cwdError: error instanceof Error ? error.message : '无法读取工作目录' }) }
  })
  router.put('/api/app/settings/file-access', ctx => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, saveFileAccess(dependencies.config.home, body(ctx)))
  })
  router.get('/api/app/settings/host-tools', ctx => {
    const user = dependencies.auth.require(ctx), settings = readHostTools(dependencies.config.home)
    const supported = vmSupported(dependencies.config.home), licensed = dependencies.auth.canUseVm(user.id)
    // Administrators see the global switch; everyone else sees whether they may use a VM.
    json(ctx, 200, { ...settings, vm: user.role === 'admin' ? settings.vm : settings.vm && licensed, vmSupported: supported, vmLicensed: licensed })
  })
  router.put('/api/app/settings/host-tools', ctx => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, saveHostTools(dependencies.config.home, body(ctx)))
  })


  router.get('/healthz', (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    json(ctx, 200, { ok: true })
  })

  // Hermes Gateway-compatible authentication surface for native clients.
  // Content requests are still executed through the server-owned 9119 session.
  router.get('/api/status', (ctx) => {
    json(ctx, 200, {
      overall: 'ready',
      auth_required: true,
      gateway_running: true,
      server_kind: 'yaoyao-web',
      node_transport: '15300',
    })
  })
  router.get('/api/auth/providers', (ctx) => {
    json(ctx, 200, { providers: [{ name: 'basic', supports_password: true }] })
  })
  router.post('/auth/password-login', async (ctx) => {
    const request = body(ctx)
    const username = typeof request.username === 'string' ? request.username : ''
    const password = typeof request.password === 'string' ? request.password : ''
    const user = dependencies.auth.login(ctx, username, password)
    json(ctx, 200, { ok: true, must_change_password: user.mustChangePassword, server_kind: 'yaoyao-web' })
  })
  router.post('/auth/logout', (ctx) => {
    dependencies.auth.logout(ctx)
    json(ctx, 200, { ok: true })
  })
  router.get('/api/auth/me', (ctx) => {
    const user = dependencies.auth.require(ctx, true)
    json(ctx, 200, {
      user_id: user.id,
      display_name: user.username,
      username: user.username,
      avatar: user.avatar,
      provider: 'yaoyao-local',
      role: user.role,
      must_change_password: user.mustChangePassword,
      server_kind: 'yaoyao-web',
    })
  })
  router.get('/api/profile-identities', async (ctx) => {
    dependencies.auth.require(ctx, true)
    json(ctx, 200, { profiles: await dependencies.profileIdentities.load() })
  })
  router.get('/api/profiles', async (ctx) => {
    if (dependencies.auth.require(ctx, true).role !== 'admin') { json(ctx, 200, { profiles: [] }); return }
    const profilesResponse = await dependencies.upstreamSession.request('/api/profiles')

    json(ctx, profilesResponse.status, {
      profiles: profilesWithCoreNames(normalizedProfiles(requireSuccess(profilesResponse))),
    })
  })
  router.get('/api/push/v1/capabilities', (ctx) => {
    dependencies.auth.require(ctx)
    const capabilities = dependencies.push.capabilities()
    json(ctx, 200, {
      ...capabilities,
      maximumSummaryCharacters: capabilities.maxSummaryCharacters,
    })
  })
  router.put('/api/push/v1/installations/:installationID/accounts/:clientAccountID', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    const platform = request.platform === undefined || request.platform === 'ios' ? 'ios'
      : request.platform === 'android' ? 'android' : undefined
    if (!platform) {
      throw new HttpError(400, 'platform must be ios or android', 'invalid_push_request')
    }
    if (platform === 'ios' && request.environment !== 'development' && request.environment !== 'production') {
      throw new HttpError(400, 'environment must be development or production', 'invalid_push_request')
    }
    const common = {
      userId: user.id,
      installationId: canonicalUUID(ctx.params.installationID, 'installation ID'),
      clientAccountId: canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
      appVersion: typeof request.appVersion === 'string' ? request.appVersion : undefined,
      authorizationVersion: dependencies.auth.pushAuthorizationVersion(user.id),
    }
    const installation = platform === 'android'
      ? pushRequest(() => dependencies.push.registerInstallation({
          ...common,
          platform: 'android',
          fid: typeof request.fid === 'string' ? request.fid : '',
        }))
      : pushRequest(() => dependencies.push.registerInstallation({
          ...common,
          platform: 'ios',
          deviceToken: typeof request.token === 'string'
            ? request.token
            : typeof request.deviceToken === 'string' ? request.deviceToken : '',
          environment: request.environment as 'development' | 'production',
        }))
    json(ctx, 200, { installation })
  })
  router.delete('/api/push/v1/installations/:installationID/accounts/:clientAccountID', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const removed = pushRequest(() => dependencies.push.unregisterInstallation(
      user.id,
      canonicalUUID(ctx.params.installationID, 'installation ID'),
      canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
    ))
    json(ctx, 200, { ok: true, removed })
  })
  router.post('/api/push/v1/installations/:installationID/accounts/:clientAccountID/badge-reset', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const badge = pushRequest(() => dependencies.push.resetBadge(
      user.id,
      canonicalUUID(ctx.params.installationID, 'installation ID'),
      canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
    ))
    json(ctx, 200, { badge })
  })
  router.get('/api/push/v1/group-subscriptions', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const subscriptions = dependencies.push.listGroupSubscriptions(user.id).filter(s => dependencies.workspace.get<WorkspaceConversation>(user.id,'conversation',s.roomId)?.kind === 'group')
    json(ctx, 200, {
      subscriptions,
      roomIds: subscriptions.filter(item => item.enabled).map(item => item.roomId),
    })
  })
  router.put('/api/push/v1/group-subscriptions/:roomID', async (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    if (typeof request.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean', 'invalid_push_request')
    }
    const enabled = request.enabled
    const roomID = canonicalUUID(ctx.params.roomID, 'room ID')
    const baseline = enabled ? await latestGroupMessageSequence(dependencies, roomID, user.id) : undefined
    const subscription = pushRequest(() => dependencies.push.setGroupSubscription(
      user.id,
      roomID,
      enabled,
      baseline,
    ))
    json(ctx, 200, { subscription, enabled: subscription.enabled })
  })
  // Browser aliases stay inside the /api/app CSRF boundary. Native iOS uses
  // the Gateway-compatible /api/push/v1 surface with the same account state.
  router.get('/api/app/push/v1/capabilities', (ctx) => {
    dependencies.auth.require(ctx)
    const capabilities = dependencies.push.capabilities()
    json(ctx, 200, {
      ...capabilities,
      maximumSummaryCharacters: capabilities.maxSummaryCharacters,
    })
  })
  router.get('/api/app/push/v1/group-subscriptions', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const subscriptions = dependencies.push.listGroupSubscriptions(user.id).filter(s => dependencies.workspace.get<WorkspaceConversation>(user.id,'conversation',s.roomId)?.kind === 'group')
    json(ctx, 200, {
      subscriptions,
      roomIds: subscriptions.filter(item => item.enabled).map(item => item.roomId),
    })
  })
  router.put('/api/app/push/v1/group-subscriptions/:roomID', async (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    if (typeof request.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean', 'invalid_push_request')
    }
    const enabled = request.enabled
    const roomID = canonicalUUID(ctx.params.roomID, 'room ID')
    const baseline = enabled ? await latestGroupMessageSequence(dependencies, roomID, user.id) : undefined
    const subscription = pushRequest(() => dependencies.push.setGroupSubscription(
      user.id,
      roomID,
      enabled,
      baseline,
    ))
    json(ctx, 200, { subscription, enabled: subscription.enabled })
  })
  router.put('/api/account/credentials', (ctx) => {
    const request = body(ctx)
    const currentPassword = typeof request.currentPassword === 'string' ? request.currentPassword : ''
    const newPassword = typeof request.newPassword === 'string' ? request.newPassword : ''
    // Usernames are not changed from the Web; administrators rename themselves in the admin console.
    const user = dependencies.auth.changeCredentials(ctx, currentPassword, newPassword)
    json(ctx, 200, { user, must_change_password: false, server_kind: 'yaoyao-web' })
  })
  router.post('/api/app/account-pairings', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const pairing = dependencies.accountPairings.create(user.id)
    const origin = requestOrigin(ctx, dependencies.config)
    const deepLink = new URL('yaoyao://login')
    deepLink.searchParams.set('v', '1')
    deepLink.searchParams.set('url', origin)
    deepLink.searchParams.set('id', pairing.id)
    deepLink.searchParams.set('secret', pairing.secret)
    json(ctx, 201, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      pairingId: pairing.id,
      expiresAt: pairing.expiresAt,
      qrPayload: deepLink.toString(),
    })
  })
  router.get('/api/app/account-pairings/:pairingID', (ctx) => {
    dependencies.auth.require(ctx)
    json(ctx, 200, dependencies.accountPairings.status(ctx.params.pairingID))
  })
  router.get('/api/account-pair/v1/capabilities', (ctx) => {
    json(ctx, 200, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      feature: 'server-login',
    })
  })
  router.post('/api/account-pair/v1/claim', (ctx) => {
    const request = body(ctx)
    const pairingID = typeof request.pairingId === 'string' ? request.pairingId : ''
    const secret = typeof request.secret === 'string' ? request.secret : ''
    const userID = dependencies.accountPairings.claim(pairingID, secret)
    const user = dependencies.auth.issueSession(ctx, userID)
    json(ctx, 201, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      serverUrl: requestOrigin(ctx, dependencies.config),
      user,
    })
  })

  // Keep the original URL usable by inline Markdown, the lightbox and downloads.
  // These root/profile cache paths are not files on the Web server itself.
  router.get('/Users/:owner/.hermes/cache/*filePath', ctx => proxyHermesMedia(ctx, dependencies))
  router.get('/Users/:owner/.hermes/workspace/*filePath', ctx => proxyHermesMedia(ctx, dependencies, 'workspace'))
  router.get('/Users/:owner/.hermes/profiles/:profile/:mediaDir/*filePath', ctx => proxyHermesMedia(ctx, dependencies))

  // Historical messages can contain Markdown links such as
  // /Users/<owner>/Agents/<path>. Map only the configured media root, never
  // an arbitrary local filesystem path.
  router.get('/Users/:owner/Agents/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地媒体只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      const path = await authorizeFileRead(dependencies.config, dependencies.upstreamSession, localMediaPath(dependencies.config.mediaRoot, filePath))
      sendLocalMedia(ctx, path)
      prepareFilePreview(ctx, basename(path), true)
    })
  })
  router.get('/Users/:owner/.hermes/attachments/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地附件只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地附件不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      const path = await authorizeFileRead(dependencies.config, dependencies.upstreamSession, localMediaPath(dependencies.config.attachmentsRoot, filePath))
      sendLocalMedia(ctx, path)
      prepareFilePreview(ctx, basename(path), true)
    })
  })
  router.get('/Users/:owner/.hermes/images/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地图片只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地图片不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      const path = await authorizeFileRead(dependencies.config, dependencies.upstreamSession, localMediaPath(dependencies.config.imagesRoot, filePath))
      sendLocalMedia(ctx, path)
      prepareFilePreview(ctx, basename(path), true)
    })
  })
  router.get('/attachments/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地附件只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      const path = await authorizeFileRead(dependencies.config, dependencies.upstreamSession, localMediaPath(dependencies.config.attachmentsRoot, filePath), String(ctx.query.profile || ctx.get('x-hermes-profile') || 'default'))
      sendLocalMedia(ctx, path)
      prepareFilePreview(ctx, basename(path), true)
    })
  })
  router.get('/readyz', async (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    try {
      const response = await dependencies.upstream.request(
        '/api/status',
        new CookieJar(''),
        { maxResponseBytes: 2 * 1_024 * 1_024 },
      )
      const reachable = response.status >= 200 && response.status < 500
      json(ctx, reachable ? 200 : 503, {
        ok: reachable,
        upstream: reachable ? 'reachable' : 'unavailable',
      })
    } catch {
      json(ctx, 503, { ok: false, upstream: 'unavailable' })
    }
  })

  router.get('/api/app/bootstrap', async (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    if (ctx.query.csrfOnly === '1') {
      json(ctx, 200, {
        csrfToken: dependencies.csrf.issue(ctx),
        userId: dependencies.auth.current(ctx)?.id ?? null,
      })
      return
    }
    await bootstrap(ctx, dependencies, false, ctx.query.inspectOnly === '1')
  })
  router.post('/api/app/setup', async (ctx) => {
    await setup(ctx, dependencies)
  })
  router.post('/api/app/login', async (ctx) => {
    await login(ctx, dependencies)
  })
  router.post('/api/app/desktop-session', async ctx => {
    dependencies.auth.persistDesktopSession(ctx)
    await bootstrap(ctx, dependencies, true, true)
  })
  router.post('/api/app/register', ctx => {
    const retry = registrations.take(ctx.req.socket.remoteAddress ?? 'unknown')
    if (retry) {
      ctx.set('Retry-After', String(retry))
      throw new HttpError(429, '注册请求过于频繁，请稍后重试。', 'registration_rate_limited')
    }
    const request = body(ctx)
    if (Object.keys(request).some(key => !['username', 'password'].includes(key)) || typeof request.username !== 'string' || typeof request.password !== 'string')
      throw new HttpError(400, '请填写用户名和密码', 'invalid_registration')
    dependencies.auth.register(request.username, request.password)
    json(ctx, 201, { registrationStatus: 'pending', message: '注册成功，请等待管理员开通。' })
  })
  router.post('/api/app/logout', async (ctx) => {
    dependencies.auth.logout(ctx)
    json(ctx, 200, { ok: true, csrfToken: dependencies.csrf.issue(ctx, true) })
  })
  router.put('/api/app/account/credentials', async (ctx) => {
    const request = body(ctx)
    const currentPassword = typeof request.currentPassword === 'string' ? request.currentPassword : ''
    const newPassword = typeof request.newPassword === 'string' ? request.newPassword : ''
    // Usernames are not changed from the Web; administrators rename themselves in the admin console.
    const user = dependencies.auth.changeCredentials(ctx, currentPassword, newPassword)
    json(ctx, 200, { user, mustChangePassword: false, csrfToken: dependencies.csrf.issue(ctx, true) })
  })
  router.put('/api/app/account/avatar', (ctx) => {
    const request = body(ctx)
    const user = dependencies.auth.setAvatar(ctx, request.avatar)
    json(ctx, 200, { user })
  })
  router.get('/api/app/admin/users', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, { items: dependencies.auth.list(admin) })
  })
  router.post('/api/app/admin/users', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const username = typeof request.username === 'string' ? request.username : ''
    const password = typeof request.password === 'string' ? request.password : ''
    json(ctx, 201, dependencies.auth.create(admin, username, password, request.vmLicensed === true))
  })
  router.post('/api/app/admin/users/:userID/approve', ctx => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const userID = canonicalUUID(ctx.params.userID, 'user ID'), request = body(ctx)
    // Older clients still send a profile list; there is a single Hermes profile, so it is ignored.
    if (Object.keys(request).some(key => key !== 'assignedProfiles')) throw new HttpError(400, '开通参数无效', 'invalid_approval')
    json(ctx, 200, dependencies.auth.approve(admin, userID))
  })
  router.patch('/api/app/admin/users/:userID', async (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const userID = canonicalUUID(ctx.params.userID, 'user ID')
    const updated = dependencies.auth.updateUser(admin, userID, {
      enabled: typeof request.enabled === 'boolean' ? request.enabled : undefined,
      password: typeof request.password === 'string' ? request.password : undefined,
      vmLicensed: typeof request.vmLicensed === 'boolean' ? request.vmLicensed : undefined,
    })
    await dependencies.onUserAccessChanged?.(userID)
    if (request.enabled === false || typeof request.password === 'string') {
      bestEffortRemoveUserPush(ctx, dependencies, userID)
    }
    json(ctx, 200, updated)
  })
  router.delete('/api/app/admin/users/:userID', async (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const userID = canonicalUUID(ctx.params.userID, 'user ID')
    dependencies.auth.deleteUser(admin, userID)
    await dependencies.onUserAccessChanged?.(userID)
    bestEffortRemoveUserPush(ctx, dependencies, userID)
    json(ctx, 200, { ok: true })
  })
  router.get('/api/app/admin/upstream-connection', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    // Embedded Hermes: readiness is the installed kernel, not a remote 9119 session.
    let ready = true, error: string | undefined
    try { const paths = kernelPaths(); requireKernel(paths, paths.worker) } catch (cause) { ready = false; error = cause instanceof Error ? cause.message : '内置 Hermes 内核不可用' }
    json(ctx, 200, {
      endpoint: 'embedded', authMode: 'embedded', networkScope: 'local', ready, error, lastVerifiedAt: Date.now(),
      version: '0.23.0', hermesHome: dependencies.hermes?.home,
      webNetworkScope: isLoopbackHost(dependencies.config.host) ? 'local' : 'network',
    })
  })
  router.get('/api/app/admin/model-services', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints', {
      search: searchFrom(ctx, ['profile']),
    })
  })
  router.put('/api/app/admin/profiles/:profileName/model', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const profileName = safeIdentifier(ctx.params.profileName, 'profile name')
    const request = body(ctx)
    const provider = typeof request.provider === 'string' ? request.provider.trim() : ''
    const model = typeof request.model === 'string' ? request.model.trim() : ''
    if (!provider || !model) {
      throw new HttpError(400, 'Provider 和模型不能为空', 'invalid_profile_model')
    }
    await proxyAdminFeature(
      ctx,
      dependencies,
      `/api/profiles/${encodeURIComponent(profileName)}/model`,
      { method: 'PUT', requestBody: { provider, model } },
    )
  })
  router.post('/api/app/admin/model-services', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints', {
      method: 'POST', search: searchFrom(ctx, ['profile']), requestBody: body(ctx),
    })
  })
  router.post('/api/app/admin/model-services/validate', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints/validate', {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.post('/api/app/admin/model-services/:serviceID/activate', async (ctx) => {
    const id = safeIdentifier(ctx.params.serviceID, 'model service ID')
    await proxyAdminFeature(ctx, dependencies, `/api/providers/custom-endpoints/${encodeURIComponent(id)}/activate`, {
      method: 'POST', search: searchFrom(ctx, ['profile']), requestBody: optionalBody(ctx) ?? {},
    })
  })
  router.delete('/api/app/admin/model-services/:serviceID', async (ctx) => {
    const id = safeIdentifier(ctx.params.serviceID, 'model service ID')
    await proxyAdminFeature(ctx, dependencies, `/api/providers/custom-endpoints/${encodeURIComponent(id)}`, {
      method: 'DELETE', search: searchFrom(ctx, ['profile']),
    })
  })
  registerHermesAdminRoutes(router, dependencies)
  router.get('/api/app/admin/legacy-model-services', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      const search = searchFrom(ctx, ['profile'])
      const [configResponse, optionsResponse] = await Promise.all([
        dependencies.upstream.request('/api/config', jar, { search }),
        dependencies.upstream.request('/api/model/options', jar, {
          search: new URLSearchParams([...search, ['explicit_only', 'true']]),
        }),
      ])
      if ([configResponse.status, optionsResponse.status].some(status => status === 404 || status === 405)) {
        throw new HttpError(501, '当前上游版本不支持旧版模型服务管理', 'upstream_feature_unsupported')
      }
      const config = requireSuccess(configResponse)
      const options = requireSuccess(optionsResponse)
      const currentProvider = typeof options.provider === 'string' ? options.provider.toLocaleLowerCase() : ''
      const entries = Array.isArray(config.custom_providers) ? config.custom_providers : []
      const items = entries.flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const entry = raw as JsonObject
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        const baseURL = typeof entry.base_url === 'string' ? entry.base_url.trim() : ''
        const model = typeof entry.model === 'string' ? entry.model.trim() : ''
        if (!name || !baseURL || !model) return []
        const rawModels = entry.models
        const models = Array.isArray(rawModels)
          ? rawModels.map(String).map(value => value.trim()).filter(Boolean)
          : rawModels && typeof rawModels === 'object'
            ? Object.keys(rawModels).filter(value => !value.startsWith('__'))
            : [model]
        const modelConfig = rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)
          ? (rawModels as JsonObject)[model]
          : undefined
        const contextLength = typeof entry.context_length === 'number' ? entry.context_length
          : modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)
            && typeof (modelConfig as JsonObject).context_length === 'number'
            ? (modelConfig as JsonObject).context_length as number
            : undefined
        const id = `custom:${name}`
        return [{
          id, name, base_url: baseURL, model, models: [...new Set([...models, model])],
          ...(contextLength ? { context_length: contextLength } : {}),
          discover_models: entry.models_discovered === true,
          has_api_key: Boolean(entry.key_env || entry.api_key),
          can_edit_api_key: typeof entry.key_env === 'string' && Boolean(entry.key_env.trim()),
          is_current: currentProvider === id.toLocaleLowerCase(),
          source: 'legacy',
        }]
      })
      json(ctx, 200, { items })
    })
  })
  router.put('/api/app/admin/legacy-model-services/:serviceID', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const serviceID = safeIdentifier(ctx.params.serviceID, 'legacy model service ID')
    const request = body(ctx)
    const baseURL = typeof request.base_url === 'string' ? request.base_url.trim().replace(/\/$/, '') : ''
    const model = typeof request.model === 'string' ? request.model.trim() : ''
    const models = Array.isArray(request.models)
      ? [...new Set(request.models.map(String).map(value => value.trim()).filter(Boolean))]
      : []
    if (!/^https?:\/\//i.test(baseURL)) throw new HttpError(400, 'Base URL 必须使用 http 或 https', 'invalid_model_service')
    if (!model) throw new HttpError(400, '默认模型不能为空', 'invalid_model_service')
    if (!models.includes(model)) models.push(model)
    const contextLength = typeof request.context_length === 'number' && Number.isInteger(request.context_length) && request.context_length > 0
      ? request.context_length : undefined
    await withJar(ctx, async (jar) => {
      const search = searchFrom(ctx, ['profile'])
      const [configResponse, optionsResponse] = await Promise.all([
        dependencies.upstream.request('/api/config', jar, { search }),
        dependencies.upstream.request('/api/model/options', jar, {
          search: new URLSearchParams([...search, ['explicit_only', 'true']]),
        }),
      ])
      const config = requireSuccess(configResponse)
      const options = requireSuccess(optionsResponse)
      const providers = Array.isArray(config.custom_providers) ? [...config.custom_providers] : []
      const index = providers.findIndex(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
        const name = typeof (raw as JsonObject).name === 'string' ? String((raw as JsonObject).name) : ''
        return `custom:${name}`.toLocaleLowerCase() === serviceID.toLocaleLowerCase()
      })
      if (index < 0) throw new HttpError(404, '旧版模型服务不存在', 'model_service_not_found')
      const current = providers[index] as JsonObject
      const existingModels = current.models && typeof current.models === 'object' && !Array.isArray(current.models)
        ? current.models as JsonObject : {}
      const nextModels = Object.fromEntries(models.map(id => {
        const previous = existingModels[id]
        const metadata: JsonObject = previous && typeof previous === 'object' && !Array.isArray(previous)
          ? { ...previous as JsonObject } : {}
        if (id === model && contextLength) metadata.context_length = contextLength
        return [id, metadata]
      }))
      providers[index] = {
        ...current,
        base_url: baseURL,
        model,
        models: nextModels,
        models_discovered: request.discover_models === true,
        ...(contextLength ? { context_length: contextLength } : {}),
      }
      requireSuccess(await dependencies.upstream.request('/api/config', jar, {
        method: 'PUT', search, body: { config: { custom_providers: providers }, profile: search.get('profile') || undefined },
      }))
      if (Object.prototype.hasOwnProperty.call(request, 'api_key')) {
        const keyEnvironment = typeof current.key_env === 'string' ? current.key_env.trim() : ''
        if (!keyEnvironment) throw new HttpError(409, '该旧版服务没有可管理的密钥变量', 'model_service_key_unmanaged')
        const apiKey = typeof request.api_key === 'string' ? request.api_key.trim() : ''
        requireSuccess(await dependencies.upstream.request('/api/env', jar, {
          method: apiKey ? 'PUT' : 'DELETE', search,
          body: apiKey ? { key: keyEnvironment, value: apiKey, profile: search.get('profile') || undefined }
            : { key: keyEnvironment, profile: search.get('profile') || undefined },
        }))
      }
      const currentProvider = typeof options.provider === 'string' ? options.provider.toLocaleLowerCase() : ''
      if (currentProvider === serviceID.toLocaleLowerCase()) {
        requireSuccess(await dependencies.upstream.request('/api/model/set', jar, {
          method: 'POST', search,
          body: { scope: 'main', provider: serviceID, model, base_url: baseURL, confirm_expensive_model: true, profile: search.get('profile') || undefined },
        }))
      }
      json(ctx, 200, { ok: true })
    })
  })
  router.get('/api/app/system/update/status', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    // No upstream calls, including best-effort plugin probes: a stalled 9119
    // must not delay or prevent access to the independent Web updater.
    json(ctx, 200, systemUpdateStatusForRequest(ctx, dependencies, dependencies.updates.status()))
  })
  router.get('/api/app/system/push-status', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.get('/api/app/admin/openviking', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, dependencies.openVikingConfiguration.snapshot())
  })
  router.get('/api/app/admin/openviking/session-sync', ctx => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, dependencies.openVikingSessionSync.status())
  })
  router.post('/api/app/admin/openviking/session-sync/retry', ctx => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, dependencies.openVikingSessionSync.retry())
  })
  router.put('/api/app/admin/openviking', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const snapshot = await dependencies.openVikingConfiguration.update({
      enabled: request.enabled === true,
      url: typeof request.url === 'string' ? request.url : '',
      accountId: typeof request.accountId === 'string' ? request.accountId : '',
      ...(typeof request.adminKey === 'string' && request.adminKey.trim() ? { adminKey: request.adminKey } : {}),
    }, config => dependencies.openVikingService.configure(config))
    json(ctx, 200, snapshot)
  })
  router.get('/api/app/server-identity', (ctx) => {
    dependencies.auth.require(ctx)
    ctx.set('Cache-Control', 'no-store')
    json(ctx, 200, readServerIdentity(dependencies.workspace))
  })
  router.put('/api/app/server-identity', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const identity = updateServerIdentity(dependencies.workspace, body(ctx))
    dependencies.onServerIdentityChanged?.(identity)
    json(ctx, 200, identity)
  })
  router.get('/api/app/system/allowed-hosts', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, dependencies.allowedHostsConfiguration.snapshot())
  })
  router.put('/api/app/system/allowed-hosts', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    if (!Array.isArray(request.hosts) || request.hosts.some(host => typeof host !== 'string')) {
      throw new HttpError(400, 'hosts 必须是域名或 IP 数组', 'invalid_allowed_hosts')
    }
    const requestedHosts = canonicalAllowedHosts(request.hosts as string[])
    const currentHost = normalizeAllowedHost(ctx.hostname)
    const environmentHosts = dependencies.allowedHostsConfiguration.snapshot().environmentHosts
    if (!isPrivateHost(currentHost) && !new Set([...environmentHosts, ...requestedHosts]).has(currentHost)) {
      throw new HttpError(409, `不能移除当前正在使用的访问地址 ${currentHost}`, 'current_host_required')
    }
    json(ctx, 200, dependencies.allowedHostsConfiguration.update(requestedHosts))
  })
  router.put('/api/app/system/push-config', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const input: Partial<APNsConfigurationInput> = {
      keyFile: typeof request.keyFile === 'string' ? request.keyFile : '',
      keyId: typeof request.keyId === 'string' ? request.keyId : '',
      teamId: typeof request.teamId === 'string' ? request.teamId : '',
      topic: typeof request.topic === 'string' ? request.topic : '',
      environments: Array.isArray(request.environments) ? request.environments as APNsConfigurationInput['environments'] : [],
    }
    await dependencies.apnsConfiguration.update(input, async config => {
      await dependencies.push.configureAPNs(config)
    })
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.put('/api/app/system/push-config/fcm', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const input: Partial<FCMConfigurationInput> = {
      serviceAccountFile: typeof request.serviceAccountFile === 'string' ? request.serviceAccountFile : '',
      projectId: typeof request.projectId === 'string' ? request.projectId : '',
      packageName: typeof request.packageName === 'string' ? request.packageName : '',
    }
    await dependencies.fcmConfiguration.update(input, async config => {
      await dependencies.push.configureFCM(config)
    })
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.post('/api/app/system/update/check', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    try {
      json(ctx, 200, systemUpdateStatusForRequest(ctx, dependencies, await dependencies.updates.check()))
    } catch (error) {
      throw updateFailure(error)
    }
  })
  router.post('/api/app/system/update/apply', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    requireLocalSystemUpdate(ctx, dependencies)
    const request = body(ctx)
    const targetVersion = typeof request.targetVersion === 'string' ? request.targetVersion.trim() : ''
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
      throw new HttpError(400, 'targetVersion 必须是有效的发布版本', 'invalid_request')
    }
    try {
      json(ctx, 202, await dependencies.updates.startUpdate(targetVersion))
    } catch (error) {
      throw updateFailure(error)
    }
  })
  router.post('/api/app/system/update/activate', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    requireLocalSystemUpdate(ctx, dependencies)
    const jobID = body(ctx).jobID
    if (typeof jobID !== 'string' || !/^[0-9a-f-]{36}$/.test(jobID)) throw new HttpError(400, 'jobID 无效', 'invalid_request')
    try { json(ctx, 202, dependencies.updates.startActivation(jobID)) }
    catch (error) { throw updateFailure(error) }
  })
  router.get('/api/app/system/update/jobs/:jobID', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const job = dependencies.updates.job(ctx.params.jobID)
    if (!job) throw new HttpError(404, '升级任务不存在', 'system_update_job_not_found')
    json(ctx, 200, job)
  })
  router.post('/api/app/system/update/rollback', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    requireLocalSystemUpdate(ctx, dependencies)
    try {
      json(ctx, 202, dependencies.updates.startRollback())
    } catch (error) {
      throw updateFailure(error)
    }
  })
  router.get('/api/app/profiles', async (ctx) => {
    await withJar(ctx, async (jar) => {
      const profilesResponse = await dependencies.upstream.request('/api/profiles', jar)
      if (profilesResponse.status < 200 || profilesResponse.status >= 300) {
        sendUpstreamResponse(ctx, profilesResponse, jar)
        return
      }

      const profiles = profilesWithCoreNames(normalizedProfiles(parseJson(profilesResponse)))
      json(ctx, 200, { profiles })
    })
  })
  router.get('/api/app/models', async (ctx) => {
    const search = searchFrom(ctx, ['profile'])
    search.set('explicit_only', 'true')
    await proxy(ctx, dependencies.upstream, '/api/model/options', { search })
  })
  const unreadInput=z.object({items:z.array(z.object({mode:z.enum(['bot','chat']),id:z.string().min(1).max(256),profile:z.string().max(256).optional(),messages:z.array(z.object({id:z.string().min(1).max(512),seq:z.number().int().nonnegative(),version:z.number().int().nonnegative().optional(),taskId:z.string().max(256).optional()}).strict()).max(20000)}).strict()).max(1000)}).strict()
  router.get('/api/app/unread',ctx=>{
    const owner=dependencies.auth.require(ctx).id
    ctx.set('Cache-Control','no-store')
    ctx.body=unreadSnapshot(dependencies.workspace,owner,(node,profile)=>dependencies.auth.canUseSource(owner,node,profile))
  })
  router.post('/api/app/unread/read',ctx=>{
    const owner=dependencies.auth.require(ctx).id,input=unreadInput.safeParse(body(ctx))
    if(!input.success)throw new HttpError(400,'未读快照格式无效','invalid_unread_snapshot')
    acknowledgeUnread(dependencies.workspace,owner,input.data.items,(node,profile)=>dependencies.auth.canUseSource(owner,node,profile))
    ctx.body=unreadSnapshot(dependencies.workspace,owner,(node,profile)=>dependencies.auth.canUseSource(owner,node,profile))
  })
  router.get('/api/files/download', async ctx => {
    dependencies.auth.require(ctx)
    const path = typeof ctx.query.path === 'string' ? ctx.query.path : ''
    if (!path) throw new HttpError(400, 'path is required', 'missing_path')
    const response = await dependencies.upstreamSession.request('/api/files/download', {
      search: new URLSearchParams({ path }),
      headers: ctx.get('range') ? { range: ctx.get('range') } : undefined,
      maxResponseBytes: 100 * 1_024 * 1_024,
    })
    sendUpstreamResponse(ctx, response, dependencies.upstreamSession.jar)
    ctx.set('Cache-Control', 'private, no-store')
    ctx.set('X-Content-Type-Options', 'nosniff')
    if (response.status >= 200 && response.status < 300 && ctx.query.preview === '1') prepareFilePreview(ctx, basename(path))
  })

  return router
}

export function incomingCookieNames(ctx: Koa.Context): string[] {
  return Object.keys(parse(ctx.get('cookie')))
}
