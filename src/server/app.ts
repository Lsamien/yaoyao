import { unreadSnapshot } from './unreadCenter.js'
import { jsonCompression } from './jsonCompression.js'
import {ExecutionSettings} from './executionSettings.js'
import {CredentialVaultCoordinator} from './credentialVault/coordinator.js'
import {createCredentialVaultClient} from './credentialVault/localClient.js'
import {ManagedBrowsers} from './managedBrowsers.js'
import { isWorkspaceAccountPath } from './subaccountAccess.js'
import {DesktopEnvironments} from './desktopEnvironments.js'
import {DesktopHostHub} from './desktopHosts.js'
import type {GrokAuth} from './grokAuth.js'
import {GrokCloud} from './grokCloud.js'
import {WorkspaceInspector} from './workspaceInspector.js'
import {WorkspaceRoutines} from './workspaceRoutines.js'
import {WorkspaceRoutineTools} from './workspaceRoutineTools.js'
import { WorkspacePlugins } from './botPlugins/workspacePlugins.js'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import { bodyParser } from '@koa/bodyparser'
import Koa from 'koa'
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
import { createEmbeddedHermes, type EmbeddedHermes } from './hermes/embedded.js'
import { readHostTools } from './hostToolSettings.js'
import { UploadStore } from './uploads.js'
import { WorkspaceStore } from './workspaceStore.js'
import { WorkspaceNodes } from './workspaceGateway.js'
import { WorkspaceRuntime } from './workspaceRuntime.js'
import { WorkspaceMemorySynthesis } from './workspaceMemorySynthesis.js'
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
import { OpenVikingConfigurationManager } from './openVikingConfiguration.js'
import { OpenVikingService } from './openVikingService.js'
import { OpenVikingSessionSync } from './openVikingSessionSync.js'
import {
  AllowedHostsConfigurationManager,
  type AllowedHostsConfigurationSnapshot,
} from './allowedHostsConfiguration.js'
import {LocalVmService} from './localVm.js'
import {SharedComputers} from './sharedComputers.js'
import {ComputerControlService} from './computerControls.js'
import { RunnerHub } from './runnerHub.js'
import { AdminAudit } from './admin/audit.js'
import { CONSOLE_CSRF_COOKIE, createConsoleApp } from './admin/app.js'
import { isManagementRoute } from './admin/routes.js'
import { AdminSessionStore } from './admin/sessions.js'
import { kernelPaths, requireKernel } from './hermes/paths.js'
import { readReleaseManifest } from './releases.js'

export interface ApplicationOptions {
  deferBackground?: boolean
  config?: ServerConfig
  fetchImpl?: typeof fetch
  grokFetch?:typeof fetch
  csrfSecret?: Buffer
  pairings?: NodePairingStore
  uploads?: UploadStore
  updates?: SystemUpdateManager
  auth?: LocalAuthStore
  pluginFetch?: typeof fetch
  upstreamSession?: UpstreamServiceSession
  hermes?: EmbeddedHermes
  accountPairings?: AccountLoginPairingStore
  profileIdentities?: UpstreamProfileIdentityService
  push?: PushCoordinator
  apnsConfiguration?: APNsConfigurationManager
  fcmConfiguration?: FCMConfigurationManager
  openVikingConfiguration?: OpenVikingConfigurationManager
  allowedHostsConfiguration?: AllowedHostsConfigurationManager
  adminSessions?: AdminSessionStore
  adminCsrfSecret?: Buffer
}

export interface ApplicationRuntime {
  /** Admin console (separate listener): management and system settings only. */
  adminApp: Koa
  adminSessions: AdminSessionStore
  adminAudit: AdminAudit
  adminCsrf: CsrfProtection
  credentialVault: CredentialVaultCoordinator
  runners: RunnerHub
  workspace: WorkspaceStore
  workspaceRuntime: WorkspaceRuntime
  app: Koa
  config: ServerConfig
  csrf: CsrfProtection
  pairings: NodePairingStore
  upstream: UpstreamClient
  uploads: UploadStore
  updates: SystemUpdateManager
  auth: LocalAuthStore
  upstreamSession: UpstreamServiceSession
  hermes: EmbeddedHermes
  accountPairings: AccountLoginPairingStore
  profileIdentities: UpstreamProfileIdentityService
  push: PushCoordinator
  apnsConfiguration: APNsConfigurationManager
  fcmConfiguration: FCMConfigurationManager
  openVikingConfiguration: OpenVikingConfigurationManager
  openVikingService: OpenVikingService
  openVikingSessionSync: OpenVikingSessionSync
  allowedHostsConfiguration: AllowedHostsConfigurationManager
  desktopEnvironments:DesktopEnvironments
  desktopHosts:DesktopHostHub
  grokAuth:GrokAuth
  workspaceRoutines:WorkspaceRoutines
  workspacePlugins:WorkspacePlugins
  localVm: LocalVmService
  startBackground(): void
  close(): void
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

function persistentCsrfSecret(home: string, override?: Buffer, file = 'csrf-secret.bin'): Buffer {
  if (override) return override
  const path = join(home, file)
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
  // Test configs predate the console; they get the default local listener.
  config.admin ??= { enabled: true, host: '127.0.0.1', port: config.port === 15301 ? 15302 : 15301, allowIps: [], insecureHttp: false, external: false }
  const runtimeAllowedHosts = new Set(config.allowedHosts)
  config.allowedHosts = runtimeAllowedHosts
  const app = new Koa()
  app.proxy = false
  const csrf = new CsrfProtection(persistentCsrfSecret(config.home, options.csrfSecret), Boolean(config.tlsCert))
  const pairings = options.pairings ?? new NodePairingStore(config.home)
  const upstream = new UpstreamClient(config.upstream, options.fetchImpl, Boolean(config.tlsCert))
  // Embedded Hermes: the kernel runs as child processes under <data>/hermes; nothing listens on 9119.
  const hermes = options.hermes ?? createEmbeddedHermes(config.home, {
    defaultCwd: config.mediaRoot,
    policy: () => {
      // Same global switch the Hermes dashboard used for native approvals.
      try { const tools = readHostTools(config.home); return { approval: tools.approvalPolicy, denyHostTools: tools.denyServerTools } }
      catch { return { approval: 'ask', denyHostTools: false } }
    },
  })
  // `fetchImpl` is a test-only fake Dashboard transport; production always answers in process.
  if (!options.upstreamSession && !options.fetchImpl) upstream.local = hermes.api
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
  const openVikingConfiguration = options.openVikingConfiguration
    ?? new OpenVikingConfigurationManager(config.home)
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
  // The application owns group events. No Dashboard plugin is queried.
  const workspace = new WorkspaceStore(config.home)
  push.setUnreadCounter(owner => unreadSnapshot(workspace, owner,(node,profile)=>auth.canUseSource(owner,node,profile)).total)
  const openVikingService = new OpenVikingService(workspace, openVikingConfiguration)
  const workspaceNodes = new WorkspaceNodes(workspace, config, { url: config.upstream, client: upstream, session: upstreamSession, ...(upstream.embedded ? { embedded: hermes.gateway } : {}) }, pairings.nodeID)
  workspaceNodes.sourceAllowed = (owner, nodeId, profile) => auth.canUseSource(owner, nodeId, profile)
  const runners=new RunnerHub(workspace,auth,workspaceNodes.local)
  runners.hermesUpstream=config.upstream.origin
  runners.composeDesktops.desktops.push(...(config.composeDesktops??[]))
  const sharedComputers=new SharedComputers(workspace,auth,workspaceNodes,runners)
  const computerControls=new ComputerControlService(workspace,auth,workspaceNodes,runners)
  const localVm=new LocalVmService(workspace,auth,workspaceNodes,runners,sharedComputers,config)
  runners.localVmAllowed=(id,runnerId)=>localVm.allowed(id,runnerId)
  runners.controlAllowed=(id,runnerId)=>computerControls.allowed(id,runnerId)
  workspaceNodes.runnerTarget=(owner,nodeId,computer)=>runners.target(owner,nodeId,computer)
  const executionSettings=new ExecutionSettings(workspace,workspaceNodes,auth)
  const credentialVault=new CredentialVaultCoordinator(createCredentialVaultClient(config.credentialVault,config.home),workspace,auth,runners)
  const workspaceRuntime = new WorkspaceRuntime(workspace, workspaceNodes, uploads, owner => auth.isUserActive(owner), owner => auth.pushAuthorizationVersion(owner) ?? 0, openVikingService)
  workspaceRuntime.executionSettings=executionSettings
  workspaceRuntime.credentialVault=credentialVault
  runners.executionSettings=executionSettings
  executionSettings.onProxyChange=()=>runners.configureNetworks()
  executionSettings.testProxy=()=>runners.testNetworks()
  executionSettings.nodeStatus=()=>runners.networkStatus()
  executionSettings.activeTurns=()=>workspaceRuntime.activeExecutionTurns()
  const workspaceMemory = new WorkspaceMemorySynthesis(workspaceRuntime)
  const openVikingSessionSync = new OpenVikingSessionSync(workspace, openVikingService, owner => auth.isUserActive(owner))
  let backgroundStarted = false, closed = false
  const startBackground = () => {
    if (backgroundStarted || closed) return
    backgroundStarted = true
    workspaceMemory.start()
    openVikingSessionSync.start()
  }
  if (!options.deferBackground) startBackground()
  const grokCloud=new GrokCloud(workspace,auth,workspaceNodes,sharedComputers,options.grokFetch)
  const desktopEnvironments=new DesktopEnvironments(workspace,auth,workspaceNodes)
  const managedBrowsers=new ManagedBrowsers(workspace,auth,workspaceNodes,runners)
  workspaceRuntime.managedBrowsers=managedBrowsers
  runners.browserAllowed=(runnerId,scope,grantId)=>managedBrowsers.allowed(runnerId,scope,grantId)
  const desktopHosts=new DesktopHostHub(workspace,auth)
  desktopHosts.exchange=(id,value)=>desktopEnvironments.remoteExchange(id,value)
  desktopHosts.drop=id=>desktopEnvironments.dropHost(id)
  workspaceRuntime.desktopEnvironments=desktopEnvironments
  grokCloud.preferDesktop=(owner,agent)=>!!desktopEnvironments.selected(owner,agent)
  grokCloud.beforeSelection=(owner,id)=>desktopEnvironments.assertIdle(owner,id)
  workspaceRuntime.computerAvailable=(owner,agent)=>{try{runners.computerRunner(owner,agent);return true}catch{return false}}
  workspaceRuntime.cloud=grokCloud
  const workspaceInspector=new WorkspaceInspector(workspace,auth)
  workspaceRuntime.inspector=workspaceInspector
  const workspaceRoutines=new WorkspaceRoutines(workspace,auth,workspaceNodes,workspaceRuntime)
  workspaceRuntime.routineTools=new WorkspaceRoutineTools(workspaceRoutines,workspace,workspaceNodes,workspaceRuntime)
  const workspacePlugins=new WorkspacePlugins(workspace,workspaceNodes,auth,workspaceRuntime,config.home,options.pluginFetch)
  workspaceRuntime.plugins=workspacePlugins
  workspaceRuntime.retireHelper=(owner,helper)=>runners.retireHelper(owner,helper)
  workspaceRuntime.onTeamCreated = (owner, team) => {
    try { push.setGroupSubscription(owner, team.id, true, team.lastSeq) } catch { /* Optional notifications do not undo a team. */ }
  }
  const workspaceAssets = new WorkspaceAssets(workspace, workspaceNodes, config.home)
  workspaceRuntime.publishArtifact=(owner,message,agent,name,bytes)=>workspaceAssets.publish(owner,message,agent,name,bytes)
  workspaceRuntime.onMessage = (owner, message) => workspaceAssets.archive(owner, message)
  workspaceRuntime.onNotify = (owner, c, run, message, interaction) => {
    if (c.kind === 'group' && !push.isGroupSubscribed(owner,c.id)) return
    push.enqueueNotification({ kind: interaction ? interaction.kind === 'approval' ? 'chat.approval.requested' : 'chat.clarification.requested' : run.status === 'failed' ? 'chat.failed' : 'chat.completed', eventID: `workspace:${interaction?.id ?? run.id}`, localUserID: owner, title: c.name, body: (interaction?.message || message?.content || run.error || '回复完成').slice(0,180), collapseID: `workspace:${c.id}:${run.conversationTaskId ?? 'direct'}`, data: { conversationId:c.id, ...(run.conversationTaskId ? { conversationTaskId: run.conversationTaskId } : {}), workspace:'1' }, ...(c.kind === 'group' ? {roomID:c.id} : {}) })
  }
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
  // Management moved to the admin console; the Web keeps no management routes.
  app.use(async (ctx, next) => {
    if (isManagementRoute(ctx.method, ctx.path))
      throw new HttpError(410, '该设置已移到管理后台，请在服务器本机打开管理后台操作。', 'moved_to_admin_console')
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
  app.use(jsonCompression)
  app.use(runners.middleware())
  app.use(desktopHosts.middleware())
  app.use(async (ctx, next) => {
    const user = auth.current(ctx)
    if (user && user.role !== 'admin' && (ctx.path.startsWith('/api/') || ctx.path.startsWith('/node/') || ctx.path.startsWith('/ws/') || ctx.path.startsWith('/Users/') || ctx.path.startsWith('/attachments/'))) {
      const path = ctx.path
      const publicPath = ['/api/status', '/api/auth/providers', '/api/auth/me', '/api/profiles', '/api/app/bootstrap', '/api/app/login', '/api/app/logout'].includes(path)
      const accountPath = ['/api/account/credentials', '/api/app/account/credentials', '/api/app/account/avatar'].includes(path)
      const workspacePath = /^\/api\/app\/(?:capabilities|agents|conversations|runs|interactions|events|uploads|files|message-files|computers|bot-tools)(?:\/|$)/.test(path)
        && path !== '/api/app/agents/remote'
      const pushPath = /^\/api\/(?:app\/)?push\/v1\//.test(path)
      const identityRead = path === '/api/app/server-identity' && ['GET', 'HEAD'].includes(ctx.method)
      if (!publicPath && !accountPath && !workspacePath && !isWorkspaceAccountPath(ctx.method, path) && !pushPath && !identityRead)
        throw new HttpError(403, '子账号只能使用 Bot 模式', 'bot_mode_required')
    }
    await next()
  })
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
      || ctx.path === '/api/app/register'
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

  app.use(async(ctx,next)=>{
    const user=ctx.state.localUser as {id:string}|undefined,cookie=ctx.get('cookie')
    if(['/api/app/logout','/auth/logout'].includes(ctx.path)&&ctx.method==='POST'&&user)await credentialVault.logout(user.id,cookie)
    await next()
  })
  // Route handlers are shared by the Web and the admin console; each listener gates which ones it exposes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: Koa.Middleware<any, any>[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mount = (router: { routes(): Koa.Middleware<any, any>; allowedMethods(options?: any): Koa.Middleware<any, any> }, options?: object) => { routes.push(router.routes(), router.allowedMethods(options)) }
  for (const router of [credentialVault.router(), executionSettings.router(), managedBrowsers.router(), desktopEnvironments.router(), grokCloud.authorization.router(), grokCloud.router(), workspaceInspector.router(), workspaceRoutines.router(), workspacePlugins.router(), sharedComputers.router(), localVm.router(), computerControls.router()]) mount(router)
  const applicationRouter = workspaceRouter(workspace, workspaceRuntime, workspaceNodes, workspaceAssets, uploads, auth, push, csrf)
  routes.push(runners.adminRouter().routes(), desktopHosts.adminRouter().routes(), applicationRouter.routes())
  routes.push(async (ctx, next) => {
    if (ctx.path.includes('/plugins/yaoyao') || ctx.path.startsWith('/api/app/groups')) throw new HttpError(410, '请使用新版聊天接口', 'retired_plugin_api')
    await next()
  })
  const router = createApiRouter({
    onUserAccessChanged: async owner => {
      for (const c of workspace.list<{ id: string }>(owner, 'conversation')) await workspaceRuntime.stopConversation(owner, c.id)
    },
    workspace,
    config,
    csrf,
    upstream,
    pairings,
    uploads,
    updates,
    auth,
    upstreamSession,
    hermes,
    accountPairings,
    profileIdentities,
    push,
    apnsConfiguration,
    fcmConfiguration,
    openVikingConfiguration,
    openVikingService,
    openVikingSessionSync,
    allowedHostsConfiguration,
  })
  mount(router, { throw: false })
  for (const middleware of routes) app.use(middleware)
  app.use(async (ctx, next) => {
    if (ctx.path === '/api' || ctx.path.startsWith('/api/') || ctx.path.startsWith('/ws/')) {
      ctx.status = 404
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = { error: 'Route not found', code: 'not_found' }
      return
    }
    await next()
  })

  const adminSessions = options.adminSessions ?? new AdminSessionStore(config.home, auth, Boolean(config.tlsCert))
  const adminAudit = new AdminAudit(config.home)
  const adminCsrf = new CsrfProtection(persistentCsrfSecret(config.home, options.adminCsrfSecret, 'admin-csrf-secret.bin'), Boolean(config.tlsCert), CONSOLE_CSRF_COOKIE)
  let version = 'unknown'
  try { version = readReleaseManifest(join(process.cwd(), 'release.json')).releaseVersion } catch { /* Source checkouts without a manifest. */ }
  const adminApp = createConsoleApp({
    config, auth, sessions: adminSessions, audit: adminAudit, csrf: adminCsrf, routes, version,
    readScope: (user, next) => upstream.withReadScope(`user:${user.id}:${auth.pushAuthorizationVersion(user.id)}`, false, next),
    profiles: async () => {
      const response = await upstreamSession.request('/api/profiles')
      const parsed = JSON.parse(response.body.toString('utf8') || '{}') as { profiles?: Array<{ name?: unknown; display_name?: unknown; is_default?: unknown }> } | Array<{ name?: unknown }>
      const rows = Array.isArray(parsed) ? parsed : parsed.profiles ?? []
      return rows.flatMap(row => typeof row.name === 'string' && row.name ? [{ name: row.name, label: typeof (row as { display_name?: unknown }).display_name === 'string' && (row as { display_name: string }).display_name || row.name, isDefault: row.name === 'default' || (row as { is_default?: unknown }).is_default === true }] : [])
    },
    overview: async admin => {
      let kernel: { ready: boolean; error?: string } = { ready: true }
      try { const paths = kernelPaths(); requireKernel(paths, paths.worker) } catch (cause) { kernel = { ready: false, error: cause instanceof Error ? cause.message : '内置 Hermes 内核不可用' } }
      const users = auth.list(admin)
      const runnerRows = runners.records().map(record => runners.summary(record))
      const hostRows = desktopHosts.records().filter(record => record.enabled).map(record => desktopHosts.summary(record))
      const pushStatus = push.status()
      let update: { current: string; updateAvailable: boolean; latest?: string } | undefined
      try { const status = updates.status(); update = { current: status.current.releaseVersion, updateAvailable: status.updateAvailable, ...(status.latest ? { latest: status.latest.releaseVersion } : {}) } } catch { /* Update status is optional. */ }
      return {
        version,
        kernel: { ...kernel, version: '0.23.0' },
        users: { total: users.length, admins: users.filter(user => user.role === 'admin').length, pending: users.filter(user => user.registrationStatus === 'pending').map(user => ({ id: user.id, username: user.username, createdAt: user.createdAt })), disabled: users.filter(user => !user.enabled).length },
        runners: { total: runnerRows.filter(row => row.enabled).length, online: runnerRows.filter(row => row.enabled && row.online).length },
        desktopHosts: { total: hostRows.length, online: hostRows.filter(row => row.online).length, offline: hostRows.filter(row => !row.online).map(row => ({ id: row.id, name: row.displayName || row.name, lastSeen: row.lastSeen })) },
        push: { configured: pushStatus.configured, healthy: pushStatus.healthy, registrations: pushStatus.registrationCount },
        ...(update ? { update } : {}),
        web: { host: config.host, port: config.port },
        console: { host: config.admin.host, port: config.admin.port, external: config.admin.external },
      }
    },
  })

  return {
    adminApp,
    adminSessions,
    adminAudit,
    adminCsrf,
    credentialVault,
    runners,
    localVm,
    workspace,
    workspaceRuntime,
    workspaceRoutines,
    workspacePlugins,
    desktopEnvironments,
    desktopHosts,
    grokAuth:grokCloud.authorization,
    app,
    config,
    csrf,
    pairings,
    upstream,
    uploads,
    updates,
    auth,
    upstreamSession,
    hermes,
    accountPairings,
    profileIdentities,
    push,
    apnsConfiguration,
    fcmConfiguration,
    openVikingConfiguration,
    openVikingService,
    openVikingSessionSync,
    allowedHostsConfiguration,
    startBackground,
    close: () => {
      adminAudit.close()
      credentialVault.close()
      closed = true
      openVikingSessionSync.close()
      workspaceMemory.close()
      runners.close()
    workspaceAssets.close()
    managedBrowsers.close()
    desktopEnvironments.close()
    desktopHosts.close()
      grokCloud.authorization.close()
      executionSettings.close()
      workspaceRoutines.close()
      workspacePlugins.close()
      workspaceRuntime.close()
      workspaceNodes.close()
      upstream.close()
      if (!options.hermes) hermes.close()
      push.close()
      uploads.close()
      workspace.close()
    },
  }
}

export interface NodeServerRuntime {
  server: HttpServer
  /** Admin console listener; undefined when YAOYAO_ADMIN_PORT=off. */
  adminServer?: HttpServer
  startBackground(): void
  close(closeConnections?: boolean): Promise<void>
}

export function createNodeServer(runtime: ApplicationRuntime, options: { deferBackground?: boolean } = {}): NodeServerRuntime {
  const { config } = runtime
  const server: HttpServer = config.tlsCert && config.tlsKey
    ? createHttpsServer({
        cert: readFileSync(config.tlsCert),
        key: readFileSync(config.tlsKey),
      }, runtime.app.callback())
    : createHttpServer(runtime.app.callback())
  const adminServer: HttpServer | undefined = !config.admin.enabled ? undefined : config.tlsCert && config.tlsKey
    ? createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, runtime.adminApp.callback())
    : createHttpServer(runtime.adminApp.callback())
  let backgroundStarted = false, localVmStarted = false, closed = false
  const startLocalVm = () => {
    if (!backgroundStarted || localVmStarted || closed) return
    const address = server.address()
    if (!address || typeof address === 'string') return
    localVmStarted = true
    void runtime.localVm.start(`${config.tlsCert ? 'https' : 'http'}://127.0.0.1:${address.port}`)
      .catch(error => console.error('本地虚拟机服务启动失败', error.message))
  }
  const startBackground = () => {
    if (backgroundStarted || closed) return
    backgroundStarted = true
    runtime.startBackground()
    runtime.workspaceRuntime.start()
    runtime.workspaceRoutines.start()
    runtime.grokAuth.start()
    startLocalVm()
  }
  server.once('listening', startLocalVm)
  if (!options.deferBackground) startBackground()
  const removeWebSockets = rejectWebSocketUpgrades(server, config.production)
  const removeAdminWebSockets = adminServer ? rejectWebSocketUpgrades(adminServer, config.production) : () => undefined
  return {
    server,
    ...(adminServer ? { adminServer } : {}),
    startBackground,
    close: async (closeConnections = false) => {
      closed = true
      await runtime.localVm.close()
      removeWebSockets()
      removeAdminWebSockets()
      if (adminServer?.listening) {
        if (closeConnections) adminServer.closeAllConnections()
        await new Promise<void>(resolve => adminServer.close(() => resolve()))
      }
      if (closeConnections) server.closeAllConnections()
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

/** Clients use HTTP; reject WebSocket upgrades explicitly (Vite owns HMR sockets in development). */
function rejectWebSocketUpgrades(server: HttpServer, production: boolean): () => void {
  const upgrade = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex) => {
    const path = (request.url ?? '/').split('?')[0]!
    if (!production && !path.startsWith('/api/') && !path.startsWith('/node/') && !path.startsWith('/ws/')) return
    const body = JSON.stringify({ code: 'http_required', error: 'WebSockets are not supported; use HTTP' })
    socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
  }
  server.on('upgrade', upgrade)
  return () => server.off('upgrade', upgrade)
}
