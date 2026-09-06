import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  ChatAttachment, ChatMessage, ChatRouteState, JsonValue, ModelOption, RealtimeConnectionState, SessionSummary,
} from '@shared/types'
import {
  deleteSession as deleteSessionApi, getMessages, getSession, getSessions, getSessionUnread, markSessionRead, updateSession,
} from '@/api/sessions'
import { getModels } from '@/api/profiles'
import { ChatRpcSocket, RpcError } from '@/api/realtime'
import { ApiError } from '@/api/client'
import { encodeAttachment } from '@/utils/attachments'
import { ScopedCache } from '@/utils/cache'
import { createId, routeKey } from '@/utils/id'
import { applyChatEvent, mergeChatMessages } from '@/utils/messageReducer'
import { bool, normalizeChatMessage, number, record, string, values } from '@/utils/normalize'
import { appendSessionPage, pinnedSessionsFirst } from '@/utils/sessionOrder'
import { modelForSession, modelSelectionFromSessionInfo } from '@/utils/sessionModel'
import { moveSessionFastMode, readSessionFastMode, writeSessionFastMode } from '@/utils/sessionPreferences'
import { useAuthStore } from './auth'

interface CachedHistory { messages: ChatMessage[]; total: number; savedAt: number }
const historyCache = new ScopedCache<CachedHistory>('chat-history-v1')
const INFLIGHT_SESSION_STORAGE_PREFIX = 'hermes-yaoyao:inflight-chat-sessions:'
const SESSION_LIST_REFRESH_DEBOUNCE_MS = 200

interface InflightSessionMarker {
  profile: string
  sessionId: string
}

function sessionStorageForInFlightSessions(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try { return window.sessionStorage } catch { return undefined }
}

function readInflightSessionMarkers(accountId: string): InflightSessionMarker[] {
  const storage = sessionStorageForInFlightSessions()
  if (!storage) return []
  try {
    const value: unknown = JSON.parse(storage.getItem(`${INFLIGHT_SESSION_STORAGE_PREFIX}${accountId}`) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      const marker = record(item)
      const profile = string(marker.profile)
      const sessionId = string(marker.sessionId)
      return profile && sessionId ? [{ profile, sessionId }] : []
    })
  } catch { return [] }
}

function writeInflightSessionMarkers(accountId: string, markers: InflightSessionMarker[]): void {
  const storage = sessionStorageForInFlightSessions()
  if (!storage) return
  try {
    const key = `${INFLIGHT_SESSION_STORAGE_PREFIX}${accountId}`
    if (markers.length) storage.setItem(key, JSON.stringify(markers))
    else storage.removeItem(key)
  } catch { /* Storage can be unavailable in privacy-restricted browsers. */ }
}

function emptyRoute(profile: string, sessionId: string): ChatRouteState {
  return {
    route: { profile, sessionId }, messages: [], historySynced: false, hasMoreBefore: false,
    loadedMessageCount: 0, messageTotal: 0, isLoadingHistory: false, isStreaming: false,
    isQueued: false, generation: 0,
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '聊天请求失败'
}

function resultRecord(value: JsonValue): Record<string, unknown> { return record(value) }

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'fast') return true
  if (value === 'false' || value === 'normal') return false
  return undefined
}

export const useChatStore = defineStore('chat', () => {
  const auth = useAuthStore()
  const sessions = ref<SessionSummary[]>([])
  const activeSessionId = ref<string>()
  const activeProfileName = ref<string>()
  const routes = reactive<Record<string, ChatRouteState>>({})
  const connectionState = ref<RealtimeConnectionState>('idle')
  const historySynced = computed(() => activeRouteState.value?.historySynced ?? false)
  const isLoading = ref(false)
  const isLoadingMoreSessions = ref(false)
  const hasMoreSessions = ref(false)
  const isSending = ref(false)
  const error = ref<string>()
  const models = ref<ModelOption[]>([])
  const unreadCounts = ref<Record<string, number>>({})
  const selectedModel = ref<ModelOption>()
  const reasoningEffort = ref<string>()
  const socket = new ChatRpcSocket()
  const runtimeRoutes = new Map<string, string>()
  const desiredModelRoutes = new Set<string>()
  const pendingModelConfirmations = new Map<string, { routeKey: string; model: ModelOption }>()
  let connectPromise: Promise<void> | undefined
  let reconnectTimer: number | undefined
  let reconnectAttempt = 0
  let sessionLoadGeneration = 0
  let sessionListProfile: string | undefined
  let sessionListRefreshTimer: number | undefined
  let nextSessionCursor: string | undefined
  let modelLoadGeneration = 0
  let unreadLoadGeneration = 0
  let reconnectResumePromise: Promise<unknown> | undefined
  let persistedRecoveryPromise: Promise<void> | undefined
  let hasConnectedOnce = false
  const runtimePromises = new Map<string, Promise<ChatRouteState>>()

  const activeRouteState = computed(() => {
    if (!activeSessionId.value || !activeProfileName.value) return undefined
    return routes[routeKey(activeProfileName.value, activeSessionId.value)]
  })
  const fastMode = computed(() => activeRouteState.value?.fastMode ?? false)
  const activeSession = computed(() => sessions.value.find(session => session.id === activeSessionId.value
    && (!activeProfileName.value || session.profile === activeProfileName.value)))
  const messages = computed(() => activeRouteState.value?.messages ?? [])
  const hasMoreBefore = computed(() => activeRouteState.value?.hasMoreBefore ?? false)
  const isStreaming = computed(() => activeRouteState.value?.isStreaming ?? false)
  const isQueued = computed(() => activeRouteState.value?.isQueued ?? false)
  const contextUsage = computed(() => activeRouteState.value?.usage)
  const pendingApproval = computed(() => activeRouteState.value?.pendingApproval)
  const pendingClarification = computed(() => activeRouteState.value?.pendingClarification)

  function ensureRoute(profile: string, sessionId: string): ChatRouteState {
    const key = routeKey(profile, sessionId)
    if (!routes[key]) {
      routes[key] = emptyRoute(profile, sessionId)
      routes[key].fastMode = readSessionFastMode(auth.user?.id ?? 'local', profile, sessionId)
    }
    return routes[key]
  }

  function persistFastMode(state: ChatRouteState): void {
    writeSessionFastMode(auth.user?.id ?? 'local', state.route.profile, state.route.sessionId, state.fastMode ?? false)
  }

  function syncSelectedModel(model?: string, provider?: string): void {
    const resolved = modelForSession(models.value, model, provider)
    if (resolved) selectedModel.value = resolved
  }

  function restoreSelectedSessionModel(key: string): void {
    const activeKey = activeSessionId.value && activeProfileName.value
      ? routeKey(activeProfileName.value, activeSessionId.value)
      : undefined
    if (key === activeKey) syncSelectedModel(activeSession.value?.model, activeSession.value?.provider)
  }

  function reconcileSessionModel(profile: string, sessionId: string, model: string, provider?: string): void {
    const key = routeKey(profile, sessionId)
    const sessionIndex = sessions.value.findIndex(session => session.id === sessionId && session.profile === profile)
    if (sessionIndex >= 0) {
      sessions.value.splice(sessionIndex, 1, {
        ...sessions.value[sessionIndex], model, provider,
      })
    }
    const activeKey = activeSessionId.value && activeProfileName.value
      ? routeKey(activeProfileName.value, activeSessionId.value)
      : undefined
    if (key === activeKey && !desiredModelRoutes.has(key)) syncSelectedModel(model, provider)
  }

  function reconcileSessionTitle(profile: string | undefined, sessionId: string, title: string): void {
    const normalized = title.trim()
    if (!sessionId || !normalized) return
    const index = sessions.value.findIndex(session => session.id === sessionId
      && (!profile || !session.profile || session.profile === profile))
    if (index < 0 || sessions.value[index].title === normalized) return
    sessions.value.splice(index, 1, { ...sessions.value[index], title: normalized })
  }

  function cancelSessionListRefresh(): void {
    if (sessionListRefreshTimer === undefined) return
    window.clearTimeout(sessionListRefreshTimer)
    sessionListRefreshTimer = undefined
  }

  function scheduleSessionListRefresh(): void {
    if (auth.status !== 'authenticated') return
    cancelSessionListRefresh()
    sessionListRefreshTimer = window.setTimeout(() => {
      sessionListRefreshTimer = undefined
      void loadSessions(sessionListProfile ?? auth.activeProfile?.name, sessionView).catch(() => undefined)
    }, SESSION_LIST_REFRESH_DEBOUNCE_MS)
  }

  function cacheScope(profile: string): string {
    return `${auth.user?.id ?? 'anonymous'}:${profile}`
  }

  function scheduleReconnect(): void {
    if (!auth.isAuthenticated || reconnectTimer !== undefined) return
    const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    connectionState.value = 'reconnecting'
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      void connect().catch(() => scheduleReconnect())
    }, delay)
  }

  function accountId(): string { return auth.user?.id ?? 'anonymous' }

  function updateInflightMarker(state: ChatRouteState): void {
    const markers = readInflightSessionMarkers(accountId())
    const matches = (marker: InflightSessionMarker) => marker.profile === state.route.profile
      && marker.sessionId === state.route.sessionId
    const shouldKeep = state.isStreaming || state.isQueued || Boolean(state.pendingApproval) || Boolean(state.pendingClarification)
    const next = shouldKeep
      ? [...markers.filter(marker => !matches(marker)), { profile: state.route.profile, sessionId: state.route.sessionId }]
      : markers.filter(marker => !matches(marker))
    writeInflightSessionMarkers(accountId(), next)
  }

  function clearInflightMarker(profile: string, sessionId: string): void {
    const markers = readInflightSessionMarkers(accountId())
    writeInflightSessionMarkers(accountId(), markers.filter(marker => marker.profile !== profile || marker.sessionId !== sessionId))
  }

  function recoverPersistedInflightSessions(): Promise<void> | undefined {
    if (!auth.isAuthenticated || persistedRecoveryPromise) return persistedRecoveryPromise
    const markers = readInflightSessionMarkers(accountId())
    if (!markers.length) return undefined
    const operation = Promise.all(markers.map(async marker => {
      const state = ensureRoute(marker.profile, marker.sessionId)
      try {
        const resumed = await ensureRuntime(state)
        updateInflightMarker(resumed)
      } catch {
        // Keep the marker. A transient reconnect failure must not turn into an
        // accidental interruption before Hermes's disconnect grace expires.
      }
    })).then(() => undefined)
    persistedRecoveryPromise = operation.finally(() => { persistedRecoveryPromise = undefined })
    return persistedRecoveryPromise
  }

  socket.onState((state, reason) => {
    connectionState.value = state
    if (state === 'ready') {
      reconnectAttempt = 0
      const shouldResume = hasConnectedOnce
      hasConnectedOnce = true
      const active = activeRouteState.value
      if (shouldResume && active?.isStreaming && !active.runtimeSessionId && !reconnectResumePromise) {
        reconnectResumePromise = ensureRuntime(active)
          .catch(cause => { active.error = errorMessage(cause) })
          .finally(() => { reconnectResumePromise = undefined })
      }
      void recoverPersistedInflightSessions()
    }
    if (state === 'failed') {
      runtimeRoutes.clear()
      for (const route of Object.values(routes)) {
        route.runtimeSessionId = undefined
        route.serverFastMode = undefined
      }
      error.value = reason || '聊天实时连接已断开'
      scheduleReconnect()
    }
  })

  function migrateRoute(oldKey: string, storedSessionId: string, runtimeSessionId: string): ChatRouteState {
    const oldState = routes[oldKey]
    if (!oldState) throw new Error('会话状态已经失效')
    const newKey = routeKey(oldState.route.profile, storedSessionId)
    const target = routes[newKey]
    const migrated: ChatRouteState = {
      ...(target ?? oldState),
      route: { profile: oldState.route.profile, sessionId: storedSessionId },
      messages: target ? mergeChatMessages(target.messages, oldState.messages) : oldState.messages,
      runtimeSessionId,
    }
    routes[newKey] = migrated
    if (newKey !== oldKey) delete routes[oldKey]
    if (desiredModelRoutes.delete(oldKey)) desiredModelRoutes.add(newKey)
    runtimeRoutes.set(runtimeSessionId, newKey)
    if (activeSessionId.value === oldState.route.sessionId && activeProfileName.value === oldState.route.profile) {
      activeSessionId.value = storedSessionId
    }
    if (newKey !== oldKey) {
      moveSessionFastMode(auth.user?.id ?? 'local', oldState.route.profile, oldState.route.sessionId, storedSessionId, migrated.fastMode ?? false)
    }
    const draftIndex = sessions.value.findIndex(session => session.id === oldState.route.sessionId && session.profile === oldState.route.profile)
    const now = Date.now() / 1000
    const summary: SessionSummary = draftIndex >= 0
      ? { ...sessions.value[draftIndex], id: storedSessionId, owned: true, updatedAt: now }
      : { id: storedSessionId, profile: oldState.route.profile, source: 'web', owned: true, title: '新会话', messageCount: 0, toolCallCount: 0, startedAt: now, updatedAt: now }
    if (draftIndex >= 0) sessions.value.splice(draftIndex, 1, summary)
    else sessions.value.unshift(summary)
    return routes[newKey]
  }

  socket.onEvent(event => {
    if (event.type === 'gateway.ready') return
    const payload = record(event.payload)
    if (event.type === 'sessions.changed') {
      scheduleSessionListRefresh()
      return
    }
    const runtimeId = string(event.session_id ?? payload.session_id ?? payload.sessionId)
    let key = runtimeRoutes.get(runtimeId)
    if (!key) key = Object.keys(routes).find(candidate => routes[candidate].runtimeSessionId === runtimeId
      || routes[candidate].route.sessionId === runtimeId)
    if (event.type === 'session.title' || event.type === 'session.title.updated') {
      const state = key ? routes[key] : undefined
      const storedSessionId = state?.route.sessionId
        || string(payload.stored_session_id ?? payload.storedSessionId ?? payload.session_key
          ?? payload.session_id ?? payload.sessionId)
      const profile = state?.route.profile || string(event.profile ?? payload.profile) || undefined
      reconcileSessionTitle(profile, storedSessionId, string(payload.title))
      scheduleSessionListRefresh()
      if (!key) return
    }
    if (!key) return
    let state = routes[key]
    if (event.type === 'session.info') {
      const storedId = string(payload.stored_session_id ?? payload.storedSessionId ?? payload.session_key)
      if (storedId && storedId !== state.route.sessionId) {
        state = migrateRoute(key, storedId, runtimeId)
        key = routeKey(state.route.profile, storedId)
      }
      const liveSelection = modelSelectionFromSessionInfo(payload)
      if (liveSelection) {
        reconcileSessionModel(state.route.profile, state.route.sessionId, liveSelection.model, liveSelection.provider)
      }
    }
    const info = record(payload.info)
    const liveFastMode = optionalBoolean(payload.fast ?? info.fast)
    if (liveFastMode !== undefined && (event.type === 'session.info' || (event.type === 'session.command' && payload.action === 'fast'))) {
      state.serverFastMode = liveFastMode
      if (!state.fastModeDirty) state.fastMode = liveFastMode
      persistFastMode(state)
    }
    const attributedPayload = { ...payload, session_id: state.route.sessionId } as JsonValue
    const updated = applyChatEvent(state, {
      ...event, session_id: state.route.sessionId, profile: state.route.profile, payload: attributedPayload,
    })
    routes[key] = updated
    updateInflightMarker(updated)
    if (['message.complete', 'run.completed'].includes(event.type)) {
      void refreshContextUsage(updated).catch(() => undefined)
    }
  })

  async function connect(): Promise<void> {
    if (['connected', 'ready'].includes(connectionState.value)) return
    if (connectPromise) return connectPromise
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    connectPromise = socket.connect().catch(cause => {
      connectionState.value = 'failed'
      error.value = errorMessage(cause)
      throw cause
    }).finally(() => { connectPromise = undefined })
    return connectPromise
  }

  function disconnect(): void {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    hasConnectedOnce = false
    socket.close()
    runtimeRoutes.clear()
    runtimePromises.clear()
    desiredModelRoutes.clear()
    pendingModelConfirmations.clear()
    cancelSessionListRefresh()
    for (const state of Object.values(routes)) {
      state.runtimeSessionId = undefined
      state.serverFastMode = undefined
    }
  }

  function switchProfile(profile: string): void {
    sessionLoadGeneration += 1
    modelLoadGeneration += 1
    unreadLoadGeneration += 1
    disconnect()
    activeSessionId.value = undefined
    activeProfileName.value = profile
    nextSessionCursor = undefined
    hasMoreSessions.value = false
    isLoadingMoreSessions.value = false
    error.value = undefined
  }

  function clearAccountState(): void {
    sessions.value = []
    nextSessionCursor = undefined
    hasMoreSessions.value = false
    isLoadingMoreSessions.value = false
    activeSessionId.value = undefined
    activeProfileName.value = undefined
    sessionListProfile = undefined
    cancelSessionListRefresh()
    runtimeRoutes.clear()
    for (const key of Object.keys(routes)) delete routes[key]
    unreadCounts.value = {}
    error.value = undefined
  }

  watch(() => auth.status, status => {
    if (status !== 'authenticated') {
      disconnect()
      clearAccountState()
    }
  })

  let sessionView: 'chat' | 'history' = 'chat'
  async function loadSessions(profile?: string, view: 'chat' | 'history' = sessionView): Promise<void> {
    sessionView = view
    const requestedProfile = profile || undefined
    sessionListProfile = requestedProfile
    const loadGeneration = ++sessionLoadGeneration
    isLoading.value = true
    error.value = undefined
    try {
      const page = await getSessions(requestedProfile, undefined, 100, sessionView)
      if (loadGeneration !== sessionLoadGeneration
        || (requestedProfile && auth.activeProfile?.name !== requestedProfile)) return
      // 9119 owns recency within each bucket. Pinning is an explicit user
      // command, so pinned sessions always form the visible top partition.
      sessions.value = pinnedSessionsFirst(page.items)
      nextSessionCursor = page.nextCursor ?? undefined
      hasMoreSessions.value = Boolean(nextSessionCursor)
    } catch (cause) {
      if (loadGeneration === sessionLoadGeneration) error.value = errorMessage(cause)
      throw cause
    } finally {
      if (loadGeneration === sessionLoadGeneration) isLoading.value = false
    }
  }

  async function loadMoreSessions(profile = auth.activeProfile?.name): Promise<void> {
    const cursor = nextSessionCursor
    const requestedProfile = profile || undefined
    if (!cursor || isLoadingMoreSessions.value) return
    const loadGeneration = sessionLoadGeneration
    isLoadingMoreSessions.value = true
    try {
      const page = await getSessions(requestedProfile, cursor, 100, sessionView)
      if (loadGeneration !== sessionLoadGeneration
        || (requestedProfile && auth.activeProfile?.name !== requestedProfile)) return
      sessions.value = appendSessionPage(sessions.value, page.items)
      nextSessionCursor = page.nextCursor ?? undefined
      hasMoreSessions.value = Boolean(nextSessionCursor)
    } catch (cause) {
      if (loadGeneration === sessionLoadGeneration) error.value = errorMessage(cause)
      throw cause
    } finally {
      if (loadGeneration === sessionLoadGeneration) isLoadingMoreSessions.value = false
    }
  }

  async function loadUnread(profile?: string): Promise<void> {
    const loadGeneration = ++unreadLoadGeneration
    const loaded = await getSessionUnread(profile)
    if (loadGeneration === unreadLoadGeneration && (!profile || auth.activeProfile?.name === profile)) {
      unreadCounts.value = loaded
    }
  }

  async function markRead(sessionId = activeSessionId.value, profile = activeProfileName.value): Promise<void> {
    if (!sessionId) return
    const state = profile ? routes[routeKey(profile, sessionId)] : undefined
    const summaryCount = sessions.value.find(session => session.id === sessionId)?.messageCount ?? 0
    const count = Math.max(state?.messageTotal ?? 0, summaryCount)
    await markSessionRead(sessionId, count, profile)
    unreadCounts.value = { ...unreadCounts.value, [sessionId]: 0 }
  }

  async function loadHistory(state: ChatRouteState, forceRefresh = false): Promise<void> {
    const generation = ++state.generation
    state.isLoadingHistory = true
    state.error = undefined
    const scope = cacheScope(state.route.profile)
    const cached = await historyCache.get(scope, state.route.sessionId)
    if (generation !== state.generation) return
    if (cached?.messages.length) {
      state.messages = mergeChatMessages(state.messages, cached.messages, 'snapshot')
      state.messageTotal = cached.total
      state.loadedMessageCount = cached.messages.length
    }
    try {
      const page = await getMessages(state.route.sessionId, 0, 150, state.route.profile, forceRefresh)
      if (generation !== state.generation) return
      if (forceRefresh && routes[routeKey(state.route.profile, state.route.sessionId)]?.isStreaming) {
        throw new Error('正在回复，请结束后再刷新历史')
      }
      const retained = forceRefresh ? state.messages.filter(message => message.role === 'user' && message.stage !== 'settled') : state.messages
      state.messages = mergeChatMessages(retained, page.messages, 'snapshot')
      state.messageTotal = page.total
      state.loadedMessageCount = page.returned
      state.hasMoreBefore = page.hasMore
      state.historySynced = true
      if (page.session) {
        const index = sessions.value.findIndex(session => session.id === page.session!.id && session.profile === page.session!.profile)
        if (index >= 0) sessions.value.splice(index, 1, page.session)
      }
      await historyCache.set(scope, state.route.sessionId, { messages: state.messages, total: page.total, savedAt: Date.now() })
    } catch (cause) {
      if (generation === state.generation) state.error = errorMessage(cause)
      throw cause
    } finally {
      if (generation === state.generation) state.isLoadingHistory = false
    }
  }

  async function selectSession(sessionId: string, profile?: string): Promise<void> {
    const session = sessions.value.find(item => item.id === sessionId && (!profile || item.profile === profile))
    const selectedProfile = profile ?? session?.profile ?? auth.activeProfile?.name ?? 'default'
    activeSessionId.value = sessionId
    activeProfileName.value = selectedProfile
    const state = ensureRoute(selectedProfile, sessionId)
    syncSelectedModel(session?.model, session?.provider)
    // Reading an old session must not rewrite the server's last_active field.
    // The runtime is attached lazily by send/interrupt/usage, or when a known
    // in-flight turn reconnects. REST history remains authoritative here.
    if (!state.historySynced) await loadHistory(state)
    const refreshed = sessions.value.find(item => item.id === sessionId && item.profile === selectedProfile)
    syncSelectedModel(refreshed?.model, refreshed?.provider)
  }

  async function forceRefreshHistory(): Promise<void> {
    const state = activeRouteState.value
    if (!state || state.isLoadingHistory || state.isStreaming || state.isQueued || state.pendingApproval || state.pendingClarification || state.route.sessionId.startsWith('draft-')) return
    await loadHistory(state, true)
  }

  async function loadOlder(): Promise<void> {
    const state = activeRouteState.value
    if (!state || state.isLoadingHistory || !state.hasMoreBefore) return
    const generation = state.generation
    state.isLoadingHistory = true
    try {
      const page = await getMessages(state.route.sessionId, state.loadedMessageCount, 150, state.route.profile)
      if (generation !== state.generation) return
      state.messages = mergeChatMessages(state.messages, page.messages, 'prepend')
      state.loadedMessageCount += page.returned
      state.messageTotal = Math.max(state.messageTotal, page.total)
      state.hasMoreBefore = page.hasMore
      await historyCache.set(cacheScope(state.route.profile), state.route.sessionId, {
        messages: state.messages, total: state.messageTotal, savedAt: Date.now(),
      })
    } catch (cause) { state.error = errorMessage(cause) }
    finally { if (generation === state.generation) state.isLoadingHistory = false }
  }

  function createSession(profile = auth.activeProfile?.name ?? 'default'): string {
    const id = `draft-${createId('session')}`
    const now = Date.now() / 1000
    sessions.value.unshift({ id, profile, source: 'web', title: '新会话', messageCount: 0, toolCallCount: 0, startedAt: now, updatedAt: now })
    ensureRoute(profile, id)
    activeSessionId.value = id
    activeProfileName.value = profile
    return id
  }
  function clearSelection(): void { activeSessionId.value = undefined }

  async function performEnsureRuntime(initialState: ChatRouteState): Promise<ChatRouteState> {
    if (initialState.runtimeSessionId) return initialState
    await connect()
    const initialKey = routeKey(initialState.route.profile, initialState.route.sessionId)
    if (initialState.route.sessionId.startsWith('draft-')) {
      const params: Record<string, JsonValue> = {
        profile: initialState.route.profile, source: 'web', close_on_disconnect: false,
      }
      if (reasoningEffort.value) params.reasoning_effort = reasoningEffort.value
      params.fast = initialState.fastMode ?? false
      const result = resultRecord(await socket.request('session.create', params))
      const runtimeId = string(result.session_id ?? result.sessionId)
      const storedId = string(result.stored_session_id ?? result.storedSessionId ?? result.session_key)
      if (!runtimeId || !storedId) throw new Error('Hermes 未返回新会话标识')
      const migrated = migrateRoute(initialKey, storedId, runtimeId)
      const info = record(result.info)
      if (!desiredModelRoutes.has(routeKey(migrated.route.profile, migrated.route.sessionId))) {
        syncSelectedModel(string(result.model ?? info.model), string(result.provider ?? info.provider))
      }
      const liveFastMode = optionalBoolean(result.fast ?? info.fast)
      migrated.serverFastMode = liveFastMode ?? migrated.fastMode ?? false
      if (!migrated.fastModeDirty && liveFastMode !== undefined) migrated.fastMode = liveFastMode
      migrated.fastModeDirty = false
      persistFastMode(migrated)
      return migrated
    }
    const result = resultRecord(await socket.request('session.resume', {
      session_id: initialState.route.sessionId,
      profile: initialState.route.profile,
      source: 'web',
      omit_messages: true,
    }))
    const runtimeId = string(result.session_id ?? result.sessionId)
    if (!runtimeId) throw new Error('Hermes 未返回运行会话标识')
    const storedId = string(result.stored_session_id ?? result.storedSessionId ?? result.session_key, initialState.route.sessionId)
    const migrated = migrateRoute(initialKey, storedId, runtimeId)
    const info = record(result.info)
    if (!desiredModelRoutes.has(routeKey(migrated.route.profile, migrated.route.sessionId))) {
      syncSelectedModel(string(result.model ?? info.model), string(result.provider ?? info.provider))
    }
    const liveFastMode = optionalBoolean(result.fast ?? info.fast)
    migrated.serverFastMode = liveFastMode
    if (!migrated.fastModeDirty && liveFastMode !== undefined) migrated.fastMode = liveFastMode
    persistFastMode(migrated)
    const resumedMessages = values(result.messages)
      .map(value => normalizeChatMessage(value, storedId, migrated.route.profile))
    if (resumedMessages.length) migrated.messages = mergeChatMessages(migrated.messages, resumedMessages, 'snapshot')
    const inflight = record(result.inflight ?? result.active_run)
    const assistant = string(inflight.assistant)
    const inflightError = string(inflight.error)
    migrated.isStreaming = bool(result.running) || bool(inflight.streaming)
    const queued = record(result.queued)
    const queuedUser = string(queued.user)
    migrated.isQueued = Boolean(queuedUser)
    if (assistant || inflightError) {
      migrated.messages = mergeChatMessages(migrated.messages, [{
        id: `resume:${runtimeId}`,
        sessionId: storedId,
        profile: migrated.route.profile,
        role: 'assistant',
        content: assistant,
        timestamp: number(result.turn_started_at, Date.now() / 1000),
        stage: inflightError ? 'failed' : migrated.isStreaming ? 'streaming' : 'settled',
        isStreaming: migrated.isStreaming,
        error: inflightError || undefined,
      }])
    }
    values(inflight.corrections).forEach((correction, index) => {
      const content = string(correction)
      if (!content) return
      migrated.messages = mergeChatMessages(migrated.messages, [{
        id: `resume-correction:${runtimeId}:${index}`,
        sessionId: storedId,
        profile: migrated.route.profile,
        role: 'user',
        content,
        timestamp: number(result.turn_started_at, Date.now() / 1000) + (index + 1) / 1000,
        stage: 'accepted',
      }])
    })
    if (queuedUser) {
      migrated.messages = mergeChatMessages(migrated.messages, [{
        id: `resume-queued:${runtimeId}`,
        sessionId: storedId,
        profile: migrated.route.profile,
        role: 'user',
        content: queuedUser,
        timestamp: Date.now() / 1000,
        stage: 'accepted',
      }])
    }
    const approval = record(result.pending_approval)
    const approvalID = string(approval.request_id ?? approval.requestId ?? approval.id)
    if (approvalID) migrated.pendingApproval = {
      id: approvalID,
      sessionId: storedId,
      message: string(approval.message ?? approval.prompt) || undefined,
      toolName: string(approval.tool_name ?? approval.tool) || undefined,
      choices: Array.isArray(approval.choices) ? approval.choices.map(String) : undefined,
      payload: approval as Record<string, JsonValue>,
    }
    const clarification = record(result.pending_clarify)
    const clarificationID = string(clarification.request_id ?? clarification.requestId ?? clarification.id)
    if (clarificationID) migrated.pendingClarification = {
      id: clarificationID,
      sessionId: storedId,
      question: string(clarification.question ?? clarification.message ?? clarification.prompt, '需要补充信息'),
      choices: Array.isArray(clarification.choices) ? clarification.choices.map(String) : undefined,
      payload: clarification as Record<string, JsonValue>,
    }
    if (storedId !== initialState.route.sessionId) clearInflightMarker(initialState.route.profile, initialState.route.sessionId)
    updateInflightMarker(migrated)
    return migrated
  }

  async function ensureRuntime(initialState: ChatRouteState): Promise<ChatRouteState> {
    if (initialState.runtimeSessionId) return initialState
    const key = routeKey(initialState.route.profile, initialState.route.sessionId)
    const existing = runtimePromises.get(key)
    if (existing) return existing
    let operation: Promise<ChatRouteState>
    operation = performEnsureRuntime(initialState).finally(() => {
      if (runtimePromises.get(key) === operation) runtimePromises.delete(key)
    })
    runtimePromises.set(key, operation)
    return operation
  }

  function updateDelivery(state: ChatRouteState, clientMessageId: string, patch: Partial<ChatMessage>): void {
    state.messages = state.messages.map(message => message.clientMessageId === clientMessageId || message.id === clientMessageId
      ? { ...message, ...patch }
      : message)
  }

  async function send(
    text: string,
    files: File[] = [],
    mode: 'submit' | 'queue' | 'steer' = 'submit',
  ): Promise<void> {
    let state = activeRouteState.value
    if (!state) {
      createSession()
      state = activeRouteState.value!
    }
    const trimmed = text.trim()
    if (!trimmed && !files.length) return
    const clientMessageId = createId('message')
    const attachments: ChatAttachment[] = files.map((file, index) => ({
      id: `${clientMessageId}:${index}`, name: file.name, mimeType: file.type || 'application/octet-stream',
      size: file.size, kind: file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'file',
    }))
    const optimistic: ChatMessage = {
      id: clientMessageId, clientMessageId, sessionId: state.route.sessionId, profile: state.route.profile,
      role: 'user', content: trimmed, timestamp: Date.now() / 1000, stage: 'preparing', attachments,
    }
    state.messages = mergeChatMessages(state.messages, [optimistic])
    isSending.value = true
    error.value = undefined
    let submitted = false
    try {
      state = await ensureRuntime(state)
      const runtimeId = state.runtimeSessionId!
      if (!await applyDesiredModel(state)) throw new Error('请先确认模型切换，再重新发送消息')
      if (reasoningEffort.value) {
        await socket.request('config.set', {
          session_id: runtimeId, key: 'reasoning', value: reasoningEffort.value, scope: 'session',
        })
      }
      const desiredFastMode = state.fastMode ?? false
      if (state.serverFastMode !== desiredFastMode) {
        await socket.request('config.set', {
          session_id: runtimeId, key: 'fast', value: desiredFastMode ? 'fast' : 'normal', scope: 'session',
        })
        state.serverFastMode = desiredFastMode
        state.fastModeDirty = false
        persistFastMode(state)
      }
      const parts = trimmed ? [trimmed] : []
      for (const file of files) {
        const encoded = await encodeAttachment(file)
        if (encoded.kind === 'image') {
          await socket.request('image.attach_bytes', {
            session_id: runtimeId, content_base64: encoded.base64, filename: encoded.name, ext: encoded.extension,
          })
          parts.push(`[用户附加图片：${encoded.name}]`)
        } else if (encoded.kind === 'pdf') {
          await socket.request('pdf.attach', { session_id: runtimeId, content_base64: encoded.base64, filename: encoded.name })
          parts.push(`[用户附加 PDF：${encoded.name}]`)
        } else {
          const result = resultRecord(await socket.request('file.attach', {
            session_id: runtimeId, name: encoded.name, data_url: encoded.dataUrl,
          }))
          parts.push(`[用户附加文件：${encoded.name}]${string(result.ref_text) ? `\n${string(result.ref_text)}` : ''}`)
        }
      }
      updateDelivery(state, clientMessageId, { stage: files.length ? 'attached' : 'pending', sessionId: state.route.sessionId })
      updateDelivery(state, clientMessageId, { stage: 'pending' })
      submitted = true
      const effectiveMode = mode === 'steer' && files.length ? 'queue' : mode
      const method = effectiveMode === 'steer' ? 'session.steer' : 'prompt.submit'
      const result = resultRecord(await socket.request(method, {
        session_id: runtimeId,
        text: parts.join('\n\n'),
        ...(effectiveMode === 'queue' ? { queued: true } : {}),
      }, 120_000, `web:prompt:${clientMessageId}`))
      const status = string(result.status, 'accepted').toLowerCase()
      if (effectiveMode === 'steer' && !['accepted', 'queued', 'steered', 'streaming'].includes(status)) {
        throw new RpcError(string(result.error ?? result.message, 'Hermes 拒绝了 Steer 请求'), status)
      }
      updateDelivery(state, clientMessageId, { stage: 'accepted' })
      const running = ['running', 'started', 'streaming'].includes(status)
      if (effectiveMode === 'steer') {
        // A steer receipt acknowledges injection into the current run. It is
        // not evidence of a new run, including Hermes's `status: queued`.
        state.isQueued = false
        if (running) state.isStreaming = true
      } else {
        state.isQueued = status === 'queued'
        if (running || status === 'accepted') {
          state.isQueued = false
          state.isStreaming = true
        }
      }
      updateInflightMarker(state)
      // The optimistic row remains local, but the sidebar is refreshed only
      // after a 9119 receipt and keeps the order returned by the server.
      void loadSessions(state.route.profile).catch(() => undefined)
    } catch (cause) {
      const explicitRejection = cause instanceof RpcError
      const stage = submitted && !explicitRejection ? 'unknown-receipt' : 'failed'
      updateDelivery(state, clientMessageId, { stage, error: errorMessage(cause) })
      state.error = errorMessage(cause)
      throw cause
    } finally { isSending.value = false }
  }

  async function interrupt(): Promise<void> {
    const state = activeRouteState.value
    if (!state) return
    const current = await ensureRuntime(state)
    await socket.request('session.interrupt', { session_id: current.runtimeSessionId! }, 15_000)
    current.isStreaming = false
    current.isQueued = false
    current.messages = current.messages.map(message => message.role === 'assistant' && message.isStreaming
      ? { ...message, stage: message.stage === 'streaming' ? 'settled' : message.stage, isStreaming: false }
      : message)
    clearInflightMarker(current.route.profile, current.route.sessionId)
  }

  async function respondToApproval(requestId: string, approved: boolean | 'once' | 'session' | 'always' | 'deny'): Promise<void> {
    const state = activeRouteState.value
    if (!state) return
    const choice = typeof approved === 'boolean' ? approved ? 'once' : 'deny' : approved
    const modelConfirmation = pendingModelConfirmations.get(requestId)
    if (modelConfirmation) {
      pendingModelConfirmations.delete(requestId)
      const target = routes[modelConfirmation.routeKey]
      if (!target) throw new Error('模型确认请求已失效')
      const modelState = await ensureRuntime(target)
      if (choice === 'deny') {
        desiredModelRoutes.delete(modelConfirmation.routeKey)
        restoreSelectedSessionModel(modelConfirmation.routeKey)
      } else {
        try {
          if (await configureModel(modelState, modelConfirmation.model, true)) {
            desiredModelRoutes.delete(modelConfirmation.routeKey)
          }
        } catch (cause) {
          desiredModelRoutes.delete(modelConfirmation.routeKey)
          restoreSelectedSessionModel(modelConfirmation.routeKey)
          modelState.pendingApproval = undefined
          throw cause
        }
      }
      modelState.pendingApproval = undefined
      return
    }
    const current = await ensureRuntime(state)
    await socket.request('approval.respond', { session_id: current.runtimeSessionId!, choice })
    if (current.pendingApproval?.id === requestId) current.pendingApproval = undefined
  }

  async function respondToClarification(requestId: string, response: string): Promise<void> {
    const state = activeRouteState.value
    if (!state) return
    const current = await ensureRuntime(state)
    await socket.request('clarify.respond', { session_id: current.runtimeSessionId!, request_id: requestId, answer: response })
    if (current.pendingClarification?.id === requestId) current.pendingClarification = undefined
  }

  async function branchSession(): Promise<string | undefined> {
    const state = activeRouteState.value
    if (!state) return
    const current = await ensureRuntime(state)
    const result = resultRecord(await socket.request('session.branch', { session_id: current.runtimeSessionId! }))
    const runtimeId = string(result.session_id ?? result.sessionId)
    const storedId = string(result.stored_session_id ?? result.storedSessionId)
    if (!runtimeId || !storedId) throw new Error('Hermes 未返回分支会话标识')
    const next = emptyRoute(current.route.profile, storedId)
    next.runtimeSessionId = runtimeId
    routes[routeKey(current.route.profile, storedId)] = next
    runtimeRoutes.set(runtimeId, routeKey(current.route.profile, storedId))
    activeSessionId.value = storedId
    activeProfileName.value = current.route.profile
    // The branch was created by 9119, but its position remains server-owned.
    void loadSessions(current.route.profile).catch(() => undefined)
    return storedId
  }

  async function renameSession(id: string, title: string, profile?: string): Promise<void> {
    await updateSession(id, { title }, profile)
    await loadSessions(profile)
  }

  async function setSessionPinned(id: string, pinned: boolean, profile?: string): Promise<void> {
    await updateSession(id, { pinned }, profile)
    await loadSessions(profile)
  }

  async function removeSession(id: string, profile?: string): Promise<void> {
    if (!id.startsWith('draft-')) await deleteSessionApi(id, profile)
    sessions.value = sessions.value.filter(session => session.id !== id || (profile && session.profile !== profile))
    if (activeSessionId.value === id && (!profile || activeProfileName.value === profile)) {
      activeSessionId.value = undefined
      activeProfileName.value = undefined
    }
  }

  async function loadModels(profile = auth.activeProfile?.name): Promise<void> {
    const loadGeneration = ++modelLoadGeneration
    const loaded = await getModels(profile)
    if (loadGeneration !== modelLoadGeneration || (profile && auth.activeProfile?.name !== profile)) return
    models.value = loaded
    selectedModel.value = modelForSession(models.value, activeSession.value?.model, activeSession.value?.provider)
      ?? models.value.find(model => model.isDefault) ?? models.value[0]
  }

  async function refreshActiveSessionModel(): Promise<void> {
    const state = activeRouteState.value
    if (!state || state.route.sessionId.startsWith('draft-')) return
    const expectedKey = routeKey(state.route.profile, state.route.sessionId)
    const refreshed = await getSession(state.route.sessionId, state.route.profile)
    const current = activeRouteState.value
    if (!current || routeKey(current.route.profile, current.route.sessionId) !== expectedKey || !refreshed.model) return
    reconcileSessionModel(current.route.profile, current.route.sessionId, refreshed.model, refreshed.provider)
  }

  async function configureModel(state: ChatRouteState, model: ModelOption, confirmsExpensiveModel: boolean): Promise<boolean> {
    const result = resultRecord(await socket.request('config.set', {
      session_id: state.runtimeSessionId!,
      key: 'model',
      value: `${model.id} --provider ${model.provider} --session`,
      ...(confirmsExpensiveModel ? { confirm_expensive_model: true } : {}),
    }))
    if (bool(result.confirm_required ?? result.confirmRequired)) {
      const requestId = createId('expensive-model')
      pendingModelConfirmations.set(requestId, { routeKey: routeKey(state.route.profile, state.route.sessionId), model })
      state.pendingApproval = {
        id: requestId,
        sessionId: state.route.sessionId,
        message: string(result.confirm_message ?? result.confirmMessage ?? result.warning, '此模型可能产生较高费用，请确认后使用。'),
        choices: ['once', 'deny'],
        payload: result as Record<string, JsonValue>,
      }
      return false
    }
    // Match iOS: switching a model invalidates the cached fast-mode server
    // state, so the desired mode is re-applied before the next prompt.
    state.serverFastMode = undefined
    return true
  }

  async function applyDesiredModel(state: ChatRouteState): Promise<boolean> {
    const key = routeKey(state.route.profile, state.route.sessionId)
    if (!desiredModelRoutes.has(key) || !selectedModel.value || !state.runtimeSessionId) return true
    const applied = await configureModel(state, selectedModel.value, false)
    if (applied) desiredModelRoutes.delete(key)
    return applied
  }

  async function setModel(model: ModelOption): Promise<void> {
    selectedModel.value = model
    const state = activeRouteState.value
    if (!state) return
    const key = routeKey(state.route.profile, state.route.sessionId)
    desiredModelRoutes.add(key)
    if (!state.runtimeSessionId) return
    try {
      if (await configureModel(state, model, false)) desiredModelRoutes.delete(key)
    } catch (cause) {
      desiredModelRoutes.delete(key)
      restoreSelectedSessionModel(key)
      throw cause
    }
  }

  async function setFastMode(enabled: boolean): Promise<void> {
    const state = activeRouteState.value
    if (!state) return
    const previous = state.fastMode ?? false
    state.fastMode = enabled
    state.fastModeDirty = true
    persistFastMode(state)
    if (!state.runtimeSessionId || state.isStreaming || !['connected', 'ready'].includes(connectionState.value)) return
    try {
      await socket.request('config.set', {
        session_id: state.runtimeSessionId, key: 'fast', value: enabled ? 'fast' : 'normal', scope: 'session',
      })
      state.serverFastMode = enabled
      state.fastModeDirty = false
    } catch (cause) {
      state.fastMode = previous
      state.fastModeDirty = false
      persistFastMode(state)
      error.value = `快速模式未同步：${errorMessage(cause)}`
      throw cause
    }
  }

  async function refreshContextUsage(initialState = activeRouteState.value): Promise<void> {
    // Opening history is read-only. Resuming an old session merely to fetch
    // usage updates Hermes' last_active timestamp and incorrectly moves it
    // into today's sidebar group.
    if (!initialState || initialState.route.sessionId.startsWith('draft-') || !initialState.runtimeSessionId) return
    const current = initialState
    const usage = resultRecord(await socket.request('session.usage', { session_id: current.runtimeSessionId! }))
    current.usage = {
      inputTokens: number(usage.input_tokens ?? usage.input) || undefined,
      outputTokens: number(usage.output_tokens ?? usage.output) || undefined,
      totalTokens: number(usage.total_tokens ?? usage.total) || undefined,
      contextTokens: number(usage.context_tokens ?? usage.context_used ?? usage.used) || undefined,
      contextLimit: number(usage.context_limit ?? usage.context_max ?? usage.limit) || undefined,
      percentUsed: number(usage.percent_used ?? usage.context_percent) || undefined,
      raw: usage as JsonValue,
    }
  }

  return {
    sessions, activeSessionId, activeProfileName, activeSession, routes, activeRouteState, messages,
    connectionState, historySynced, hasMoreBefore, isLoading, isLoadingMoreSessions, hasMoreSessions, isSending, isStreaming, isQueued,
    error, models, selectedModel, reasoningEffort, fastMode, contextUsage, pendingApproval, pendingClarification, unreadCounts,
    loadSessions, loadMoreSessions, selectSession, loadOlder, forceRefreshHistory, createSession, clearSelection, connect, disconnect, send, interrupt,
    respondToApproval, respondToClarification, branchSession, renameSession, setSessionPinned, removeSession,
    loadModels, setModel, setFastMode, refreshActiveSessionModel, refreshContextUsage, loadUnread, markRead, switchProfile,
  }
})
