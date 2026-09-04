import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import { bodyParser } from '@koa/bodyparser'
import Koa from 'koa'
import { RealtimeAPI } from './realtimeApi.js'
import type { ServerConfig } from './config.js'
import { loadServerConfig } from './config.js'
import { errorMessage, HttpError } from './errors.js'
import { NodePairingStore } from './pairing.js'
import { LocalAuthStore, UpstreamServiceSession } from './localAuth.js'
import { AccountLoginPairingStore } from './accountPairing.js'
import { UpstreamProfileIdentityService } from './profileIdentities.js'
import { createApiRouter } from './routes.js'
import {
  applySecurityHeaders,
  CsrfProtection,
  isAllowedHostHeader,
  isExactOrigin,
} from './security.js'
import { UpstreamHttpError, UpstreamClient } from './upstream.js'
import { UploadStore } from './uploads.js'
import { WorkspaceStore } from './workspaceStore.js'
import { WorkspaceNodes } from './workspaceGateway.js'
import { WorkspaceRuntime } from './workspaceRuntime.js'
import { WorkspaceAssets } from './workspaceAssets.js'
import { workspaceRouter } from './workspaceRoutes.js'
import { SystemUpdateManager } from './updateManager.js'
import { PushCoordinator } from './pushCoordinator.js'
import {
  APNsConfigurationManager,
  type APNsConfigurationSnapshot,
} from './apnsConfiguration.js'
import {
  FCMConfigurationManager,
  type FCMConfigurationSnapshot,
} from './fcmConfiguration.js'
import { PushCoordinatorEventAdapter } from './pushEventAdapter.js'
import {
  AllowedHostsConfigurationManager,
  type AllowedHostsConfigurationSnapshot,
} from './allowedHostsConfiguration.js'
import {
  ChatPushJobManager,
  HermesChatNotificationResolver,
} from './pushEvents.js'
import { ChatCacheCoordinator, ChatCacheStore } from './chatCache.js'

export interface ApplicationOptions {
  config?: ServerConfig
  fetchImpl?: typeof fetch
  csrfSecret?: Buffer
  pairings?: NodePairingStore
  uploads?: UploadStore
  updates?: SystemUpdateManager
  auth?: LocalAuthStore
  upstreamSession?: UpstreamServiceSession
  accountPairings?: AccountLoginPairingStore
  profileIdentities?: UpstreamProfileIdentityService
  push?: PushCoordinator
  apnsConfiguration?: APNsConfigurationManager
  fcmConfiguration?: FCMConfigurationManager
  allowedHostsConfiguration?: AllowedHostsConfigurationManager
  chatCache?: ChatCacheCoordinator
}

export interface ApplicationRuntime {
  workspace: WorkspaceStore
  workspaceRuntime: WorkspaceRuntime
  realtime: RealtimeAPI
  app: Koa
  config: ServerConfig
  csrf: CsrfProtection
  pairings: NodePairingStore
  upstream: UpstreamClient
  uploads: UploadStore
  updates: SystemUpdateManager
  auth: LocalAuthStore
  upstreamSession: UpstreamServiceSession
  accountPairings: AccountLoginPairingStore
  profileIdentities: UpstreamProfileIdentityService
  push: PushCoordinator
  apnsConfiguration: APNsConfigurationManager
  fcmConfiguration: FCMConfigurationManager
  allowedHostsConfiguration: AllowedHostsConfigurationManager
  pushEventCoordinator: PushCoordinatorEventAdapter
  chatPushJobs: ChatPushJobManager
  chatCache?: ChatCacheCoordinator
  close(): void
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

function persistentCsrfSecret(home: string, override?: Buffer): Buffer {
  if (override) return override
  const path = join(home, 'csrf-secret.bin')
  try {
    const secret = readFileSync(path)
    if (secret.byteLength === 32) return secret
    throw new Error('CSRF secret has an invalid length')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const generated = randomBytes(32)
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    // Another 15300 process can finish first during launchd hand-off. Never
    // rotate its secret; use the one it safely wrote instead.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path)
    throw error
  }
}

export function createApplication(options: ApplicationOptions = {}): ApplicationRuntime {
  const config = options.config ?? loadServerConfig()
  const runtimeAllowedHosts = new Set(config.allowedHosts)
  config.allowedHosts = runtimeAllowedHosts
  const app = new Koa()
  app.proxy = false
  const csrf = new CsrfProtection(persistentCsrfSecret(config.home, options.csrfSecret), Boolean(config.tlsCert))
  const pairings = options.pairings ?? new NodePairingStore(config.home)
  const upstream = new UpstreamClient(config.upstream, options.fetchImpl, Boolean(config.tlsCert))
  const uploads = options.uploads ?? new UploadStore(config.home)
  const updates = options.updates ?? new SystemUpdateManager(config)
  const auth = options.auth ?? new LocalAuthStore(config.home, Boolean(config.tlsCert))
  const configuredUpstreamCredentials = config.upstreamUsername && config.upstreamPassword
    ? { username: config.upstreamUsername, password: config.upstreamPassword }
    : undefined
  const upstreamSession = options.upstreamSession ?? new UpstreamServiceSession(
    upstream,
    () => auth.upstreamCredentials(configuredUpstreamCredentials),
  )
  let chatCache = options.chatCache
  if (!chatCache && config.chatCacheMode !== 'upstream-only') {
    try {
      chatCache = new ChatCacheCoordinator(
        new ChatCacheStore(config.home),
        upstreamSession,
        config.chatCacheMode ?? 'prefer-local',
      )
    } catch {
      chatCache = undefined
    }
  }
  const accountPairings = options.accountPairings ?? new AccountLoginPairingStore()
  const profileIdentities = options.profileIdentities
    ?? new UpstreamProfileIdentityService(config, upstreamSession)
  const initialAPNsSettings: APNsConfigurationSnapshot = config.apnsSettings ?? {
    source: config.apns || config.apnsConfigurationError ? 'environment' : 'none',
    editable: !(config.apns || config.apnsConfigurationError),
    ...(config.apns ? {
      input: {
        ...config.apns,
        environments: [...(config.apns.environments ?? ['development', 'production'])],
      },
      config: config.apns,
    } : {}),
    warnings: [],
    ...(config.apnsConfigurationError ? { configurationError: config.apnsConfigurationError } : {}),
  }
  const apnsConfiguration = options.apnsConfiguration
    ?? new APNsConfigurationManager(config.home, initialAPNsSettings)
  const initialFCMSettings: FCMConfigurationSnapshot = config.fcmSettings ?? {
    source: config.fcm || config.fcmConfigurationError ? 'environment' : 'none',
    editable: !(config.fcm || config.fcmConfigurationError),
    ...(config.fcm ? { input: { ...config.fcm }, config: config.fcm } : {}),
    warnings: [],
    ...(config.fcmConfigurationError ? { configurationError: config.fcmConfigurationError } : {}),
  }
  const fcmConfiguration = options.fcmConfiguration
    ?? new FCMConfigurationManager(config.home, initialFCMSettings)
  const initialAllowedHostsSettings: AllowedHostsConfigurationSnapshot = config.allowedHostsSettings ?? {
    source: runtimeAllowedHosts.size ? 'environment' : 'none',
    hosts: [...runtimeAllowedHosts],
    editableHosts: [],
    environmentHosts: [...runtimeAllowedHosts],
  }
  const allowedHostsConfiguration = options.allowedHostsConfiguration
    ?? new AllowedHostsConfigurationManager(config.home, initialAllowedHostsSettings, runtimeAllowedHosts)
  const push = options.push ?? new PushCoordinator({
    home: config.home,
    apns: config.apns,
    apnsConfigurationError: config.apnsConfigurationError,
    fcm: config.fcm,
    fcmConfigurationError: config.fcmConfigurationError,
    isUserActive: userID => auth.isUserActive(userID),
    userAuthorizationVersion: userID => auth.pushAuthorizationVersion(userID),
  })
  const pushEventCoordinator = new PushCoordinatorEventAdapter(push)
  const chatPushJobs = new ChatPushJobManager(config, upstreamSession, pushEventCoordinator, {
    resolver: new HermesChatNotificationResolver(
      upstreamSession,
      (localUserID, prompt) => push.promptDigest(localUserID, prompt),
    ),
  })
  // The application owns group events. No Dashboard plugin is queried.
  const workspace = new WorkspaceStore(config.home)
  const workspaceNodes = new WorkspaceNodes(workspace, config, { url: config.upstream, client: upstream, session: upstreamSession })
  const workspaceRuntime = new WorkspaceRuntime(workspace, workspaceNodes, uploads, owner => auth.isUserActive(owner))
  const workspaceAssets = new WorkspaceAssets(workspace, workspaceNodes, config.home)
  workspaceRuntime.onMessage = (owner, message) => workspaceAssets.archive(owner, message)
  workspaceRuntime.onNotify = (owner, c, run, message, interaction) => {
    if (c.kind === 'group' && !push.isGroupSubscribed(owner,c.id)) return
    push.enqueueNotification({ kind: interaction ? interaction.kind === 'approval' ? 'chat.approval.requested' : 'chat.clarification.requested' : run.status === 'failed' ? 'chat.failed' : 'chat.completed', eventID: `workspace:${interaction?.id ?? run.id}`, localUserID: owner, title: c.name, body: (interaction?.message || message?.content || run.error || '回复完成').slice(0,180), collapseID: `workspace:${c.id}:${run.conversationTaskId ?? 'direct'}`, data: { conversationId:c.id, ...(run.conversationTaskId ? { conversationTaskId: run.conversationTaskId } : {}), workspace:'1' }, ...(c.kind === 'group' ? {roomID:c.id} : {}) })
  }
  const realtime = new RealtimeAPI(config, auth, csrf, pairings, upstream, upstreamSession, {
    coordinator: pushEventCoordinator,
    resolver: new HermesChatNotificationResolver(upstreamSession, (user, prompt) => push.promptDigest(user, prompt)),
  })
  realtime.broker.protectedSession = id => workspace.ownsUpstream(id)
  realtime.broker.onNativeEvent = (owner, profile, storedId, frame) => {
    chatCache?.observe(owner, profile, storedId, frame)
    if (!['message.complete', 'tool.complete', 'tool.completed', 'attachment.staged'].includes(frame.type)) return
    const data = frame.payload ?? {}, text = JSON.stringify(data)
    const messageId = String(data.row_id ?? data.message_id ?? data.id ?? createHash('sha256').update(text).digest('hex'))
    void workspaceAssets.archiveText(owner, text, 'local', profile, storedId, messageId, frame.type === 'attachment.staged' ? 'user' : 'agent').catch(() => {})
  }
  realtime.broker.onNativeGlobalEvent = (owner, type) => chatCache?.observeGlobal(owner, type)
  realtime.broker.onNativeCommand = (owner, profile, storedId, method, params) => {
    chatCache?.command(owner, profile, storedId, method, params)
  }
  realtime.broker.onNativeRoute = (owner, profile, storedId, runtimeId) => {
    chatCache?.route(owner, profile, storedId, runtimeId)
  }
  chatPushJobs.setTransportFactory(realtime.recoveryTransport, job => realtime.ownsPushJob(job.id))
  try {
    uploads.cleanupUncommitted()
  } catch {
    // A locked cleanup should not prevent startup; upload operations will
    // still surface the underlying storage error when used.
  }

  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      if (error instanceof UpstreamHttpError) {
        ctx.status = error.response.status
        ctx.type = 'application/json; charset=utf-8'
        ctx.body = { error: `Hermes returned HTTP ${error.response.status}`, code: error.code }
        return
      }
      const status = error instanceof HttpError
        ? error.status
        : typeof (error as { status?: unknown })?.status === 'number'
          ? Number((error as { status: number }).status)
          : 500
      const expose = status < 500 || error instanceof HttpError
      ctx.status = status
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = {
        error: expose ? errorMessage(error) : 'Internal server error',
        code: error instanceof HttpError ? error.code : 'internal_error',
      }
      if (status >= 500 && !config.production) ctx.app.emit('error', error, ctx)
    }
  })
  app.use(async (ctx, next) => {
    applySecurityHeaders(ctx, Boolean(config.tlsCert), config.allowedHosts)
    if (!isAllowedHostHeader(ctx.get('host'), config)) {
      throw new HttpError(421, 'Request Host is not allowed', 'invalid_host')
    }
    await next()
  })
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/app/') && isMutation(ctx.method)) {
      const secure = ctx.secure || Boolean(config.tlsCert)
      if (!isExactOrigin(ctx.get('origin'), ctx.get('host'), secure, config.allowedHosts)) {
        throw new HttpError(403, 'Request Origin is not allowed', 'invalid_origin')
      }
      if (!csrf.verify(ctx.get('cookie'), ctx.get('x-csrf-token'))) {
        throw new HttpError(403, 'CSRF token is invalid or missing', 'invalid_csrf')
      }
    }
    await next()
  })
  app.use(realtime.middleware())
  const parseBody = (limit: string) => bodyParser({
    encoding: 'utf-8',
    enableTypes: ['json'],
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    jsonLimit: limit,
    onError: (error, ctx) => {
      throw new HttpError(ctx.status === 413 || (error as { status?: number }).status === 413 ? 413 : 400, 'Invalid JSON request body', 'invalid_json_body')
    },
  })
  const ordinaryBody = parseBody('2mb'), workspaceBody = parseBody('4mb')
  app.use((ctx,next) => (/^\/api\/app\/(agents|conversations)(\/|$)/.test(ctx.path) || ctx.path === '/api/app/account/avatar' ? workspaceBody : ordinaryBody)(ctx,next))
  app.use(async (ctx, next) => {
    ctx.state.localAuth = auth
    ctx.state.upstreamSession = upstreamSession
    const anonymous = ctx.path === '/api/app/bootstrap'
      || ctx.path === '/api/app/setup'
      || ctx.path === '/api/app/login'
      || ctx.path === '/api/status'
      || ctx.path === '/api/auth/providers'
      || ctx.path === '/auth/password-login'
      || ctx.path.startsWith('/api/pair/v1/')
      || ctx.path.startsWith('/api/account-pair/v1/')
      || ctx.path === '/healthz'
      || ctx.path === '/readyz'
    if (ctx.path.startsWith('/api/app/') && !anonymous) {
      const allowPasswordChange = ctx.path === '/api/app/account/credentials'
        || ctx.path === '/api/app/logout'
      ctx.state.localUser = auth.require(ctx, allowPasswordChange)
      const adminOnly = ctx.path.startsWith('/api/app/admin/')
        || ctx.path.startsWith('/api/app/system/')
        || ctx.path.startsWith('/api/app/plugins/')
        || ctx.path.startsWith('/api/app/pairings')
        || ctx.path.startsWith('/api/app/paired-devices')
        || ctx.path.startsWith('/api/app/groups/nodes')
      if (adminOnly) ctx.state.localUser = auth.requireAdmin(ctx)
    }
    const gatewayCompatibility = (ctx.path.startsWith('/api/') && !ctx.path.startsWith('/api/app/')
      && !ctx.path.startsWith('/api/pair/'))
      || ctx.path === '/auth/logout'
    if (gatewayCompatibility && !anonymous) {
      const allowPasswordChange = ctx.path === '/api/auth/me' || ctx.path === '/api/profiles'
        || ctx.path === '/api/account/credentials'
      ctx.state.localUser = auth.require(ctx, allowPasswordChange)
      if (isMutation(ctx.method)) {
        const origin = ctx.get('origin')
        if (origin && !isExactOrigin(origin, ctx.get('host'), ctx.secure || Boolean(config.tlsCert), config.allowedHosts)) {
          throw new HttpError(403, 'Request Origin is not allowed', 'invalid_origin')
        }
      }
    }
    const user = ctx.state.localUser as { id: string } | undefined
    if (user) {
      await upstream.withReadScope(`user:${user.id}:${auth.pushAuthorizationVersion(user.id)}`, ctx.get('x-yaoyao-cache') === 'bypass', next)
    } else await next()
  })

  const applicationRouter = workspaceRouter(workspace, workspaceRuntime, workspaceNodes, workspaceAssets, uploads, auth, push)
  app.use(applicationRouter.routes())
  app.use(async (ctx, next) => {
    if (ctx.path.includes('/plugins/yaoyao') || ctx.path.startsWith('/api/app/groups')) throw new HttpError(410, '请使用新版聊天接口', 'retired_plugin_api')
    const id = /\/sessions\/([^/]+)/.exec(ctx.path)?.[1]
    if (id && workspace.ownsUpstream(decodeURIComponent(id))) throw new HttpError(404, '会话不存在', 'session_not_found')
    await next()
    // Native history is a separate surface, including search and profile projections.
    if (ctx.path.includes('/sessions') || ctx.path.endsWith('/profiles')) {
      let value: any = ctx.body
      const buffered = Buffer.isBuffer(value)
      try {
        if (buffered) value = JSON.parse(value.toString())
        const filter = (v: any): any => {
          if (Array.isArray(v)) return v.filter(x => !x || typeof x !== 'object' || (x.source !== 'yaoyao_workspace' && !workspace.ownsUpstream(String(x.id ?? x.session_id ?? x.sessionId ?? '')))).map(filter)
          if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, filter(x)]))
          return v
        }
        ctx.body = buffered ? Buffer.from(JSON.stringify(filter(value))) : filter(value)
      } catch { /* Preserve non-JSON error responses. */ }
    }
  })
  const router = createApiRouter({
    workspace,
    config,
    csrf,
    upstream,
    pairings,
    uploads,
    updates,
    auth,
    upstreamSession,
    accountPairings,
    profileIdentities,
    push,
    apnsConfiguration,
    fcmConfiguration,
    allowedHostsConfiguration,
    chatCache,
  })
  app.use(router.routes())
  app.use(router.allowedMethods({ throw: false }))
  app.use(async (ctx, next) => {
    if (ctx.path === '/api' || ctx.path.startsWith('/api/') || ctx.path.startsWith('/ws/')) {
      ctx.status = 404
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = { error: 'Route not found', code: 'not_found' }
      return
    }
    await next()
  })

  return {
    workspace,
    workspaceRuntime,
    realtime,
    app,
    config,
    csrf,
    pairings,
    upstream,
    uploads,
    updates,
    auth,
    upstreamSession,
    accountPairings,
    profileIdentities,
    push,
    apnsConfiguration,
    fcmConfiguration,
    allowedHostsConfiguration,
    pushEventCoordinator,
    chatPushJobs,
    chatCache,
    close: () => {
      workspaceAssets.close()
      workspaceRuntime.close()
      workspaceNodes.close()
      upstream.close()
      realtime.close()
      chatPushJobs.stop()
      push.close()
      uploads.close()
      workspace.close()
      chatCache?.store.close()
    },
  }
}

export interface NodeServerRuntime {
  server: HttpServer
  close(): Promise<void>
}

export function createNodeServer(runtime: ApplicationRuntime): NodeServerRuntime {
  const { config } = runtime
  const server: HttpServer = config.tlsCert && config.tlsKey
    ? createHttpsServer({
        cert: readFileSync(config.tlsCert),
        key: readFileSync(config.tlsKey),
      }, runtime.app.callback())
    : createHttpServer(runtime.app.callback())
  const synchronizePushObservers = (enabled = runtime.push.isAnyProviderEnabled()) => {
    if (enabled) {
      runtime.chatPushJobs.start()
    } else {
      runtime.chatPushJobs.stop()
    }
  }
  runtime.workspaceRuntime.start()
  synchronizePushObservers()
  const removePushConfigurationListener = runtime.push.onEnabledChange(synchronizePushObservers)
  const removeWebSockets = runtime.realtime.rejectLegacyUpgrades(server)
  return {
    server,
    close: async () => {
      removePushConfigurationListener()
      removeWebSockets()
      runtime.realtime.close()
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => error ? reject(error) : resolve())
      })
      runtime.close()
    },
  }
}
