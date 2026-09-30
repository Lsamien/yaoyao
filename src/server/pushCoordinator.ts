import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  APNsProvider,
  type APNsEnvironment,
  type APNsRequest,
  type APNsSendResult,
} from './apns.js'
import { FCMProvider, type FCMRequest } from './fcm.js'
import {
  DEFAULT_APNS_TOPIC,
  type APNsProviderConfig,
  type FCMProviderConfig,
} from './config.js'
import { DEFAULT_FCM_PACKAGE_NAME } from './fcmConfiguration.js'
import { notificationPlainText } from './notificationText.js'

export const PUSH_EVENT_KINDS = [
  'chat.completed',
  'chat.failed',
  'chat.approval.requested',
  'chat.clarification.requested',
  'group.message.completed',
  'group.message.failed',
  'group.interaction.requested',
] as const

export type PushEventKind = typeof PUSH_EVENT_KINDS[number]
export type PushPlatform = 'ios' | 'android'

export interface AndroidPushCapabilities {
  enabled: boolean
  provider: 'fcm'
  packageName: string
  previewMode: 'title-and-summary'
  events: readonly PushEventKind[]
  maxSummaryCharacters: 180
  maximumSummaryCharacters: 180
  configurationError?: string
}

export interface PushCapabilities {
  protocolVersion: 1
  enabled: boolean
  topic: string
  environments: readonly APNsEnvironment[]
  previewMode: 'title-and-summary'
  events: readonly PushEventKind[]
  maxSummaryCharacters: 180
  maximumSummaryCharacters: 180
  configurationError?: string
  platforms: {
    ios: {
      enabled: boolean
      provider: 'apns'
      topic: string
      environments: readonly APNsEnvironment[]
    }
    android: AndroidPushCapabilities
  }
}

export interface PushStatus {
  configured: boolean
  healthy: boolean
  topic: string
  environments: readonly APNsEnvironment[]
  registrationCount: number
  pendingCount: number
  subscriptionCount: number
  lastSuccessAt?: string
  lastError?: string
  lastErrorAt?: string
}

export interface FCMPushStatus {
  configured: boolean
  healthy: boolean
  provider: 'fcm'
  packageName: string
  projectId?: string
  registrationCount: number
  pendingCount: number
  subscriptionCount: number
  lastSuccessAt?: string
  lastError?: string
  lastErrorAt?: string
}

interface InstallationRegistrationBase {
  userId: string
  installationId: string
  clientAccountId: string
  appVersion?: string
  authorizationVersion?: number
}

export type InstallationRegistration = InstallationRegistrationBase & (
  | { platform?: 'ios'; deviceToken: string; environment: APNsEnvironment; fid?: never }
  | { platform: 'android'; fid: string; deviceToken?: never; environment?: never }
)

export interface PushInstallation {
  installationId: string
  clientAccountId: string
  platform: PushPlatform
  environment?: APNsEnvironment
  appVersion?: string
  updatedAt: string
}

export interface PushGroupSubscription {
  roomId: string
  enabled: boolean
  updatedAt: string
  lastMessageSeq?: number
}

export interface PushNotification {
  eventId: string
  userId: string
  kind: PushEventKind
  title: string
  body: string
  clientAccountId?: string
  data?: Record<string, unknown>
  collapseId?: string
  threadId?: string
  roomId?: string
  expiresAt?: number
}

export interface PushGroupWatchAnchor {
  epoch: string
  cursor: number
  updatedAt?: string
  reason?: string
}

export interface PushChatJob {
  id: string
  localUserID: string
  profile?: string
  runtimeSessionID: string
  storedSessionID?: string
  requestID: string
  queued: boolean
  phase: 'submitted' | 'accepted' | 'watching'
  submittedAt: number
  expiresAt: number
  metadata?: Record<string, unknown>
}

export interface PushNotificationCandidate {
  eventID: string
  localUserID: string
  kind: PushEventKind
  title: string
  body: string
  collapseID: string
  data: Record<string, unknown>
  roomID?: string
  topicID?: string
}

export interface PushFlushResult {
  delivered: number
  retried: number
  removedRegistrations: number
  failed: number
}

export interface PushSender {
  send(request: APNsRequest): Promise<APNsSendResult>
  close?(): void
}

export interface FCMSender {
  send(request: FCMRequest): Promise<APNsSendResult>
  close?(): void
}

export interface PushCoordinatorOptions {
  home: string
  apns?: APNsProviderConfig
  apnsConfigurationError?: string
  provider?: PushSender
  providerFactory?: (config: APNsProviderConfig) => PushSender
  fcm?: FCMProviderConfig
  fcmConfigurationError?: string
  fcmProvider?: FCMSender
  fcmProviderFactory?: (config: FCMProviderConfig) => FCMSender
  now?: () => number
  autoFlush?: boolean
  baseRetryMilliseconds?: number
  maxRetryMilliseconds?: number
  maxAttempts?: number
  isUserActive?: (userId: string) => boolean
  userAuthorizationVersion?: (userId: string) => number | undefined
}

interface InstallationRecordBase extends PushInstallation {
  userId: string
  badge: number
  authorizationVersion?: number
}

interface IOSInstallationRecord extends InstallationRecordBase {
  platform: 'ios'
  deviceToken: string
  environment: APNsEnvironment
}

interface AndroidInstallationRecord extends InstallationRecordBase {
  platform: 'android'
  fid: string
  environment?: never
}

type InstallationRecord = IOSInstallationRecord | AndroidInstallationRecord

interface GroupSubscriptionRecord extends PushGroupSubscription {
  userId: string
}

interface OutboxRecord {
  id: string
  eventId: string
  userId: string
  installationId: string
  clientAccountId: string
  platform: PushPlatform
  kind: PushEventKind
  title: string
  body: string
  data: Record<string, unknown>
  collapseId?: string
  threadId?: string
  roomId?: string
  createdAt: number
  expiresAt: number
  attempts: number
  nextAttemptAt: number
}

interface StoredStatus {
  lastSuccessAt?: string
  lastError?: string
  lastErrorAt?: string
}

interface PushState {
  schemaVersion: 2
  installations: InstallationRecord[]
  groupSubscriptions: GroupSubscriptionRecord[]
  outbox: OutboxRecord[]
  processedEvents: Record<string, number>
  groupWatch?: PushGroupWatchAnchor
  chatJobs: PushChatJob[]
  ambiguousChatSessions: Record<string, number>
  chatRecoveryDisabledUntil?: number
  providerStatus: Record<PushPlatform, StoredStatus>
}

const MAX_SUMMARY_CHARACTERS = 180
const MAX_OUTBOX_ITEMS = 10_000
const MAX_GROUP_SUBSCRIPTIONS_PER_USER = 512
const MAX_INSTALLATIONS_PER_USER = 32
const MAX_CHAT_JOBS_PER_USER = 256
const MAX_PROCESSED_EVENTS = 50_000
const MAX_AMBIGUOUS_CHAT_SESSIONS = 50_000
const AMBIGUOUS_CHAT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const DEFAULT_EVENT_LIFETIME_MS = 24 * 60 * 60 * 1_000
const DEDUPE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000

function emptyState(): PushState {
  return {
    schemaVersion: 2,
    installations: [],
    groupSubscriptions: [],
    outbox: [],
    processedEvents: {},
    chatJobs: [],
    ambiguousChatSessions: {},
    providerStatus: { ios: {}, android: {} },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(raw: string): PushState {
  const value = JSON.parse(raw) as unknown
  if (!isObject(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || !Array.isArray(value.installations)
    || !Array.isArray(value.groupSubscriptions)
    || !Array.isArray(value.outbox)
    || !isObject(value.processedEvents)
    || (value.schemaVersion === 1 && !isObject(value.status))
    || (value.schemaVersion === 2 && !isObject(value.providerStatus))) {
    throw new Error('Unsupported or malformed push state')
  }
  if (value.chatJobs !== undefined && !Array.isArray(value.chatJobs)) {
    throw new Error('Malformed push chat jobs')
  }
  if (value.ambiguousChatSessions !== undefined && !isObject(value.ambiguousChatSessions)) {
    throw new Error('Malformed ambiguous push chat sessions')
  }
  const legacyOwners = isObject(value.chatSessionOwners)
    ? value.chatSessionOwners as Record<string, unknown> : {}
  const migratedAmbiguous = Object.fromEntries(Object.entries(legacyOwners).flatMap(([sessionID, owners]) => (
    Array.isArray(owners) && new Set(owners.map(String)).size > 1 ? [[sessionID, Date.now()]] : []
  )))
  const installations = (value.installations as Array<Record<string, unknown>>).map(record => {
    if (value.schemaVersion === 1) return { ...record, platform: 'ios' }
    return record
  }) as unknown as InstallationRecord[]
  if (installations.some(record => record.platform !== 'ios' && record.platform !== 'android')) {
    throw new Error('Malformed push installation platform')
  }
  if (installations.some(record => record.platform === 'ios'
    ? typeof record.deviceToken !== 'string'
      || (record.environment !== 'development' && record.environment !== 'production')
    : typeof record.fid !== 'string')) {
    throw new Error('Malformed push installation target')
  }
  const outbox = (value.outbox as Array<Record<string, unknown>>).map(record => {
    if (value.schemaVersion === 1) return { ...record, platform: 'ios' }
    return record
  }) as unknown as OutboxRecord[]
  if (outbox.some(record => record.platform !== 'ios' && record.platform !== 'android')) {
    throw new Error('Malformed push outbox platform')
  }
  const providerStatus = value.schemaVersion === 1
    ? { ios: value.status as StoredStatus, android: {} }
    : value.providerStatus as Record<PushPlatform, StoredStatus>
  if (!isObject(providerStatus.ios) || !isObject(providerStatus.android)) {
    throw new Error('Malformed push provider status')
  }
  return {
    schemaVersion: 2,
    installations,
    groupSubscriptions: value.groupSubscriptions as GroupSubscriptionRecord[],
    outbox,
    processedEvents: value.processedEvents as Record<string, number>,
    ...(isObject(value.groupWatch) ? { groupWatch: value.groupWatch as unknown as PushGroupWatchAnchor } : {}),
    chatJobs: (value.chatJobs ?? []) as PushChatJob[],
    ambiguousChatSessions: {
      ...migratedAmbiguous,
      ...(value.ambiguousChatSessions ?? {}) as Record<string, number>,
    },
    ...(typeof value.chatRecoveryDisabledUntil === 'number'
      ? { chatRecoveryDisabledUntil: value.chatRecoveryDisabledUntil }
      : {}),
    providerStatus: {
      ios: providerStatus.ios,
      android: providerStatus.android,
    },
  }
}

function cloneState(state: PushState): PushState {
  return JSON.parse(JSON.stringify(state)) as PushState
}

class PushStateStore {
  private state = emptyState()
  readonly path: string
  readonly loadError?: string

  constructor(home: string) {
    this.path = join(home, 'push', 'state.json')
    if (!existsSync(this.path)) return
    try {
      chmodSync(this.path, 0o600)
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw) as { schemaVersion?: unknown }
      this.state = parseState(raw)
      if (parsed.schemaVersion === 1) this.write(this.state)
    } catch {
      this.loadError = '推送状态文件无法读取；为避免覆盖现有数据，推送已停用'
    }
  }

  snapshot(): PushState {
    return cloneState(this.state)
  }

  mutate<T>(operation: (state: PushState) => T): T {
    if (this.loadError) throw new Error(this.loadError)
    const next = cloneState(this.state)
    const result = operation(next)
    this.write(next)
    this.state = next
    return result
  }

  private write(state: PushState): void {
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
    } catch (cause) {
      if (descriptor !== undefined) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* Nothing to clean up. */ }
      throw cause
    }
  }
}

function requiredIdentifier(value: string, name: string, maximum = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} is invalid`)
  }
  return normalized
}

function normalizedToken(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^(?:[a-f0-9]{2}){16,256}$/.test(normalized)) throw new Error('deviceToken is invalid')
  return normalized
}

function normalizedFID(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 16 || normalized.length > 4_096
    || !/^[A-Za-z0-9_:.\-]+$/.test(normalized)) throw new Error('fid is invalid')
  return normalized
}

function limitedText(value: string, maximum: number, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return Array.from(normalized).slice(0, maximum).join('')
}

function publicInstallation(record: InstallationRecord): PushInstallation {
  return {
    installationId: record.installationId,
    clientAccountId: record.clientAccountId,
    platform: record.platform,
    ...(record.platform === 'ios' ? { environment: record.environment } : {}),
    ...(record.appVersion ? { appVersion: record.appVersion } : {}),
    updatedAt: record.updatedAt,
  }
}

function dedupePrefix(userId: string): string {
  return `${Buffer.from(userId, 'utf8').toString('base64url')}.`
}

function dedupeKey(userId: string, eventId: string): string {
  const digest = createHash('sha256').update(eventId, 'utf8').digest('base64url')
  return `${dedupePrefix(userId)}${digest}`
}

function safeError(result: APNsSendResult, platform: PushPlatform = 'ios'): string {
  const reason = result.reason || `${platform === 'ios' ? 'APNs' : 'FCM'} HTTP ${result.status}`
  return reason
    .replace(/(?:[a-fA-F0-9]{2}){16,256}/g, '[device-token]')
    .replace(/[A-Za-z0-9_:.\-]{80,}/g, '[opaque-token]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
}

function safeProviderException(cause: unknown, installation: InstallationRecord): string {
  const target = installation.platform === 'ios' ? installation.deviceToken : installation.fid
  return (cause instanceof Error ? cause.message : String(cause))
    .split(target).join('[push-target]')
    .replace(/(?:[a-fA-F0-9]{2}){16,256}/g, '[device-token]')
    .replace(/[A-Za-z0-9_:.-]{80,}/g, '[opaque-token]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500) || `${installation.platform === 'ios' ? 'APNs' : 'FCM'} provider failed`
}

function canonicalGroupWatchAnchor(input: PushGroupWatchAnchor, now: number): PushGroupWatchAnchor {
  const epoch = requiredIdentifier(input.epoch, 'epoch', 128)
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('cursor is invalid')
  return {
    epoch,
    cursor: input.cursor,
    updatedAt: new Date(now).toISOString(),
    ...(input.reason ? { reason: limitedText(input.reason, 200, 'reason') } : {}),
  }
}

function canonicalChatJob(input: PushChatJob): PushChatJob {
  const id = requiredIdentifier(input.id, 'job.id', 512)
  const localUserID = requiredIdentifier(input.localUserID, 'job.localUserID')
  const runtimeSessionID = requiredIdentifier(input.runtimeSessionID, 'job.runtimeSessionID', 512)
  const requestID = requiredIdentifier(input.requestID, 'job.requestID', 512)
  if (!['submitted', 'accepted', 'watching'].includes(input.phase)) throw new Error('job.phase is invalid')
  if (!Number.isFinite(input.submittedAt) || !Number.isFinite(input.expiresAt) || input.expiresAt <= input.submittedAt) {
    throw new Error('job timestamps are invalid')
  }
  let metadata: Record<string, unknown> | undefined
  if (input.metadata) metadata = JSON.parse(JSON.stringify(input.metadata)) as Record<string, unknown>
  return {
    id,
    localUserID,
    ...(input.profile ? { profile: requiredIdentifier(input.profile, 'job.profile') } : {}),
    runtimeSessionID,
    ...(input.storedSessionID
      ? { storedSessionID: requiredIdentifier(input.storedSessionID, 'job.storedSessionID', 512) }
      : {}),
    requestID,
    queued: Boolean(input.queued),
    phase: input.phase,
    submittedAt: input.submittedAt,
    expiresAt: input.expiresAt,
    ...(metadata ? { metadata } : {}),
  }
}

export class PushCoordinator {
  private readonly store: PushStateStore
  private provider?: PushSender
  private apns?: APNsProviderConfig
  private apnsConfigurationError?: string
  private readonly providerFactory: (config: APNsProviderConfig) => PushSender
  private fcmProvider?: FCMSender
  private fcm?: FCMProviderConfig
  private fcmConfigurationError?: string
  private readonly fcmProviderFactory: (config: FCMProviderConfig) => FCMSender
  private readonly now: () => number
  private readonly autoFlush: boolean
  private readonly baseRetryMilliseconds: number
  private readonly maxRetryMilliseconds: number
  private readonly maxAttempts: number
  private readonly isUserActive: (userId: string) => boolean
  private readonly userAuthorizationVersion?: (userId: string) => number | undefined
  private timer?: NodeJS.Timeout
  private activeFlush?: Promise<PushFlushResult>
  private closed = false
  private readonly runtimeErrors: Partial<Record<PushPlatform, { message: string; at: string }>> = {}
  private readonly flushFailureCount: Record<PushPlatform, number> = { ios: 0, android: 0 }
  private readonly flushBlockedUntil: Record<PushPlatform, number> = { ios: 0, android: 0 }
  private correlationSecret?: Buffer
  private correlationError?: string
  private readonly enabledListeners = new Set<(enabled: boolean) => void>()
  private configurationOperation: Promise<void> = Promise.resolve()
  private providerGeneration = 0

  constructor(readonly options: PushCoordinatorOptions) {
    this.store = new PushStateStore(options.home)
    this.apns = options.apns
    this.apnsConfigurationError = options.apnsConfigurationError
    this.providerFactory = options.providerFactory ?? (config => new APNsProvider(config))
    this.provider = options.provider ?? (options.apns ? this.providerFactory(options.apns) : undefined)
    this.fcm = options.fcm
    this.fcmConfigurationError = options.fcmConfigurationError
    this.fcmProviderFactory = options.fcmProviderFactory ?? (config => new FCMProvider(config))
    this.fcmProvider = options.fcmProvider ?? (options.fcm ? this.fcmProviderFactory(options.fcm) : undefined)
    this.now = options.now ?? Date.now
    this.autoFlush = options.autoFlush ?? true
    this.baseRetryMilliseconds = options.baseRetryMilliseconds ?? 1_000
    this.maxRetryMilliseconds = options.maxRetryMilliseconds ?? 60 * 60 * 1_000
    this.maxAttempts = options.maxAttempts ?? 36
    this.isUserActive = options.isUserActive ?? (() => true)
    this.userAuthorizationVersion = options.userAuthorizationVersion
    if (this.isAnyProviderEnabled()) {
      try { this.loadCorrelationSecret() } catch (cause) {
        this.correlationError = cause instanceof Error ? cause.message : 'Push correlation key is unavailable'
      }
    }
    this.markPersistedJobsDisconnected()
    this.scheduleNextFlush()
  }

  configureAPNs(apns?: APNsProviderConfig, configurationError?: string): Promise<void> {
    const operation = this.configurationOperation.then(() => this.applyAPNsConfiguration(apns, configurationError))
    this.configurationOperation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async applyAPNsConfiguration(apns?: APNsProviderConfig, configurationError?: string): Promise<void> {
    const wasEnabled = this.isAnyProviderEnabled()
    const previous = this.provider
    const next = apns && !configurationError ? this.providerFactory(apns) : undefined
    if (this.closed) {
      next?.close?.()
      return
    }
    this.providerGeneration += 1
    this.apns = apns
    this.apnsConfigurationError = configurationError
    this.provider = next
    delete this.runtimeErrors.ios
    this.flushFailureCount.ios = 0
    this.flushBlockedUntil.ios = 0
    if (this.isAnyProviderEnabled()) {
      this.correlationError = undefined
      try { this.loadCorrelationSecret() } catch (cause) {
        this.correlationError = cause instanceof Error ? cause.message : 'Push correlation key is unavailable'
      }
    }
    try {
      this.store.mutate(state => {
        delete state.providerStatus.ios.lastError
        delete state.providerStatus.ios.lastErrorAt
      })
    } catch { /* Existing push state errors remain authoritative. */ }
    if (previous && previous !== next) {
      const closePrevious = () => { try { previous.close?.() } catch { /* provider is already detached */ } }
      if (this.activeFlush) void this.activeFlush.then(closePrevious, closePrevious)
      else closePrevious()
    }
    if (!this.isAnyProviderEnabled() && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.scheduleNextFlush()
    const enabled = this.isAnyProviderEnabled()
    if (enabled !== wasEnabled) {
      for (const listener of this.enabledListeners) {
        try { listener(enabled) } catch { /* Runtime listeners cannot undo a committed configuration. */ }
      }
    }
  }

  configureFCM(fcm?: FCMProviderConfig, configurationError?: string): Promise<void> {
    const operation = this.configurationOperation.then(() => this.applyFCMConfiguration(fcm, configurationError))
    this.configurationOperation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async applyFCMConfiguration(fcm?: FCMProviderConfig, configurationError?: string): Promise<void> {
    const wasEnabled = this.isAnyProviderEnabled()
    const previous = this.fcmProvider
    const next = fcm && !configurationError ? this.fcmProviderFactory(fcm) : undefined
    if (this.closed) {
      next?.close?.()
      return
    }
    this.providerGeneration += 1
    this.fcm = fcm
    this.fcmConfigurationError = configurationError
    this.fcmProvider = next
    delete this.runtimeErrors.android
    this.flushFailureCount.android = 0
    this.flushBlockedUntil.android = 0
    if (this.isAnyProviderEnabled()) {
      this.correlationError = undefined
      try { this.loadCorrelationSecret() } catch (cause) {
        this.correlationError = cause instanceof Error ? cause.message : 'Push correlation key is unavailable'
      }
    }
    try {
      this.store.mutate(state => {
        delete state.providerStatus.android.lastError
        delete state.providerStatus.android.lastErrorAt
      })
    } catch { /* Existing push state errors remain authoritative. */ }
    if (previous && previous !== next) {
      const closePrevious = () => { try { previous.close?.() } catch { /* provider is already detached */ } }
      if (this.activeFlush) void this.activeFlush.then(closePrevious, closePrevious)
      else closePrevious()
    }
    if (!this.isAnyProviderEnabled() && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.scheduleNextFlush()
    const enabled = this.isAnyProviderEnabled()
    if (enabled !== wasEnabled) {
      for (const listener of this.enabledListeners) {
        try { listener(enabled) } catch { /* Runtime listeners cannot undo a committed configuration. */ }
      }
    }
  }

  onEnabledChange(listener: (enabled: boolean) => void): () => void {
    this.enabledListeners.add(listener)
    return () => { this.enabledListeners.delete(listener) }
  }

  capabilities(): PushCapabilities {
    const configurationError = this.apnsConfigurationError ?? this.store.loadError
    const fcmConfigurationError = this.fcmConfigurationError ?? this.store.loadError
    const iosEnabled = Boolean(this.apns && this.provider && !configurationError)
    const androidEnabled = Boolean(this.fcm && this.fcmProvider && !fcmConfigurationError)
    return {
      protocolVersion: 1,
      enabled: iosEnabled,
      topic: this.apns?.topic ?? DEFAULT_APNS_TOPIC,
      environments: this.apns?.environments ?? ['development', 'production'],
      previewMode: 'title-and-summary',
      events: PUSH_EVENT_KINDS,
      maxSummaryCharacters: MAX_SUMMARY_CHARACTERS,
      maximumSummaryCharacters: MAX_SUMMARY_CHARACTERS,
      ...(configurationError ? { configurationError } : {}),
      platforms: {
        ios: {
          enabled: iosEnabled,
          provider: 'apns',
          topic: this.apns?.topic ?? DEFAULT_APNS_TOPIC,
          environments: this.apns?.environments ?? ['development', 'production'],
        },
        android: {
          enabled: androidEnabled,
          provider: 'fcm',
          packageName: this.fcm?.packageName ?? DEFAULT_FCM_PACKAGE_NAME,
          previewMode: 'title-and-summary',
          events: PUSH_EVENT_KINDS,
          maxSummaryCharacters: MAX_SUMMARY_CHARACTERS,
          maximumSummaryCharacters: MAX_SUMMARY_CHARACTERS,
          ...(fcmConfigurationError ? { configurationError: fcmConfigurationError } : {}),
        },
      },
    }
  }

  isAnyProviderEnabled(): boolean {
    const capabilities = this.capabilities()
    return capabilities.platforms.ios.enabled || capabilities.platforms.android.enabled
  }

  status(): PushStatus {
    const state = this.store.snapshot()
    const configurationError = this.apnsConfigurationError ?? this.store.loadError
    const stored = state.providerStatus.ios
    const runtimeError = this.runtimeErrors.ios
    const latestSuccess = stored.lastSuccessAt ? Date.parse(stored.lastSuccessAt) : 0
    const latestError = stored.lastErrorAt ? Date.parse(stored.lastErrorAt) : 0
    const configured = Boolean(this.apns && this.provider && !configurationError)
    return {
      configured,
      healthy: configured && !this.correlationError && !runtimeError && latestSuccess >= latestError,
      topic: this.apns?.topic ?? DEFAULT_APNS_TOPIC,
      environments: this.apns?.environments ?? ['development', 'production'],
      registrationCount: state.installations.filter(item => item.platform === 'ios').length,
      pendingCount: state.outbox.filter(item => item.platform === 'ios').length,
      subscriptionCount: state.groupSubscriptions.filter(item => item.enabled).length,
      ...(stored.lastSuccessAt ? { lastSuccessAt: stored.lastSuccessAt } : {}),
      ...(configurationError || this.correlationError || runtimeError?.message || stored.lastError
        ? { lastError: configurationError ?? this.correlationError ?? runtimeError?.message ?? stored.lastError }
        : {}),
      ...(runtimeError?.at || stored.lastErrorAt
        ? { lastErrorAt: runtimeError?.at ?? stored.lastErrorAt }
        : {}),
    }
  }

  fcmStatus(): FCMPushStatus {
    const state = this.store.snapshot()
    const configurationError = this.fcmConfigurationError ?? this.store.loadError
    const stored = state.providerStatus.android
    const runtimeError = this.runtimeErrors.android
    const latestSuccess = stored.lastSuccessAt ? Date.parse(stored.lastSuccessAt) : 0
    const latestError = stored.lastErrorAt ? Date.parse(stored.lastErrorAt) : 0
    const configured = Boolean(this.fcm && this.fcmProvider && !configurationError)
    return {
      configured,
      healthy: configured && !this.correlationError && !runtimeError && latestSuccess >= latestError,
      provider: 'fcm',
      packageName: this.fcm?.packageName ?? DEFAULT_FCM_PACKAGE_NAME,
      ...(this.fcm?.projectId ? { projectId: this.fcm.projectId } : {}),
      registrationCount: state.installations.filter(item => item.platform === 'android').length,
      pendingCount: state.outbox.filter(item => item.platform === 'android').length,
      subscriptionCount: state.groupSubscriptions.filter(item => item.enabled).length,
      ...(stored.lastSuccessAt ? { lastSuccessAt: stored.lastSuccessAt } : {}),
      ...(configurationError || this.correlationError || runtimeError?.message || stored.lastError
        ? { lastError: configurationError ?? this.correlationError ?? runtimeError?.message ?? stored.lastError }
        : {}),
      ...(runtimeError?.at || stored.lastErrorAt
        ? { lastErrorAt: runtimeError?.at ?? stored.lastErrorAt }
        : {}),
    }
  }

  registerInstallation(input: InstallationRegistration): PushInstallation {
    const userId = requiredIdentifier(input.userId, 'userId')
    const installationId = requiredIdentifier(input.installationId, 'installationId')
    const clientAccountId = requiredIdentifier(input.clientAccountId, 'clientAccountId')
    let target: Pick<AndroidInstallationRecord, 'platform' | 'fid'>
      | Pick<IOSInstallationRecord, 'platform' | 'deviceToken' | 'environment'>
    if (input.platform === 'android') {
      target = { platform: 'android', fid: normalizedFID(input.fid) }
    } else {
      if (input.environment !== 'development' && input.environment !== 'production') {
        throw new Error('environment is invalid')
      }
      target = {
        platform: 'ios',
        deviceToken: normalizedToken(input.deviceToken),
        environment: input.environment,
      }
    }
    const appVersion = input.appVersion
      ? requiredIdentifier(input.appVersion, 'appVersion', 64)
      : undefined
    const authorizationVersion = input.authorizationVersion
      ?? this.userAuthorizationVersion?.(userId)
    if (authorizationVersion !== undefined
      && (!Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1)) {
      throw new Error('authorizationVersion is invalid')
    }
    const updatedAt = new Date(this.now()).toISOString()
    const installation = this.store.mutate(state => {
      // Reinstalls and the native-to-Expo migration can create a new local ID for
      // the same APNs/FCM endpoint. Keep one registration per user/device/provider
      // environment so a single event cannot produce two background banners.
      const superseded = state.installations.filter(item => item.userId === userId
        && !(item.installationId === installationId && item.clientAccountId === clientAccountId)
        && (target.platform === 'ios'
          ? item.platform === 'ios' && item.deviceToken === target.deviceToken && item.environment === target.environment
          : item.platform === 'android' && item.fid === target.fid))
      if (superseded.length) {
        state.installations = state.installations.filter(item => !superseded.includes(item))
        state.outbox = state.outbox.filter(item => !superseded.some(old => old.userId === item.userId
          && old.installationId === item.installationId && old.clientAccountId === item.clientAccountId))
      }
      const existingIndex = state.installations.findIndex(item => item.userId === userId
        && item.installationId === installationId
        && item.clientAccountId === clientAccountId)
      if (existingIndex >= 0) {
        const existing = state.installations[existingIndex]!
        const base = {
          userId,
          installationId,
          clientAccountId,
          ...(authorizationVersion !== undefined ? { authorizationVersion } : {}),
          ...(appVersion ? { appVersion } : {}),
          badge: existing.badge,
          updatedAt,
        }
        const next: InstallationRecord = target.platform === 'android'
          ? { ...base, ...target }
          : { ...base, ...target }
        state.installations[existingIndex] = next
        if (existing.platform !== next.platform) {
          state.outbox = state.outbox.filter(item => !(item.userId === userId
            && item.installationId === installationId
            && item.clientAccountId === clientAccountId))
        }
        return publicInstallation(next)
      }
      if (state.installations.filter(item => item.userId === userId).length >= MAX_INSTALLATIONS_PER_USER) {
        throw new Error('Push installation limit reached')
      }
      const base = {
        userId,
        installationId,
        clientAccountId,
        ...(authorizationVersion !== undefined ? { authorizationVersion } : {}),
        ...(appVersion ? { appVersion } : {}),
        badge: 0,
        updatedAt,
      }
      const record: InstallationRecord = target.platform === 'android'
        ? { ...base, ...target }
        : { ...base, ...target }
      state.installations.push(record)
      return publicInstallation(record)
    })
    this.scheduleNextFlush()
    return installation
  }

  unregisterInstallation(userIdValue: string, installationIdValue: string, clientAccountIdValue: string): boolean {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const installationId = requiredIdentifier(installationIdValue, 'installationId')
    const clientAccountId = requiredIdentifier(clientAccountIdValue, 'clientAccountId')
    return this.store.mutate(state => {
      const before = state.installations.length
      state.installations = state.installations.filter(item => !(item.userId === userId
        && item.installationId === installationId
        && item.clientAccountId === clientAccountId))
      state.outbox = state.outbox.filter(item => !(item.userId === userId
        && item.installationId === installationId
        && item.clientAccountId === clientAccountId))
      return state.installations.length !== before
    })
  }

  private unreadCounter?: (owner: string) => number
  setUnreadCounter(counter: (owner: string) => number): void { this.unreadCounter = counter }
  resetBadge(userIdValue: string, installationIdValue: string, clientAccountIdValue: string): number {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const installationId = requiredIdentifier(installationIdValue, 'installationId')
    const clientAccountId = requiredIdentifier(clientAccountIdValue, 'clientAccountId')
    return this.store.mutate(state => {
      const installation = state.installations.find(item => item.userId === userId
        && item.installationId === installationId
        && item.clientAccountId === clientAccountId)
      const count = this.unreadCounter?.(userId) ?? 0
      if (installation) installation.badge = count
      return count
    })
  }

  listGroupSubscriptions(userIdValue: string): PushGroupSubscription[] {
    const userId = requiredIdentifier(userIdValue, 'userId')
    return this.store.snapshot().groupSubscriptions
      .filter(item => item.userId === userId)
      .map(({ roomId, enabled, updatedAt, lastMessageSeq }) => ({
        roomId, enabled, updatedAt, ...(lastMessageSeq !== undefined ? { lastMessageSeq } : {}),
      }))
      .sort((left, right) => left.roomId.localeCompare(right.roomId))
  }

  setGroupSubscription(
    userIdValue: string,
    roomIdValue: string,
    enabled: boolean,
    baselineMessageSeq?: number,
  ): PushGroupSubscription {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    if (baselineMessageSeq !== undefined && (!Number.isSafeInteger(baselineMessageSeq) || baselineMessageSeq < 0)) {
      throw new Error('baselineMessageSeq is invalid')
    }
    const updatedAt = new Date(this.now()).toISOString()
    return this.store.mutate(state => {
      const existing = state.groupSubscriptions.find(item => item.userId === userId && item.roomId === roomId)
      if (existing) {
        if (!enabled) {
          state.groupSubscriptions = state.groupSubscriptions.filter(item => !(item.userId === userId && item.roomId === roomId))
          state.outbox = state.outbox.filter(item => !(item.userId === userId && item.roomId === roomId))
          return { roomId, enabled: false, updatedAt }
        }
        if (existing.enabled === enabled) {
          return {
            roomId, enabled: existing.enabled, updatedAt: existing.updatedAt,
            ...(existing.lastMessageSeq !== undefined ? { lastMessageSeq: existing.lastMessageSeq } : {}),
          }
        }
        existing.enabled = enabled
        existing.updatedAt = updatedAt
        if (enabled && baselineMessageSeq !== undefined) existing.lastMessageSeq = baselineMessageSeq
      } else {
        if (!enabled) return { roomId, enabled: false, updatedAt }
        const count = state.groupSubscriptions.filter(item => item.userId === userId && item.enabled).length
        if (count >= MAX_GROUP_SUBSCRIPTIONS_PER_USER) throw new Error('Group push subscription limit reached')
        state.groupSubscriptions.push({
          userId, roomId, enabled, updatedAt,
          ...(enabled && baselineMessageSeq !== undefined ? { lastMessageSeq: baselineMessageSeq } : {}),
        })
      }
      const saved = state.groupSubscriptions.find(item => item.userId === userId && item.roomId === roomId)!
      return {
        roomId, enabled, updatedAt,
        ...(saved.lastMessageSeq !== undefined ? { lastMessageSeq: saved.lastMessageSeq } : {}),
      }
    })
  }

  isGroupSubscribed(userIdValue: string, roomIdValue: string): boolean {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    return this.store.snapshot().groupSubscriptions.some(item => item.userId === userId
      && item.roomId === roomId
      && item.enabled)
  }

  groupSubscriptionStartedAt(userIdValue: string, roomIdValue: string): number | undefined {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    const subscription = this.store.snapshot().groupSubscriptions.find(item => item.userId === userId
      && item.roomId === roomId
      && item.enabled)
    if (!subscription) return undefined
    const value = Date.parse(subscription.updatedAt)
    return Number.isNaN(value) ? undefined : value
  }

  groupSubscriptionLastMessageSeq(userIdValue: string, roomIdValue: string): number | undefined {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    return this.store.snapshot().groupSubscriptions.find(item => item.userId === userId
      && item.roomId === roomId
      && item.enabled)?.lastMessageSeq
  }

  advanceGroupSubscriptionMessageSeq(userIdValue: string, roomIdValue: string, sequence: number): void {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('message sequence is invalid')
    const snapshot = this.store.snapshot().groupSubscriptions.find(item => item.userId === userId
      && item.roomId === roomId
      && item.enabled)
    if (!snapshot || (snapshot.lastMessageSeq ?? -1) >= sequence) return
    this.store.mutate(state => {
      const subscription = state.groupSubscriptions.find(item => item.userId === userId
        && item.roomId === roomId
        && item.enabled)
      if (subscription && (subscription.lastMessageSeq ?? -1) < sequence) subscription.lastMessageSeq = sequence
    })
  }

  subscribedUserIds(roomIdValue: string): string[] {
    const roomId = requiredIdentifier(roomIdValue, 'roomId')
    return [...new Set(this.store.snapshot().groupSubscriptions
      .filter(item => item.roomId === roomId && item.enabled)
      .map(item => item.userId))]
  }

  activeGroupSubscriptions(): Array<PushGroupSubscription & { userId: string }> {
    return this.store.snapshot().groupSubscriptions
      .filter(item => item.enabled)
      .map(({ userId, roomId, enabled, updatedAt, lastMessageSeq }) => ({
        userId, roomId, enabled, updatedAt,
        ...(lastMessageSeq !== undefined ? { lastMessageSeq } : {}),
      }))
      .sort((left, right) => left.roomId.localeCompare(right.roomId) || left.userId.localeCompare(right.userId))
  }

  groupSubscribers(roomIdValue: string): readonly string[] {
    return this.subscribedUserIds(roomIdValue)
  }

  groupWatchAnchor(): PushGroupWatchAnchor | undefined {
    const anchor = this.store.snapshot().groupWatch
    return anchor ? { ...anchor } : undefined
  }

  resetGroupWatch(anchor: PushGroupWatchAnchor): PushGroupWatchAnchor {
    const next = canonicalGroupWatchAnchor(anchor, this.now())
    return this.store.mutate(state => {
      state.groupWatch = next
      return { ...next }
    })
  }

  resetGroupCursor(anchor: PushGroupWatchAnchor): PushGroupWatchAnchor {
    return this.resetGroupWatch(anchor)
  }

  advanceGroupWatch(anchor: PushGroupWatchAnchor): PushGroupWatchAnchor {
    const next = canonicalGroupWatchAnchor(anchor, this.now())
    return this.store.mutate(state => {
      if (state.groupWatch && state.groupWatch.epoch !== next.epoch) {
        throw new Error('group watch epoch changed without reset')
      }
      if (state.groupWatch && next.cursor < state.groupWatch.cursor) {
        throw new Error('group watch cursor cannot move backwards')
      }
      state.groupWatch = next
      return { ...next }
    })
  }

  advanceGroupCursor(anchor: PushGroupWatchAnchor): void {
    this.advanceGroupWatch(anchor)
  }

  upsertChatJob(input: PushChatJob): PushChatJob {
    const job = canonicalChatJob(input)
    return this.store.mutate(state => {
      const existingIndex = state.chatJobs.findIndex(item => item.id === job.id)
      if (existingIndex >= 0 && state.chatJobs[existingIndex]!.localUserID !== job.localUserID) {
        throw new Error('job.id is already owned by another user')
      }
      if (existingIndex >= 0) state.chatJobs[existingIndex] = job
      else {
        if (state.chatJobs.filter(item => item.localUserID === job.localUserID).length >= MAX_CHAT_JOBS_PER_USER) {
          throw new Error('Chat push job limit reached')
        }
        state.chatJobs.push(job)
      }
      if (job.storedSessionID) {
        for (const [sessionID, observedAt] of Object.entries(state.ambiguousChatSessions)) {
          if (!Number.isFinite(observedAt) || observedAt < this.now() - AMBIGUOUS_CHAT_SESSION_TTL_MS) {
            delete state.ambiguousChatSessions[sessionID]
          }
        }
        const owners = new Set(state.chatJobs
          .filter(item => item.storedSessionID === job.storedSessionID)
          .map(item => item.localUserID))
        if (owners.size > 1) {
          const entries = Object.entries(state.ambiguousChatSessions)
          if (entries.length >= MAX_AMBIGUOUS_CHAT_SESSIONS
            && state.ambiguousChatSessions[job.storedSessionID] === undefined) {
            state.chatRecoveryDisabledUntil = this.now() + AMBIGUOUS_CHAT_SESSION_TTL_MS
          } else {
            state.ambiguousChatSessions[job.storedSessionID] = this.now()
          }
        }
      }
      return { ...job }
    })
  }

  saveChatJob(input: PushChatJob): void {
    this.upsertChatJob(input)
  }

  listChatJobs(userIdValue?: string): PushChatJob[] {
    const userId = userIdValue ? requiredIdentifier(userIdValue, 'userId') : undefined
    const now = this.now()
    return this.store.snapshot().chatJobs
      .filter(item => item.expiresAt > now && (!userId || item.localUserID === userId))
      .sort((left, right) => left.submittedAt - right.submittedAt)
      .map(item => ({ ...item, ...(item.metadata ? { metadata: { ...item.metadata } } : {}) }))
  }

  pendingChatJobs(): readonly PushChatJob[] {
    const now = this.now()
    const snapshot = this.store.snapshot()
    if (snapshot.chatJobs.some(item => item.expiresAt <= now)) {
      this.store.mutate(state => {
        state.chatJobs = state.chatJobs.filter(item => item.expiresAt > now)
      })
    }
    return this.listChatJobs()
  }

  chatJobRecoveryAllowed(job: PushChatJob): boolean {
    if (!job.storedSessionID) return false
    const state = this.store.snapshot()
    if ((state.chatRecoveryDisabledUntil ?? 0) > this.now()) return false
    if (state.ambiguousChatSessions[job.storedSessionID] !== undefined) return false
    const owners = new Set(state.chatJobs
      .filter(item => item.storedSessionID === job.storedSessionID)
      .map(item => item.localUserID))
    return owners.size === 1 && owners.has(job.localUserID)
  }

  promptDigest(userIdValue: string, prompt: string): string {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const normalized = prompt.trim().replace(/\r\n/g, '\n')
    if (!normalized || normalized.length > 200_000) throw new Error('prompt is invalid')
    if (this.correlationError) throw new Error(this.correlationError)
    return createHmac('sha256', this.loadCorrelationSecret())
      .update(userId, 'utf8')
      .update('\0', 'utf8')
      .update(normalized, 'utf8')
      .digest('base64url')
  }

  completeChatJob(jobId: string): void
  completeChatJob(userId: string, jobId: string): void
  completeChatJob(userOrJobId: string, optionalJobId?: string): void {
    const jobId = requiredIdentifier(optionalJobId ?? userOrJobId, 'jobId', 512)
    const userId = optionalJobId ? requiredIdentifier(userOrJobId, 'userId') : undefined
    this.store.mutate(state => {
      state.chatJobs = state.chatJobs.filter(item => !(item.id === jobId && (!userId || item.localUserID === userId)))
    })
  }

  removeUser(userIdValue: string): { registrations: number; subscriptions: number; pending: number } {
    const userId = requiredIdentifier(userIdValue, 'userId')
    const prefix = dedupePrefix(userId)
    return this.store.mutate(state => {
      const registrations = state.installations.filter(item => item.userId === userId).length
      const subscriptions = state.groupSubscriptions.filter(item => item.userId === userId).length
      const pending = state.outbox.filter(item => item.userId === userId).length
      state.installations = state.installations.filter(item => item.userId !== userId)
      state.groupSubscriptions = state.groupSubscriptions.filter(item => item.userId !== userId)
      state.outbox = state.outbox.filter(item => item.userId !== userId)
      state.chatJobs = state.chatJobs.filter(item => item.localUserID !== userId)
      for (const key of Object.keys(state.processedEvents)) {
        if (key.startsWith(prefix)) delete state.processedEvents[key]
      }
      return { registrations, subscriptions, pending }
    })
  }

  enqueueNotification(input: PushNotificationCandidate): 'enqueued' | 'duplicate' | 'ignored' {
    const userId = requiredIdentifier(input.localUserID, 'localUserID')
    const eventId = requiredIdentifier(input.eventID, 'eventID', 512)
    if (this.store.snapshot().processedEvents[dedupeKey(userId, eventId)] !== undefined) return 'duplicate'
    const count = this.enqueue({
      eventId,
      userId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      data: input.data,
      collapseId: input.collapseID,
      ...(input.roomID ? { roomId: input.roomID } : {}),
      ...((input.topicID || input.roomID) ? { threadId: input.topicID ?? input.roomID } : {}),
    })
    return count > 0 ? 'enqueued' : 'ignored'
  }

  enqueueGroupEvent(input: PushNotificationCandidate & { roomID: string }): 'enqueued' | 'duplicate' | 'ignored' {
    if (!this.isGroupSubscribed(input.localUserID, input.roomID)) return 'ignored'
    return this.enqueueNotification(input)
  }

  enqueueChatCandidate(input: PushNotificationCandidate): 'enqueued' | 'duplicate' | 'ignored' {
    return this.enqueueNotification(input)
  }

  enqueue(input: PushNotification): number {
    if (!this.isAnyProviderEnabled()) return 0
    const eventId = requiredIdentifier(input.eventId, 'eventId', 512)
    const userId = requiredIdentifier(input.userId, 'userId')
    try {
      if (!this.isUserActive(userId)) return 0
    } catch {
      return 0
    }
    if (!PUSH_EVENT_KINDS.includes(input.kind)) throw new Error('kind is invalid')
    const title = notificationPlainText(input.title, { fallback: '新消息', maximum: 120 })
    const body = notificationPlainText(input.body, {
      fallback: '请打开夭夭查看详情', maximum: MAX_SUMMARY_CHARACTERS,
    })
    const clientAccountId = input.clientAccountId
      ? requiredIdentifier(input.clientAccountId, 'clientAccountId')
      : undefined
    const roomId = input.roomId ? requiredIdentifier(input.roomId, 'roomId') : undefined
    const collapseId = input.collapseId ? requiredIdentifier(input.collapseId, 'collapseId', 64) : undefined
    if (collapseId && Buffer.byteLength(collapseId, 'utf8') > 64) throw new Error('collapseId is too long')
    const threadId = input.threadId ? requiredIdentifier(input.threadId, 'threadId', 512) : undefined
    let data: Record<string, unknown> = {}
    if (input.data) {
      const encoded = JSON.stringify(input.data)
      if (encoded === undefined) throw new Error('data must be JSON serializable')
      data = JSON.parse(encoded) as Record<string, unknown>
    }
    const now = this.now()
    const expiresAt = input.expiresAt ?? now + DEFAULT_EVENT_LIFETIME_MS
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('expiresAt must be in the future')
    const capabilities = this.capabilities()
    const allowedEnvironments = new Set(capabilities.environments)
    const queued = this.store.mutate(state => {
      for (const [key, processedAt] of Object.entries(state.processedEvents)) {
        if (!Number.isFinite(processedAt) || processedAt < now - DEDUPE_LIFETIME_MS) delete state.processedEvents[key]
      }
      const processed = Object.entries(state.processedEvents)
      if (processed.length >= MAX_PROCESSED_EVENTS) {
        processed.sort((left, right) => left[1] - right[1])
        for (const [expiredKey] of processed.slice(0, processed.length - MAX_PROCESSED_EVENTS + 1)) {
          delete state.processedEvents[expiredKey]
        }
      }
      const key = dedupeKey(userId, eventId)
      if (state.processedEvents[key] !== undefined) return 0
      const targets = state.installations.filter(item => item.userId === userId
        && this.registrationIsAuthorized(item)
        && (item.platform === 'ios'
          ? capabilities.platforms.ios.enabled && allowedEnvironments.has(item.environment)
          : capabilities.platforms.android.enabled)
        && (!clientAccountId || item.clientAccountId === clientAccountId))
      if (state.outbox.length + targets.length > MAX_OUTBOX_ITEMS) throw new Error('Push outbox limit reached')
      state.processedEvents[key] = now
      for (const target of targets) {
        target.badge = this.unreadCounter ? this.unreadCounter(userId) : target.badge + 1
        state.outbox.push({
          id: randomUUID(),
          eventId,
          userId,
          installationId: target.installationId,
          clientAccountId: target.clientAccountId,
          platform: target.platform,
          kind: input.kind,
          title,
          body,
          data,
          ...(collapseId ? { collapseId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(roomId ? { roomId } : {}),
          createdAt: now,
          expiresAt,
          attempts: 0,
          nextAttemptAt: now,
        })
      }
      return targets.length
    })
    this.scheduleNextFlush()
    return queued
  }

  flushDue(): Promise<PushFlushResult> {
    if (this.activeFlush) return this.activeFlush
    if (this.closed || !this.isAnyProviderEnabled()) {
      return Promise.resolve({ delivered: 0, retried: 0, removedRegistrations: 0, failed: 0 })
    }
    const generation = this.providerGeneration
    this.activeFlush = this.flushInternal(generation)
      .then(result => {
        if (generation === this.providerGeneration) {
          for (const platform of ['ios', 'android'] as const) {
            this.flushFailureCount[platform] = 0
            this.flushBlockedUntil[platform] = 0
            delete this.runtimeErrors[platform]
          }
        }
        return result
      })
      .catch(cause => {
        if (generation === this.providerGeneration) {
          for (const platform of ['ios', 'android'] as const) {
            if (!this.platformEnabled(platform)) continue
            this.flushFailureCount[platform] += 1
            const delay = Math.min(60_000, 1_000 * (2 ** Math.min(this.flushFailureCount[platform] - 1, 6)))
            this.flushBlockedUntil[platform] = this.now() + delay
            this.recordRuntimeError(platform, cause)
          }
        }
        throw cause
      })
      .finally(() => {
        this.activeFlush = undefined
        this.scheduleNextFlush()
      })
    return this.activeFlush
  }

  private async flushInternal(generation: number): Promise<PushFlushResult> {
    const summary: PushFlushResult = { delivered: 0, retried: 0, removedRegistrations: 0, failed: 0 }
    const due = this.store.snapshot().outbox
      .filter(item => item.nextAttemptAt <= this.now()
        && this.platformEnabled(item.platform)
        && this.flushBlockedUntil[item.platform] <= this.now())
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)
      .slice(0, 100)
    for (const candidate of due) {
      if (this.closed) break
      const state = this.store.snapshot()
      const item = state.outbox.find(current => current.id === candidate.id)
      if (!item) continue
      let userActive = false
      try { userActive = this.isUserActive(item.userId) } catch { userActive = false }
      if (!userActive) {
        this.store.mutate(current => {
          current.installations = current.installations.filter(entry => entry.userId !== item.userId)
          current.groupSubscriptions = current.groupSubscriptions.filter(entry => entry.userId !== item.userId)
          current.outbox = current.outbox.filter(entry => entry.userId !== item.userId)
          current.chatJobs = current.chatJobs.filter(entry => entry.localUserID !== item.userId)
        })
        summary.failed += 1
        continue
      }
      const installation = state.installations.find(current => current.userId === item.userId
        && current.installationId === item.installationId
        && current.clientAccountId === item.clientAccountId)
      if (installation && !this.registrationIsAuthorized(installation)) {
        this.store.mutate(current => {
          current.installations = current.installations.filter(entry => !(entry.userId === item.userId
            && entry.installationId === item.installationId
            && entry.clientAccountId === item.clientAccountId))
          current.outbox = current.outbox.filter(entry => !(entry.userId === item.userId
            && entry.installationId === item.installationId
            && entry.clientAccountId === item.clientAccountId))
        })
        summary.failed += 1
        continue
      }
      if (installation && installation.platform !== item.platform) {
        this.store.mutate(current => { current.outbox = current.outbox.filter(entry => entry.id !== item.id) })
        summary.failed += 1
        continue
      }
      if (installation?.platform === 'ios'
        && !this.capabilities().environments.includes(installation.environment)) {
        this.store.mutate(current => { current.outbox = current.outbox.filter(entry => entry.id !== item.id) })
        summary.failed += 1
        continue
      }
      const subscribed = !item.roomId || state.groupSubscriptions.some(subscription => subscription.userId === item.userId
        && subscription.roomId === item.roomId
        && subscription.enabled)
      if (!installation || !subscribed || item.expiresAt <= this.now()) {
        this.store.mutate(current => { current.outbox = current.outbox.filter(entry => entry.id !== item.id) })
        summary.failed += 1
        continue
      }
      let result: APNsSendResult
      try {
        result = installation.platform === 'ios'
          ? await this.provider!.send({
              deviceToken: installation.deviceToken,
              environment: installation.environment,
              payload: {
                ...item.data,
                aps: {
                  alert: { title: item.title, body: item.body },
                  sound: 'default',
                  badge: this.unreadCounter ? this.unreadCounter(item.userId) : installation.badge,
                  ...(item.threadId ? { 'thread-id': item.threadId } : {}),
                },
                version: 1,
                eventId: item.eventId,
                kind: item.kind,
                clientAccountId: item.clientAccountId,
              },
              apnsId: item.id,
              ...(item.collapseId ? { collapseId: item.collapseId } : {}),
              expiration: Math.floor(item.expiresAt / 1_000),
            })
          : await this.fcmProvider!.send({
              fid: installation.fid,
              data: this.fcmData(item),
              ttlSeconds: Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1_000)),
              priority: 'high',
            })
      } catch (cause) {
        // Provider implementations normally return a classified result, but a
        // programming/runtime exception in one sender must not starve the
        // other platform's durable queue.
        result = {
          disposition: 'retry',
          status: 0,
          reason: safeProviderException(cause, installation),
        }
      }
      const at = new Date(this.now()).toISOString()
      if (generation !== this.providerGeneration) {
        if (result.disposition === 'success') {
          this.store.mutate(current => {
            current.outbox = current.outbox.filter(entry => entry.id !== item.id)
            current.providerStatus[item.platform].lastSuccessAt = at
          })
          summary.delivered += 1
        } else {
          this.store.mutate(current => {
            const pending = current.outbox.find(entry => entry.id === item.id)
            if (pending) pending.nextAttemptAt = this.now()
          })
          summary.retried += 1
        }
        break
      }
      if (result.disposition === 'success') {
        this.store.mutate(current => {
          current.outbox = current.outbox.filter(entry => entry.id !== item.id)
          current.providerStatus[item.platform].lastSuccessAt = at
        })
        summary.delivered += 1
      } else if (result.disposition === 'unregister') {
        let registrationRotated = false
        this.store.mutate(current => {
          const latest = current.installations.find(entry => entry.userId === item.userId
            && entry.installationId === item.installationId
            && entry.clientAccountId === item.clientAccountId)
          registrationRotated = Boolean(latest && this.registrationIdentity(latest) !== this.registrationIdentity(installation))
          if (registrationRotated) {
            const pending = current.outbox.find(entry => entry.id === item.id)
            if (pending) {
              pending.attempts = 0
              pending.nextAttemptAt = this.now()
            }
            return
          }
          current.installations = current.installations.filter(entry => !(entry.userId === item.userId
            && entry.installationId === item.installationId
            && entry.clientAccountId === item.clientAccountId))
          current.outbox = current.outbox.filter(entry => !(entry.userId === item.userId
            && entry.installationId === item.installationId
            && entry.clientAccountId === item.clientAccountId))
        })
        if (registrationRotated) summary.retried += 1
        else summary.removedRegistrations += 1
      } else if (result.disposition === 'retry' || result.disposition === 'configuration') {
        const attempts = item.attempts + 1
        const exhausted = attempts >= this.maxAttempts || item.expiresAt <= this.now()
        const delay = Math.min(
          this.maxRetryMilliseconds,
          Math.max(result.retryAfterMs ?? 0, this.baseRetryMilliseconds * (2 ** Math.max(0, attempts - 1))),
        )
        this.store.mutate(current => {
          const pending = current.outbox.find(entry => entry.id === item.id)
          if (pending) {
            if (exhausted) current.outbox = current.outbox.filter(entry => entry.id !== item.id)
            else {
              pending.attempts = attempts
              pending.nextAttemptAt = this.now() + delay
            }
          }
          current.providerStatus[item.platform].lastError = safeError(result, item.platform)
          current.providerStatus[item.platform].lastErrorAt = at
        })
        if (exhausted) summary.failed += 1
        else summary.retried += 1
      } else {
        this.store.mutate(current => {
          current.outbox = current.outbox.filter(entry => entry.id !== item.id)
          current.providerStatus[item.platform].lastError = safeError(result, item.platform)
          current.providerStatus[item.platform].lastErrorAt = at
        })
        summary.failed += 1
      }
    }
    return summary
  }

  private platformEnabled(platform: PushPlatform): boolean {
    const capabilities = this.capabilities()
    return platform === 'ios' ? capabilities.platforms.ios.enabled : capabilities.platforms.android.enabled
  }

  private registrationIdentity(installation: InstallationRecord): string {
    return installation.platform === 'ios'
      ? `ios:${installation.environment}:${installation.deviceToken}`
      : `android:${installation.fid}`
  }

  private fcmData(item: OutboxRecord): Record<string, string> {
    const data: Record<string, string> = {}
    for (const [key, value] of Object.entries(item.data)) {
      if (value === undefined || value === null) continue
      if (typeof value === 'string') data[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') data[key] = String(value)
      else data[key] = JSON.stringify(value)
    }
    return {
      ...data,
      version: '1',
      eventId: item.eventId,
      kind: item.kind,
      clientAccountId: item.clientAccountId,
      title: item.title,
      body: item.body,
      ...(item.collapseId ? { collapseId: item.collapseId } : {}),
      ...(item.threadId ? { threadId: item.threadId } : {}),
      ...(item.roomId ? { roomId: item.roomId } : {}),
    }
  }

  private scheduleNextFlush(): void {
    if (!this.autoFlush || this.closed || !this.isAnyProviderEnabled() || this.activeFlush) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const next = this.store.snapshot().outbox.reduce<number | undefined>((earliest, item) => {
      if (!this.platformEnabled(item.platform)) return earliest
      const attemptAt = Math.max(item.nextAttemptAt, this.flushBlockedUntil[item.platform])
      return earliest === undefined || attemptAt < earliest ? attemptAt : earliest
    }, undefined)
    if (next === undefined) return
    const delay = Math.max(0, Math.min(2_147_483_647, next - this.now()))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flushDue().catch(() => undefined)
    }, delay)
    this.timer.unref()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.provider?.close?.()
    this.fcmProvider?.close?.()
    this.enabledListeners.clear()
  }

  private recordRuntimeError(platform: PushPlatform, cause: unknown): void {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const message = raw
      .replace(/[a-fA-F0-9]{32,}/g, '[redacted]')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500) || '推送后台任务失败'
    const at = new Date(this.now()).toISOString()
    this.runtimeErrors[platform] = { message, at }
    try {
      this.store.mutate(state => {
        state.providerStatus[platform].lastError = message
        state.providerStatus[platform].lastErrorAt = at
      })
    } catch {
      // The in-memory status remains available when the push state volume is
      // the reason persistence failed. Never let optional push stop 15300.
    }
  }

  private registrationIsAuthorized(installation: InstallationRecord): boolean {
    if (!this.userAuthorizationVersion) return true
    try {
      const current = this.userAuthorizationVersion(installation.userId)
      return current !== undefined && installation.authorizationVersion === current
    } catch {
      return false
    }
  }

  private markPersistedJobsDisconnected(): void {
    try {
      const jobs = this.store.snapshot().chatJobs
      if (!jobs.some(job => !Number.isFinite(Number(job.metadata?.disconnectedAt)))) return
      const disconnectedAt = this.now()
      this.store.mutate(state => {
        state.chatJobs = state.chatJobs.map(job => ({
          ...job,
          metadata: {
            ...job.metadata,
            disconnectedAt: Number.isFinite(Number(job.metadata?.disconnectedAt))
              ? job.metadata!.disconnectedAt
              : disconnectedAt,
            recoveredAfterRestart: true,
          },
        }))
      })
    } catch {
      // A corrupt/unwritable optional push state already disables recovery.
    }
  }

  private loadCorrelationSecret(): Buffer {
    if (this.correlationSecret) return this.correlationSecret
    const path = join(this.options.home, 'push', 'correlation.key')
    try {
      const existing = readFileSync(path)
      if (existing.byteLength !== 32) throw new Error('Push correlation key has an invalid length')
      chmodSync(path, 0o600)
      this.correlationSecret = existing
      return existing
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const generated = randomBytes(32)
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, 'wx', 0o600)
      writeFileSync(descriptor, generated)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.correlationSecret = generated
      return generated
    } catch (cause) {
      if (descriptor !== undefined) closeSync(descriptor)
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = readFileSync(path)
        if (existing.byteLength !== 32) throw new Error('Push correlation key has an invalid length')
        this.correlationSecret = existing
        return existing
      }
      throw cause
    }
  }
}
