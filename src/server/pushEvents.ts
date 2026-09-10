import { createHash, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { isSupportedGroupProtocolVersion } from '../shared/types.js'
import type { ServerConfig } from './config.js'
import type { UpstreamServiceSession } from './localAuth.js'
import type { PushCoordinator as PersistentPushCoordinator } from './pushCoordinator.js'
import { notificationPlainText } from './notificationText.js'

type MaybePromise<T> = T | Promise<T>
type JsonRecord = Record<string, unknown>

export interface ChatRelayIdentity {
  localUserID: string
  connectionID?: string
  accountKey?: string
  source: 'web' | 'gateway' | 'paired'
}

interface ChatObservationBase {
  localUserID: string
  connectionID: string
  accountKey?: string
  source: ChatRelayIdentity['source']
  observedAt: number
}

export type ChatPushObservation = ChatObservationBase & (
  | {
    type: 'chat.session_opened'
    action: 'create' | 'resume'
    profile: string
    runtimeSessionID: string
    storedSessionID: string
  }
  | {
    type: 'chat.prompt'
    phase: 'submitted' | 'accepted' | 'rejected'
    requestID: string
    profile?: string
    runtimeSessionID: string
    storedSessionID?: string
    queued: boolean
    status?: string
    error?: string
  }
  | {
    type: 'chat.rpc_event'
    eventType: string
    profile?: string
    runtimeSessionID?: string
    storedSessionID?: string
    payload: JsonRecord
  }
  | {
    type: 'chat.disconnected'
    activeSessions: Array<{
      profile: string
      runtimeSessionID: string
      storedSessionID: string
    }>
  }
)

type ChatObservationPayload = ChatPushObservation extends infer Observation
  ? Observation extends ChatObservationBase
    ? Omit<Observation, keyof ChatObservationBase>
    : never
  : never

export interface GroupWatchAnchor {
  epoch: string
  cursor: number
}

export interface GroupWatchReset extends GroupWatchAnchor {
  reason: string
}

export interface ChatPushJob {
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

interface NotificationCandidateBase {
  eventID: string
  localUserID: string
  title: string
  body: string
  collapseID: string
  data: Record<string, string>
}

export interface ChatPushCandidate extends NotificationCandidateBase {
  kind: 'chat.completed' | 'chat.failed' | 'chat.approval.requested' | 'chat.clarification.requested'
  jobID: string
  profile?: string
  sessionID?: string
  requestID?: string
}

export interface GroupPushCandidate {
  eventID: NotificationCandidateBase['eventID']
  localUserID: NotificationCandidateBase['localUserID']
  title: NotificationCandidateBase['title']
  body: NotificationCandidateBase['body']
  collapseID: NotificationCandidateBase['collapseID']
  data: NotificationCandidateBase['data']
  kind: 'group.message.completed' | 'group.message.failed' | 'group.interaction.requested'
  epoch?: string
  cursor?: number
  roomID: string
  topicID?: string
  messageID?: string
  messageSequence?: number
  interactionID?: string
  interactionKind?: 'approval' | 'clarification' | 'unknown'
  senderName?: string
  content?: string
  error?: string
  occurredAt?: number
}

export type PushNotificationCandidate = ChatPushCandidate | GroupPushCandidate

/**
 * Persistence and delivery boundary used by the relay and the group watcher.
 * Implementations must durably deduplicate `enqueueNotification` by
 * `localUserID + eventID`. `advanceGroupCursor` is called only after every
 * candidate for that cursor has been durably accepted by the outbox.
 */
export interface PushEventCoordinator {
  observeChat?(observation: ChatPushObservation): MaybePromise<void>
  saveChatJob(job: ChatPushJob): MaybePromise<void>
  completeChatJob(jobID: string): MaybePromise<void>
  pendingChatJobs(): MaybePromise<readonly ChatPushJob[]>
  recoverChatJob?(job: ChatPushJob): MaybePromise<void>
  promptDigest?(localUserID: string, prompt: string): MaybePromise<string>
  canRecoverChatJob?(job: ChatPushJob): MaybePromise<boolean>
  enqueueNotification(candidate: PushNotificationCandidate): MaybePromise<'enqueued' | 'duplicate' | 'ignored' | void>
}

/** Keep the event pipeline decoupled from the concrete persistent coordinator. */
export function createPushEventCoordinator(push: PersistentPushCoordinator): PushEventCoordinator {
  return {
    saveChatJob: job => { push.saveChatJob(job) },
    completeChatJob: jobID => { push.completeChatJob(jobID) },
    pendingChatJobs: () => push.pendingChatJobs(),
    promptDigest: (localUserID, prompt) => push.promptDigest(localUserID, prompt),
    canRecoverChatJob: job => push.chatJobRecoveryAllowed(job),
    enqueueNotification: candidate => push.enqueueNotification(candidate),
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requestID(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function errorMessage(value: unknown): string {
  const source = record(value)
  return string(source.message ?? source.error) || (value == null ? '' : String(value))
}

function summary(value: unknown, fallback: string): string {
  return notificationPlainText(value, { fallback, maximum: 180 })
}

function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function collapseID(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 32)}`
}

function notificationData(
  eventID: string,
  kind: PushNotificationCandidate['kind'],
  localUserID: string,
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(Object.entries({
    version: '1', eventId: eventID, kind, clientAccountId: localUserID, ...values,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
}

interface SessionIdentity {
  profile: string
  runtimeSessionID: string
  storedSessionID: string
  baseline?: ChatMessageBaseline
  baselinePromise?: Promise<ChatMessageBaseline>
}

interface PendingSessionOpen {
  action: 'create' | 'resume'
  profile: string
  requestedStoredSessionID: string
}

interface PendingPrompt {
  requestID: string
  runtimeSessionID: string
  storedSessionID?: string
  profile?: string
  queued: boolean
  job: ChatPushJob
}

export interface ChatTerminalContent {
  title?: string
  body?: string
  messageID?: string
  timestamp?: number
  confirmed?: boolean
  failed?: boolean
  error?: string
  correlated?: boolean
}

export interface ChatMessageBaseline {
  messageID?: string
  sequence?: number
  total: number
  assistantCount: number
  lastRowSequence?: number
}

export interface ChatNotificationResolver {
  captureBaseline?(job: ChatPushJob): Promise<ChatMessageBaseline>
  resolveTerminal(job: ChatPushJob, eventType: string, payload: JsonRecord): Promise<ChatTerminalContent>
}

/** Observes one already-authorized chat relay without changing its protocol. */
export class ChatPushRelayObserver {
  readonly #connectionID: string
  readonly #sessions = new Map<string, SessionIdentity>()
  readonly #pendingSessionOpens = new Map<string, PendingSessionOpen>()
  readonly #pendingPrompts = new Map<string, PendingPrompt>()
  readonly #jobsByRuntimeSession = new Map<string, ChatPushJob[]>()
  readonly #terminalJobIDs = new Set<string>()
  #closed = false
  #delivery = Promise.resolve()

  constructor(
    readonly coordinator: PushEventCoordinator,
    readonly identity: ChatRelayIdentity,
    readonly now: () => number = Date.now,
    readonly notificationResolver?: ChatNotificationResolver,
  ) {
    this.#connectionID = identity.connectionID ?? randomUUID().toLowerCase()
  }

  observeClientFrame(frameText: string): void {
    if (this.#closed) return
    let frame: JsonRecord
    try { frame = record(JSON.parse(frameText)) } catch { return }
    const method = string(frame.method)
    const id = requestID(frame.id)
    const params = record(frame.params)
    if ((method === 'session.create' || method === 'session.resume') && id) {
      this.#pendingSessionOpens.set(id, {
        action: method === 'session.create' ? 'create' : 'resume',
        profile: string(params.profile),
        requestedStoredSessionID: method === 'session.resume' ? string(params.session_id) : '',
      })
      return
    }
    if (method !== 'prompt.submit' || !id) return
    const runtimeSessionID = string(params.session_id)
    if (!runtimeSessionID) return
    const session = this.#sessions.get(runtimeSessionID)
    let job: ChatPushJob = {
      id: randomUUID().toLowerCase(),
      localUserID: this.identity.localUserID,
      profile: session?.profile,
      runtimeSessionID,
      storedSessionID: session?.storedSessionID,
      requestID: id,
      queued: params.queued === true,
      phase: 'submitted',
      submittedAt: this.now(),
      expiresAt: this.now() + 24 * 60 * 60 * 1_000,
    }
    if (this.coordinator.promptDigest) {
      try {
        const digest = this.coordinator.promptDigest(
          this.identity.localUserID,
          string(params.text),
        )
        if (typeof digest === 'string' && digest) {
          job = { ...job, metadata: { ...job.metadata, promptDigest: digest } }
        }
      } catch { /* Missing correlation fails closed without blocking chat. */ }
    }
    if (session?.baseline) {
      const baseline = session.baseline
      job = {
        ...job,
        metadata: {
          ...job.metadata,
          baselineCaptured: true,
          baselineMessageID: baseline.messageID,
          baselineSequence: baseline.sequence,
          baselineTotal: baseline.total,
          baselineAssistantCount: baseline.assistantCount,
          baselineRowSequence: baseline.lastRowSequence,
        },
      }
    } else {
      job = { ...job, metadata: { ...job.metadata, baselineCaptured: false } }
    }
    const prompt: PendingPrompt = {
      requestID: id,
      runtimeSessionID,
      storedSessionID: session?.storedSessionID,
      profile: session?.profile,
      queued: params.queued === true,
      job,
    }
    this.#pendingPrompts.set(id, prompt)
    this.#jobsByRuntimeSession.set(runtimeSessionID, [
      ...(this.#jobsByRuntimeSession.get(runtimeSessionID) ?? []),
      prompt.job,
    ])
    this.#enqueue(() => this.coordinator.saveChatJob(prompt.job))
    if (!session?.baseline && session?.baselinePromise) {
      void session.baselinePromise.then(baseline => {
        this.#applyBaseline(runtimeSessionID, prompt.job.id, baseline)
      }).catch(() => undefined)
    }
    this.#emit({
      type: 'chat.prompt',
      phase: 'submitted',
      requestID: prompt.requestID,
      runtimeSessionID: prompt.runtimeSessionID,
      storedSessionID: prompt.storedSessionID,
      profile: prompt.profile,
      queued: prompt.queued,
    })
  }

  ownsJob(jobID: string): boolean {
    return !this.#closed && [...this.#jobsByRuntimeSession.values()].some(jobs => jobs.some(job => job.id === jobID))
  }

  observeUpstreamFrame(data: RawData, isBinary: boolean): void {
    if (this.#closed || isBinary) return
    let frame: JsonRecord
    try { frame = record(JSON.parse(Buffer.from(data as Uint8Array).toString('utf8'))) } catch { return }
    const id = requestID(frame.id)
    if (id) {
      const pendingOpen = this.#pendingSessionOpens.get(id)
      if (pendingOpen) {
        this.#pendingSessionOpens.delete(id)
        if (!frame.error) {
          const result = record(frame.result)
          const runtimeSessionID = string(result.session_id ?? result.sessionId)
          const storedSessionID = string(
            result.stored_session_id ?? result.storedSessionId ?? result.session_key,
          ) || pendingOpen.requestedStoredSessionID
          if (runtimeSessionID && storedSessionID && pendingOpen.profile) {
            const session: SessionIdentity = {
              profile: pendingOpen.profile,
              runtimeSessionID,
              storedSessionID,
              ...(pendingOpen.action === 'create'
                ? { baseline: { total: 0, assistantCount: 0, lastRowSequence: 0 } }
                : {}),
            }
            this.#sessions.set(runtimeSessionID, session)
            if (pendingOpen.action === 'resume' && this.notificationResolver?.captureBaseline) {
              const baselineJob: ChatPushJob = {
                id: `baseline:${this.#connectionID}:${runtimeSessionID}`,
                localUserID: this.identity.localUserID,
                profile: session.profile,
                runtimeSessionID,
                storedSessionID,
                requestID: 'baseline',
                queued: false,
                phase: 'submitted',
                submittedAt: this.now(),
                expiresAt: this.now() + 60_000,
              }
              const baselinePromise = this.notificationResolver.captureBaseline(baselineJob)
              session.baselinePromise = baselinePromise
              void baselinePromise.then(baseline => {
                if (this.#sessions.get(runtimeSessionID) === session) session.baseline = baseline
              }).catch(() => undefined)
            }
            this.#emit({
              type: 'chat.session_opened',
              profile: session.profile,
              runtimeSessionID,
              storedSessionID,
              action: pendingOpen.action,
            })
          }
        }
      }
      const pendingPrompt = this.#pendingPrompts.get(id)
      if (pendingPrompt) {
        this.#pendingPrompts.delete(id)
        const result = record(frame.result)
        const status = string(result.status) || (frame.error ? 'rejected' : 'accepted')
        this.#emit({
          type: 'chat.prompt',
          phase: frame.error ? 'rejected' : 'accepted',
          requestID: pendingPrompt.requestID,
          runtimeSessionID: pendingPrompt.runtimeSessionID,
          storedSessionID: pendingPrompt.storedSessionID,
          profile: pendingPrompt.profile,
          queued: pendingPrompt.queued,
          status,
          ...(frame.error ? { error: errorMessage(frame.error) || 'Hermes rejected the prompt' } : {}),
        })
        if (this.#terminalJobIDs.has(pendingPrompt.job.id)) {
          // A terminal event can legally overtake its JSON-RPC receipt.
          // Never recreate a job that is already being completed.
        } else if (frame.error) {
          this.#removeJob(pendingPrompt.job)
          this.#enqueue(() => this.coordinator.completeChatJob(pendingPrompt.job.id))
        } else {
          const runID = string(result.run_id ?? result.runId ?? result.turn_id ?? result.turnId)
          const accepted: ChatPushJob = {
            ...pendingPrompt.job,
            phase: 'accepted',
            ...(runID ? { metadata: { ...pendingPrompt.job.metadata, runID } } : {}),
          }
          this.#replaceJob(accepted)
          this.#enqueue(() => this.coordinator.saveChatJob(accepted))
        }
      }
    }
    if (string(frame.method) !== 'event') return
    const params = record(frame.params)
    const eventType = string(params.type)
    if (!eventType || eventType === 'gateway.ready') return
    const runtimeSessionID = string(params.session_id)
    const session = runtimeSessionID ? this.#sessions.get(runtimeSessionID) : undefined
    this.#emit({
      type: 'chat.rpc_event',
      eventType,
      profile: string(params.profile) || session?.profile || undefined,
      runtimeSessionID: runtimeSessionID || undefined,
      storedSessionID: session?.storedSessionID,
      payload: record(params.payload),
    })
    if (runtimeSessionID) this.#observeRPCEvent(
      eventType,
      runtimeSessionID,
      record(params.payload),
    )
  }

  disconnected(): void {
    if (this.#closed) return
    this.#closed = true
    this.#emit({
      type: 'chat.disconnected',
      activeSessions: [...this.#sessions.values()],
    })
    for (const jobs of this.#jobsByRuntimeSession.values()) {
      for (const job of [...jobs]) {
        if (this.#terminalJobIDs.has(job.id)) continue
        const disconnectedJob: ChatPushJob = {
          ...job,
          metadata: { ...job.metadata, disconnectedAt: this.now() },
        }
        this.#replaceJob(disconnectedJob)
        this.#enqueue(() => this.coordinator.saveChatJob(disconnectedJob))
        if (this.coordinator.recoverChatJob) {
          this.#enqueue(() => this.coordinator.recoverChatJob!(disconnectedJob))
        }
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.values()].flatMap(session => session.baselinePromise ? [session.baselinePromise] : []),
    )
    await Promise.resolve()
    await this.#delivery
  }

  #emit(observation: ChatObservationPayload): void {
    const event = {
      ...observation,
      localUserID: this.identity.localUserID,
      connectionID: this.#connectionID,
      accountKey: this.identity.accountKey,
      source: this.identity.source,
      observedAt: this.now(),
    } as ChatPushObservation
    if (this.coordinator.observeChat) this.#enqueue(() => this.coordinator.observeChat!(event))
  }

  #enqueue(operation: () => MaybePromise<void>): void {
    this.#delivery = this.#delivery.then(operation).catch(() => undefined)
  }

  #replaceJob(job: ChatPushJob): void {
    const jobs = this.#jobsByRuntimeSession.get(job.runtimeSessionID) ?? []
    const index = jobs.findIndex(candidate => candidate.id === job.id)
    if (index >= 0) jobs[index] = job
    else jobs.push(job)
    this.#jobsByRuntimeSession.set(job.runtimeSessionID, jobs)
  }

  #applyBaseline(runtimeSessionID: string, jobID: string, baseline: ChatMessageBaseline): void {
    const jobs = this.#jobsByRuntimeSession.get(runtimeSessionID) ?? []
    const index = jobs.findIndex(job => job.id === jobID)
    if (index < 0 || this.#terminalJobIDs.has(jobID)) return
    const current = jobs[index]!
    const updated: ChatPushJob = {
      ...current,
      metadata: {
        ...current.metadata,
        baselineCaptured: true,
        baselineMessageID: baseline.messageID,
        baselineSequence: baseline.sequence,
        baselineTotal: baseline.total,
        baselineAssistantCount: baseline.assistantCount,
        baselineRowSequence: baseline.lastRowSequence,
      },
    }
    jobs[index] = updated
    for (const pending of this.#pendingPrompts.values()) {
      if (pending.job.id === jobID) pending.job = updated
    }
    this.#enqueue(() => this.coordinator.saveChatJob(updated))
  }

  #removeJob(job: ChatPushJob): void {
    const jobs = (this.#jobsByRuntimeSession.get(job.runtimeSessionID) ?? [])
      .filter(candidate => candidate.id !== job.id)
    if (jobs.length) this.#jobsByRuntimeSession.set(job.runtimeSessionID, jobs)
    else this.#jobsByRuntimeSession.delete(job.runtimeSessionID)
  }

  #observeRPCEvent(eventType: string, runtimeSessionID: string, payload: JsonRecord): void {
    const jobs = this.#jobsByRuntimeSession.get(runtimeSessionID) ?? []
    const eventRunID = string(payload.run_id ?? payload.runId ?? payload.turn_id ?? payload.turnId)
    let job = eventRunID
      ? jobs.find(candidate => string(candidate.metadata?.runID) === eventRunID)
        ?? jobs.find(candidate => !string(candidate.metadata?.runID))
      : jobs[0]
    if (!job) return
    if (eventRunID && !string(job.metadata?.runID)) {
      job = { ...job, metadata: { ...job.metadata, runID: eventRunID } }
      this.#replaceJob(job)
      const boundJob = job
      this.#enqueue(() => this.coordinator.saveChatJob(boundJob))
    }
    if (['approval.request', 'approval.requested', 'clarify.request', 'clarify.requested'].includes(eventType)) {
      const requestIDValue = string(payload.request_id ?? payload.requestId ?? payload.id)
      if (!requestIDValue) return
      const clarification = eventType.startsWith('clarify.')
      const kind: ChatPushCandidate['kind'] = clarification
        ? 'chat.clarification.requested' : 'chat.approval.requested'
      const eventID = `chat-interaction:${job.id}:${requestIDValue}`
      const candidate: ChatPushCandidate = {
        eventID,
        localUserID: job.localUserID,
        kind,
        jobID: job.id,
        profile: job.profile,
        sessionID: job.storedSessionID,
        requestID: requestIDValue,
        title: clarification ? '机器人需要补充信息' : '机器人请求审批',
        body: summary(payload.question ?? payload.message ?? payload.prompt, clarification ? '请打开夭夭继续处理' : '请打开夭夭审批'),
        collapseID: collapseID('chat-interaction', `${job.storedSessionID ?? runtimeSessionID}:${requestIDValue}`),
        data: notificationData(eventID, kind, job.localUserID, {
          profile: job.profile, sessionId: job.storedSessionID, requestId: requestIDValue,
        }),
      }
      this.#enqueue(async () => {
        if (!await this.#jobOwnershipAllowed(job)) return
        if (!eventRunID) {
          let ownership: ChatTerminalContent = {}
          try {
            ownership = await this.notificationResolver?.resolveTerminal(job, eventType, payload) ?? {}
          } catch { return }
          if (ownership.correlated !== true) return
        }
        await this.coordinator.enqueueNotification(candidate)
      })
      return
    }
    const terminal = ['message.complete', 'run.completed', 'run.failed', 'error'].includes(eventType)
    if (!terminal) return
    if (this.#terminalJobIDs.has(job.id)) return
    this.#terminalJobIDs.add(job.id)
    this.#enqueue(async () => {
      if (!await this.#jobOwnershipAllowed(job)) return
      let resolved: ChatTerminalContent | undefined
      if (!eventRunID) {
        try { resolved = await this.notificationResolver?.resolveTerminal(job, eventType, payload) ?? {} } catch { resolved = {} }
        const failed = eventType === 'run.failed' || eventType === 'error' || Boolean(payload.error)
        if (resolved.confirmed !== true && !(failed && resolved.correlated === true)) {
          this.#terminalJobIDs.delete(job.id)
          return
        }
      }
      const candidate = await chatTerminalCandidate(job, eventType, payload, this.notificationResolver, resolved)
      await this.coordinator.enqueueNotification(candidate)
      await this.coordinator.completeChatJob(job.id)
      this.#removeJob(job)
    })
  }

  async #jobOwnershipAllowed(job: ChatPushJob): Promise<boolean> {
    if (!this.coordinator.canRecoverChatJob) return true
    try { return await this.coordinator.canRecoverChatJob(job) } catch { return false }
  }
}

export interface GroupEventEnvelope {
  type: 'group.ready' | 'group.event' | 'group.heartbeat' | 'group.reset_required'
  epoch?: string
  cursor?: number
  heartbeatSeconds?: number
  roomId?: string
  event?: string
  payload?: unknown
  reason?: string
}

function canonicalAnchor(value: GroupWatchAnchor): GroupWatchAnchor {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.epoch)
    || !Number.isSafeInteger(value.cursor) || value.cursor < 0) {
    throw new Error('Invalid Yaoyao group event anchor')
  }
  return { epoch: value.epoch, cursor: value.cursor }
}

function eventRoomID(envelope: GroupEventEnvelope, payload: JsonRecord): string {
  return string(envelope.roomId ?? payload.roomId ?? payload.room_id)
}

function terminalGroupCandidate(
  envelope: GroupEventEnvelope,
  anchor: GroupWatchAnchor,
): Omit<GroupPushCandidate, 'localUserID' | 'data'> | undefined {
  if (envelope.type !== 'group.event') return undefined
  const payload = record(envelope.payload)
  const roomID = eventRoomID(envelope, payload)
  if (!roomID) return undefined
  if (envelope.event === 'message.upsert') {
    const senderKind = string(payload.senderKind ?? payload.sender_kind).toLowerCase()
    const status = string(payload.status).toLowerCase()
    const messageID = string(payload.id)
    if (senderKind !== 'agent' || !messageID || (status !== 'completed' && status !== 'failed')) return undefined
    const kind: GroupPushCandidate['kind'] = status === 'completed'
      ? 'group.message.completed' : 'group.message.failed'
    const eventID = `group-message:${messageID}:${status}`
    const content = string(payload.content)
    const error = string(payload.error)
    return {
      eventID,
      kind,
      epoch: anchor.epoch,
      cursor: anchor.cursor + 1,
      roomID,
      topicID: string(payload.topicId ?? payload.topic_id) || undefined,
      messageID,
      messageSequence: Number.isSafeInteger(Number(payload.seq ?? payload.sequence))
        ? Number(payload.seq ?? payload.sequence) : undefined,
      senderName: string(payload.senderName ?? payload.sender_name) || undefined,
      content: content || undefined,
      error: error || undefined,
      occurredAt: eventTimestamp(payload.updatedAt ?? payload.updated_at ?? payload.createdAt ?? payload.created_at),
      title: status === 'completed'
        ? `${string(payload.senderName ?? payload.sender_name) || '机器人'} 已回复`
        : `${string(payload.senderName ?? payload.sender_name) || '机器人'} 执行失败`,
      body: summary(error || content, status === 'completed' ? '打开夭夭查看团队消息' : '打开夭夭查看失败详情'),
      collapseID: collapseID('group-message', messageID),
    }
  }
  if (envelope.event !== 'interaction.requested') return undefined
  const interactionID = string(payload.id)
  const status = string(payload.status).toLowerCase()
  if (!interactionID || (status && status !== 'pending')) return undefined
  const rawKind = string(payload.kind).toLowerCase()
  const interactionKind = rawKind === 'approval' || rawKind === 'clarification' ? rawKind : 'unknown'
  const interactionPayload = record(payload.payload)
  const eventID = `group-interaction:${interactionID}`
  const content = string(interactionPayload.question ?? interactionPayload.message ?? interactionPayload.prompt)
  return {
    eventID,
    kind: 'group.interaction.requested',
    epoch: anchor.epoch,
    cursor: anchor.cursor + 1,
    roomID,
    topicID: string(payload.topicId ?? payload.topic_id) || undefined,
    interactionID,
    interactionKind,
    content: content || undefined,
    occurredAt: eventTimestamp(payload.updatedAt ?? payload.updated_at ?? payload.createdAt ?? payload.created_at),
    title: interactionKind === 'clarification' ? '团队机器人需要补充信息' : '团队机器人请求审批',
    body: summary(content, '请打开夭夭继续处理'),
    collapseID: collapseID('group-interaction', interactionID),
  }
}

export type GroupEnvelopeResult = 'ready' | 'heartbeat' | 'advanced' | 'ignored' | 'reset'

export interface GroupEventConnection {
  close(): void
}

export interface GroupEventSource {
  currentAnchor(): Promise<GroupWatchAnchor>
  connect(
    anchor: GroupWatchAnchor,
    handlers: {
      onEnvelope(envelope: GroupEventEnvelope): void
      onClose(error?: Error): void
    },
  ): Promise<GroupEventConnection>
}

function parseUpstreamJSON(body: Buffer): JsonRecord {
  try { return record(JSON.parse(body.toString('utf8'))) } catch { throw new Error('Hermes returned invalid JSON') }
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const source = record(value)
  const data = source.data
  return Array.isArray(data) ? data : []
}

function messageContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.map(item => {
    if (typeof item === 'string') return item
    const part = record(item)
    return string(part.text ?? part.content)
  }).filter(Boolean).join('\n').trim()
}

function messageTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1_000 : value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

interface ChatHistoryRow {
  role: string
  content: string
  messageID?: string
  runID?: string
  sequence: number
  timestamp?: number
  failed: boolean
  error?: string
}

export class HermesChatNotificationResolver implements ChatNotificationResolver {
  private readonly titleCache = new Map<string, { value: string; expiresAt: number }>()

  constructor(
    readonly upstreamSession: UpstreamServiceSession,
    readonly digestPrompt?: (localUserID: string, prompt: string) => MaybePromise<string>,
  ) {}

  private async snapshot(job: ChatPushJob): Promise<{
    title?: string
    total: number
    rows: ChatHistoryRow[]
    assistants: ChatHistoryRow[]
    latest?: ChatHistoryRow
  }> {
    if (!job.storedSessionID) return { total: 0, rows: [], assistants: [] }
    const search = new URLSearchParams({
      offset: '0', limit: '500', order: 'latest', include_compacted: 'true',
    })
    if (job.profile) search.set('profile', job.profile)
    const response = await this.upstreamSession.request(
      `/api/sessions/${encodeURIComponent(job.storedSessionID)}/messages`,
      { search },
    )
    if (response.status < 200 || response.status >= 300) throw new Error(`Hermes history failed (${response.status})`)
    const source = parseUpstreamJSON(response.body)
    const session = record(source.session)
    const messages = values(source.messages ?? source.items ?? source.data ?? source)
    const rows = messages.map((raw, index): ChatHistoryRow => {
      const message = record(raw)
      const role = string(message.role ?? message.senderKind ?? message.sender_kind).toLowerCase()
      const content = messageContent(message.content ?? message.text ?? message.message)
      const error = string(message.error)
      const status = string(message.status).toLowerCase()
      const rowID = Number(message.id)
      const explicitSequence = Number(message.sequence ?? message.seq ?? message.index)
      const rawSequence = Number.isFinite(rowID)
        ? rowID : Number.isFinite(explicitSequence) ? explicitSequence : index
      return {
        role,
        content: content || error,
        messageID: requestID(message.id ?? message.message_id ?? message.messageId) || undefined,
        runID: string(message.run_id ?? message.runId ?? message.turn_id ?? message.turnId) || undefined,
        sequence: rawSequence,
        timestamp: messageTimestamp(message.timestamp ?? message.createdAt ?? message.created_at),
        failed: status === 'failed' || status === 'error' || Boolean(error),
        ...(error ? { error } : {}),
      }
    }).sort((left, right) => left.sequence - right.sequence || (left.timestamp ?? 0) - (right.timestamp ?? 0))
    const assistants = rows.filter(row => (row.role === 'assistant' || row.role === 'agent') && Boolean(row.content))
    const pagination = record(source.pagination)
    const totalValue = Number(pagination.total ?? source.total ?? messages.length)
    let title = string(session.title ?? source.title) || undefined
    if (!title) title = await this.sessionTitle(job)
    return {
      title,
      total: Number.isSafeInteger(totalValue) && totalValue >= 0 ? totalValue : messages.length,
      rows,
      assistants,
      latest: assistants.at(-1),
    }
  }

  private async sessionTitle(job: ChatPushJob): Promise<string | undefined> {
    if (!job.storedSessionID) return undefined
    const key = `${job.profile ?? 'default'}:${job.storedSessionID}`
    const cached = this.titleCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const search = new URLSearchParams()
    if (job.profile) search.set('profile', job.profile)
    try {
      const response = await this.upstreamSession.request(
        `/api/sessions/${encodeURIComponent(job.storedSessionID)}`,
        { search },
      )
      if (response.status < 200 || response.status >= 300) return undefined
      const payload = parseUpstreamJSON(response.body)
      const data = record(payload.data)
      const session = record(payload.session ?? data.session ?? payload.data ?? payload)
      const title = string(session.title)
      if (!title) return undefined
      this.titleCache.set(key, { value: title, expiresAt: Date.now() + 5 * 60 * 1_000 })
      return title
    } catch {
      return undefined
    }
  }

  async captureBaseline(job: ChatPushJob): Promise<ChatMessageBaseline> {
    if (!job.storedSessionID) {
      return { total: 0, assistantCount: 0, lastRowSequence: 0 }
    }
    const search = new URLSearchParams({
      offset: '0', limit: '1', order: 'latest', include_compacted: 'true',
    })
    if (job.profile) search.set('profile', job.profile)
    const response = await this.upstreamSession.request(
      `/api/sessions/${encodeURIComponent(job.storedSessionID)}/messages`,
      { search },
    )
    if (response.status < 200 || response.status >= 300) throw new Error(`Hermes history failed (${response.status})`)
    const source = parseUpstreamJSON(response.body)
    const messages = values(source.messages ?? source.items ?? source.data ?? source)
    const raw = messages.at(-1)
    const message = record(raw)
    const role = string(message.role ?? message.senderKind ?? message.sender_kind).toLowerCase()
    const rowID = Number(message.id)
    const explicitSequence = Number(message.sequence ?? message.seq ?? message.index)
    const sequence = Number.isFinite(rowID)
      ? rowID : Number.isFinite(explicitSequence) ? explicitSequence : 0
    const pagination = record(source.pagination)
    const totalValue = Number(pagination.total ?? source.total ?? messages.length)
    return {
      messageID: role === 'assistant' || role === 'agent'
        ? requestID(message.id ?? message.message_id ?? message.messageId) || undefined
        : undefined,
      sequence: role === 'assistant' || role === 'agent' ? sequence : undefined,
      total: Number.isSafeInteger(totalValue) && totalValue >= 0 ? totalValue : messages.length,
      assistantCount: role === 'assistant' || role === 'agent' ? 1 : 0,
      lastRowSequence: sequence,
    }
  }

  async resolveTerminal(job: ChatPushJob, _eventType: string, _payload: JsonRecord): Promise<ChatTerminalContent> {
    const snapshot = await this.snapshot(job)
    const expectedRunID = string(job.metadata?.runID)
    if (expectedRunID) {
      const latest = snapshot.assistants.filter(candidate => candidate.runID === expectedRunID).at(-1)
      const baselineSequence = Number(job.metadata?.baselineSequence)
      const baselineRowSequence = Number(job.metadata?.baselineRowSequence)
      const baselineMessageID = string(job.metadata?.baselineMessageID)
      const confirmed = job.metadata?.baselineCaptured === true && Boolean(latest) && (
        (Number.isFinite(baselineSequence) && latest!.sequence > baselineSequence)
          || (Number.isFinite(baselineRowSequence) && latest!.sequence > baselineRowSequence)
          || Boolean(baselineMessageID && latest!.messageID && latest!.messageID !== baselineMessageID)
      )
      return this.terminalContent(snapshot.title, latest, confirmed, confirmed)
    }

    const promptDigest = string(job.metadata?.promptDigest)
    const baselineRowSequence = Number(job.metadata?.baselineRowSequence)
    if (!this.digestPrompt || !promptDigest || !Number.isFinite(baselineRowSequence)) {
      return { title: snapshot.title, confirmed: false, correlated: false }
    }
    const matchingUsers: ChatHistoryRow[] = []
    for (const row of snapshot.rows) {
      if (row.role !== 'user' || row.sequence <= baselineRowSequence || !row.content) continue
      let digest = ''
      try { digest = await this.digestPrompt(job.localUserID, row.content) } catch { continue }
      if (digest === promptDigest) matchingUsers.push(row)
    }
    if (matchingUsers.length !== 1) {
      return { title: snapshot.title, confirmed: false, correlated: false }
    }
    const userRow = matchingUsers[0]!
    const nextUser = snapshot.rows.find(row => row.role === 'user' && row.sequence > userRow.sequence)
    const latest = snapshot.assistants
      .filter(row => row.sequence > userRow.sequence && (!nextUser || row.sequence < nextUser.sequence))
      .at(-1)
    return this.terminalContent(snapshot.title, latest, Boolean(latest), true)
  }

  private terminalContent(
    title: string | undefined,
    latest: ChatHistoryRow | undefined,
    confirmed: boolean,
    correlated: boolean,
  ): ChatTerminalContent {
    return {
      title,
      body: latest?.content,
      messageID: latest?.messageID,
      timestamp: latest?.timestamp,
      confirmed,
      correlated,
      ...(latest?.failed ? { failed: true } : {}),
      ...(latest?.error ? { error: latest.error } : {}),
    }
  }
}

function chatInteractionCandidate(
  job: ChatPushJob,
  eventType: string,
  payload: JsonRecord,
): ChatPushCandidate | undefined {
  const requestIDValue = string(payload.request_id ?? payload.requestId ?? payload.id)
  if (!requestIDValue) return undefined
  const clarification = eventType.startsWith('clarify.')
    || string(payload.kind).toLowerCase() === 'clarification'
  const kind: ChatPushCandidate['kind'] = clarification
    ? 'chat.clarification.requested' : 'chat.approval.requested'
  const eventID = `chat-interaction:${job.id}:${requestIDValue}`
  return {
    eventID,
    localUserID: job.localUserID,
    kind,
    jobID: job.id,
    profile: job.profile,
    sessionID: job.storedSessionID,
    requestID: requestIDValue,
    title: clarification ? '机器人需要补充信息' : '机器人请求审批',
    body: summary(payload.question ?? payload.message ?? payload.prompt, clarification ? '请打开夭夭继续处理' : '请打开夭夭审批'),
    collapseID: collapseID('chat-interaction', `${job.storedSessionID ?? job.runtimeSessionID}:${requestIDValue}`),
    data: notificationData(eventID, kind, job.localUserID, {
      profile: job.profile, sessionId: job.storedSessionID, requestId: requestIDValue,
    }),
  }
}

async function chatTerminalCandidate(
  job: ChatPushJob,
  eventType: string,
  payload: JsonRecord,
  resolver?: ChatNotificationResolver,
  suppliedContent?: ChatTerminalContent,
): Promise<ChatPushCandidate> {
  const terminalStatus = string(payload.status).toLowerCase()
  const failed = eventType === 'run.failed' || eventType === 'error'
    || terminalStatus === 'failed' || terminalStatus === 'error' || Boolean(payload.error)
  let resolved: ChatTerminalContent = suppliedContent ?? {}
  if (!suppliedContent) {
    try { resolved = await resolver?.resolveTerminal(job, eventType, payload) ?? {} } catch { /* payload fallback */ }
  }
  const kind: ChatPushCandidate['kind'] = failed ? 'chat.failed' : 'chat.completed'
  const eventID = `chat-terminal:${job.id}:${failed ? 'failed' : 'completed'}`
  const authoritativeBody = resolved.confirmed === true ? resolved.body : undefined
  return {
    eventID,
    localUserID: job.localUserID,
    kind,
    jobID: job.id,
    profile: job.profile,
    sessionID: job.storedSessionID,
    title: resolved.title || (failed ? '任务执行失败' : '任务已完成'),
    body: failed
      ? summary(payload.error ?? payload.message ?? authoritativeBody, '打开夭夭查看失败详情')
      : summary(authoritativeBody ?? payload.text ?? payload.message, '打开夭夭查看结果'),
    collapseID: collapseID('chat', job.storedSessionID ?? job.runtimeSessionID),
    data: notificationData(eventID, kind, job.localUserID, {
      profile: job.profile, sessionId: job.storedSessionID,
    }),
  }
}

/**
 * Server-owned recovery connection for one persisted chat job. The caller
 * controls the number of concurrently started watchers.
 */
export interface ChatPushRecoveryTransport {
  start(): void
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type ChatPushTransportFactory = (job: ChatPushJob, onFrame: (frame: string) => void, onClose: () => void) => Promise<ChatPushRecoveryTransport>

export class HermesChatPushJobWatcher {
  #job: ChatPushJob
  #running = false
  #generation = 0
  #retryAttempt = 0
  #retryTimer?: ReturnType<typeof setTimeout>
  #socket?: WebSocket | ChatPushRecoveryTransport
  #resumeRequestID = ''
  #frames = Promise.resolve()
  #finished = false

  constructor(
    job: ChatPushJob,
    readonly config: ServerConfig,
    readonly upstreamSession: UpstreamServiceSession,
    readonly coordinator: PushEventCoordinator,
    readonly resolver: ChatNotificationResolver = new HermesChatNotificationResolver(upstreamSession),
    readonly now: () => number = Date.now,
    readonly onFinished?: (jobID: string) => void,
    readonly transportFactory?: ChatPushTransportFactory,
  ) {
    this.#job = { ...job }
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#generation += 1
    void this.#connect(this.#generation)
  }

  stop(): void {
    this.#running = false
    this.#generation += 1
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#socket?.close(1000, 'chat push watcher close')
    this.#socket = undefined
  }

  async #connect(generation: number): Promise<void> {
    if (!this.#job.storedSessionID || this.#job.expiresAt <= this.now()) {
      await this.coordinator.completeChatJob(this.#job.id)
      this.stop()
      this.#notifyFinished()
      return
    }
    try {
      if (this.transportFactory) {
        const transport = await this.transportFactory(this.#job,
          frame => this.#queueFrame(generation, Buffer.from(frame), false),
          () => this.#scheduleReconnect(generation))
        if (!this.#running || generation !== this.#generation) { transport.close(); return }
        this.#socket = transport
        transport.start()
        return
      }
      const credential = await this.upstreamSession.webSocketCredential()
      if (!this.#running || generation !== this.#generation) return
      const url = new URL(this.config.upstream)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const prefix = this.config.upstream.pathname === '/' ? '' : this.config.upstream.pathname.replace(/\/$/, '')
      url.pathname = `${prefix}/api/ws`
      url.search = ''
      url.searchParams.set(credential.name, credential.value)
      const socket = new WebSocket(url, {
        agent: this.upstreamSession.client.directAgent,
        headers: { Origin: this.config.upstream.origin },
        maxPayload: 36 * 1_024 * 1_024,
        handshakeTimeout: 15_000,
      })
      this.#socket = socket
      socket.on('message', (data, isBinary) => this.#queueFrame(generation, data, isBinary))
      socket.once('error', () => {
        if (socket.readyState !== WebSocket.OPEN) this.#scheduleReconnect(generation)
      })
      socket.once('close', () => this.#scheduleReconnect(generation))
    } catch {
      this.#scheduleReconnect(generation)
    }
  }

  #queueFrame(generation: number, data: RawData, isBinary: boolean): void {
    this.#frames = this.#frames.then(async () => {
      if (!this.#running || generation !== this.#generation || isBinary) return
      let frame: JsonRecord
      try { frame = record(JSON.parse(Buffer.from(data as Uint8Array).toString('utf8'))) } catch { return }
      if (string(frame.method) === 'event') {
        const params = record(frame.params)
        const eventType = string(params.type)
        if (eventType === 'gateway.ready') {
          this.#resumeRequestID = `push-resume:${this.#job.id}:${generation}`
          this.#socket?.send(JSON.stringify({
            jsonrpc: '2.0',
            id: this.#resumeRequestID,
            method: 'session.resume',
            params: {
              session_id: this.#job.storedSessionID,
              profile: this.#job.profile,
              source: 'web',
              close_on_disconnect: false,
              omit_messages: true,
              cols: 80,
            },
          }))
          return
        }
        const runtimeSessionID = string(params.session_id)
        if (runtimeSessionID && this.#job.runtimeSessionID && runtimeSessionID !== this.#job.runtimeSessionID) return
        const payload = record(params.payload)
        const expectedRunID = string(this.#job.metadata?.runID)
        const eventRunID = string(payload.run_id ?? payload.runId ?? payload.turn_id ?? payload.turnId)
        if (expectedRunID && eventRunID !== expectedRunID) return
        if (['approval.request', 'approval.requested', 'clarify.request', 'clarify.requested'].includes(eventType)) {
          if (!await this.#ownershipStillAllowed()) return
          if (!expectedRunID) {
            let ownership: ChatTerminalContent = {}
            try { ownership = await this.resolver.resolveTerminal(this.#job, eventType, payload) } catch { return }
            if (ownership.correlated !== true) return
          }
          const candidate = chatInteractionCandidate(this.#job, eventType, payload)
          if (candidate) await this.coordinator.enqueueNotification(candidate)
          return
        }
        if (['message.complete', 'run.completed', 'run.failed', 'error'].includes(eventType)) {
          await this.#finishTerminal(eventType, payload)
        }
        return
      }
      if (requestID(frame.id) !== this.#resumeRequestID) return
      if (frame.error) throw new Error(errorMessage(frame.error) || 'Unable to resume chat push job')
      const result = record(frame.result)
      const runtimeSessionID = string(result.session_id ?? result.sessionId)
      const storedSessionID = string(result.stored_session_id ?? result.storedSessionId ?? result.session_key)
        || this.#job.storedSessionID
      const resumedRunID = string(result.run_id ?? result.runId ?? result.turn_id ?? result.turnId)
      const expectedRunID = string(this.#job.metadata?.runID)
      if (!runtimeSessionID) throw new Error('Hermes resume did not return a runtime session ID')
      const promptDigest = string(this.#job.metadata?.promptDigest)
      if ((!expectedRunID && !promptDigest) || (expectedRunID && resumedRunID && resumedRunID !== expectedRunID)) {
        this.#socket?.close(1012, 'push run ownership is not confirmed')
        return
      }
      this.#job = {
        ...this.#job,
        runtimeSessionID,
        storedSessionID,
        phase: 'watching',
        metadata: {
          ...this.#job.metadata,
          ...(expectedRunID ? { runID: expectedRunID } : {}),
        },
      }
      await this.coordinator.saveChatJob(this.#job)
      const approval = record(result.pending_approval)
      const clarification = record(result.pending_clarify)
      const pending = string(approval.request_id ?? approval.requestId ?? approval.id)
        ? chatInteractionCandidate(this.#job, 'approval.requested', approval)
        : string(clarification.request_id ?? clarification.requestId ?? clarification.id)
          ? chatInteractionCandidate(this.#job, 'clarify.requested', clarification)
          : undefined
      if (pending) {
        if (!await this.#ownershipStillAllowed()) return
        if (!expectedRunID) {
          let ownership: ChatTerminalContent = {}
          try { ownership = await this.resolver.resolveTerminal(this.#job, 'interaction.requested', result) } catch { return }
          if (ownership.correlated !== true) return
        }
        await this.coordinator.enqueueNotification(pending)
        return
      }
      const inflight = record(result.inflight ?? result.active_run)
      const queued = record(result.queued)
      const running = result.running === true || inflight.streaming === true
        || Boolean(string(queued.user ?? queued.text))
      if (running && expectedRunID && !resumedRunID) {
        this.#socket?.close(1012, 'active push run lacks ownership identity')
        return
      }
      if (running) this.#retryAttempt = 0
      if (!running) {
        const resumeError = string(result.error ?? inflight.error)
        if (resumeError) {
          await this.#finishTerminal('run.failed', { ...result, error: resumeError })
          return
        }
        let resolved: ChatTerminalContent = {}
        try { resolved = await this.resolver.resolveTerminal(this.#job, 'run.completed', result) } catch { /* retry below */ }
        if (resolved.confirmed !== true) {
          this.#socket?.close(1012, 'awaiting authoritative terminal message')
          return
        }
        await this.#finishTerminal(
          resolved.failed ? 'run.failed' : 'run.completed',
          resolved.failed ? { ...result, error: resolved.error ?? resolved.body } : result,
          resolved,
        )
      }
    }).catch(() => {
      if (!this.#running || generation !== this.#generation) return
      this.#socket?.close(1011, 'chat push watcher frame failed')
      this.#scheduleReconnect(generation)
    })
  }

  async #finishTerminal(eventType: string, payload: JsonRecord, resolved?: ChatTerminalContent): Promise<void> {
    if (!this.#running) return
    if (!await this.#ownershipStillAllowed()) {
      this.stop()
      this.#notifyFinished()
      return
    }
    let ownership = resolved
    if (!ownership) {
      try { ownership = await this.resolver.resolveTerminal(this.#job, eventType, payload) } catch { ownership = {} }
    }
    const expectedRunID = string(this.#job.metadata?.runID)
    const eventRunID = string(payload.run_id ?? payload.runId ?? payload.turn_id ?? payload.turnId)
    const ownedByRun = Boolean(expectedRunID && eventRunID === expectedRunID)
    const failed = eventType === 'run.failed' || eventType === 'error' || Boolean(payload.error)
    if (ownership.confirmed !== true && !ownedByRun && !(failed && ownership.correlated === true)) {
      this.#socket?.close(1012, 'terminal push ownership is not confirmed')
      return
    }
    const candidate = await chatTerminalCandidate(this.#job, eventType, payload, this.resolver, ownership)
    await this.coordinator.enqueueNotification(candidate)
    await this.coordinator.completeChatJob(this.#job.id)
    this.stop()
    this.#notifyFinished()
  }

  #scheduleReconnect(generation: number): void {
    if (!this.#running || generation !== this.#generation || this.#retryTimer) return
    this.#socket = undefined
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.#retryAttempt++, 6))
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      if (this.#running && generation === this.#generation) void this.#connect(generation)
    }, delay)
    this.#retryTimer.unref()
  }

  async #ownershipStillAllowed(): Promise<boolean> {
    if (!this.coordinator.canRecoverChatJob) return true
    try { return await this.coordinator.canRecoverChatJob(this.#job) } catch { return false }
  }

  #notifyFinished(): void {
    if (this.#finished) return
    this.#finished = true
    this.onFinished?.(this.#job.id)
  }
}

export interface ChatPushJobManagerOptions {
  transportFactory?: ChatPushTransportFactory
  maximumConcurrent?: number
  reconcileMilliseconds?: number
  now?: () => number
  resolver?: ChatNotificationResolver
}

/** Starts and bounds the server-owned recovery sockets for persisted jobs. */
export class ChatPushJobManager {
  private transportFactory?: ChatPushTransportFactory
  private brokerOwnsJob?: (job: ChatPushJob) => boolean
  readonly #watchers = new Map<string, HermesChatPushJobWatcher>()
  readonly #maximumConcurrent: number
  readonly #reconcileMilliseconds: number
  readonly #now: () => number
  readonly #resolver: ChatNotificationResolver
  #running = false
  #timer?: ReturnType<typeof setInterval>
  #activeReconcile?: Promise<void>

  constructor(
    readonly config: ServerConfig,
    readonly upstreamSession: UpstreamServiceSession,
    readonly coordinator: PushEventCoordinator,
    options: ChatPushJobManagerOptions = {},
  ) {
    this.#maximumConcurrent = Math.max(1, Math.min(64, Math.trunc(options.maximumConcurrent ?? 16)))
    this.#reconcileMilliseconds = Math.max(250, Math.trunc(options.reconcileMilliseconds ?? 1_000))
    this.#now = options.now ?? Date.now
    this.#resolver = options.resolver ?? new HermesChatNotificationResolver(upstreamSession)
    this.transportFactory = options.transportFactory
  }

  setTransportFactory(factory: ChatPushTransportFactory, ownsJob?: (job: ChatPushJob) => boolean): void {
    this.transportFactory = factory; this.brokerOwnsJob = ownsJob
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    void this.reconcile().catch(() => undefined)
    this.#timer = setInterval(() => {
      void this.reconcile().catch(() => undefined)
    }, this.#reconcileMilliseconds)
    this.#timer.unref()
  }

  stop(): void {
    this.#running = false
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    for (const watcher of this.#watchers.values()) watcher.stop()
    this.#watchers.clear()
  }

  reconcile(): Promise<void> {
    if (this.#activeReconcile) return this.#activeReconcile
    const operation = this.#reconcile()
    const tracked = operation.finally(() => {
      if (this.#activeReconcile === tracked) this.#activeReconcile = undefined
    })
    this.#activeReconcile = tracked
    return tracked
  }

  async #reconcile(): Promise<void> {
    if (!this.#running) return
    const pending = [...await this.coordinator.pendingChatJobs()]
    const now = this.#now()
    for (const job of pending) {
      if (job.expiresAt <= now) await this.coordinator.completeChatJob(job.id)
    }
    const jobs: ChatPushJob[] = []
    for (const job of pending) {
      const structurallyEligible = job.expiresAt > now
        && job.metadata?.baselineCaptured === true
        && (Boolean(this.transportFactory) || Number.isFinite(Number(job.metadata?.disconnectedAt)))
        && Boolean(string(job.metadata?.runID) || string(job.metadata?.promptDigest))
        && (job.phase === 'submitted' || job.phase === 'accepted' || job.phase === 'watching')
      if (!structurallyEligible) continue
      if (this.brokerOwnsJob?.(job)) continue
      if (this.coordinator.canRecoverChatJob
        && !await this.coordinator.canRecoverChatJob(job)) continue
      jobs.push(job)
    }
    jobs.sort((left, right) => left.submittedAt - right.submittedAt)
    if (!this.#running) return
    const pendingIDs = new Set(jobs.map(job => job.id))
    for (const [jobID, watcher] of this.#watchers) {
      if (pendingIDs.has(jobID)) continue
      watcher.stop()
      this.#watchers.delete(jobID)
    }
    for (const job of jobs) {
      if (!this.#running || this.#watchers.size >= this.#maximumConcurrent) break
      if (this.#watchers.has(job.id)) continue
      const watcher = new HermesChatPushJobWatcher(
        job,
        this.config,
        this.upstreamSession,
        this.coordinator,
        this.#resolver,
        this.#now,
        jobID => {
          this.#watchers.delete(jobID)
          if (this.#running) void this.reconcile()
        },
        this.transportFactory,
      )
      this.#watchers.set(job.id, watcher)
      watcher.start()
    }
  }
}
