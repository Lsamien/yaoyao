import { apiRequest } from './client'
import { SSEParser } from '@shared/sse'
import {
  applyTranscriptEvent,
  CHAT_TRANSCRIPT_FEATURE,
  TranscriptGap,
  type TranscriptEvent,
  type TranscriptControlEvent,
  type TranscriptMessage,
  type TranscriptSnapshot,
} from '@shared/chatTranscript'

/** Serial, durable replica: no state/cursor becomes visible before changed commits it. */
export class ChatTranscriptClient {
  private abort = new AbortController()
  private snapshot?: TranscriptSnapshot
  private fetchingOlder = false
  private operations: Promise<unknown> = Promise.resolve()
  private request?: AbortController
  private readonly foreground = () => {
    if (document.visibilityState === 'visible') this.request?.abort()
  }
  constructor(
    readonly profile: string,
    readonly sessionId: string,
    readonly changed: (snapshot: TranscriptSnapshot) => Promise<void>,
    readonly failed: (error: Error) => void,
    readonly initialCount = 150,
  ) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.foreground)
  }
  static async supported(): Promise<boolean> {
    return (await apiRequest<{ features: string[] }>('/api/app/chat/capabilities')).features.includes(
      CHAT_TRANSCRIPT_FEATURE,
    )
  }
  close() {
    this.abort.abort()
    this.request?.abort()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.foreground)
  }
  restore(value: TranscriptSnapshot) {
    if (
      value.protocol === CHAT_TRANSCRIPT_FEATURE &&
      value.profile === this.profile &&
      value.sessionId === this.sessionId
    )
      this.snapshot = value
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation, operation)
    this.operations = task.catch(() => {})
    return task
  }
  private path(suffix: string, query: Record<string, string> = {}) {
    return `/api/app/chat/sessions/${encodeURIComponent(this.sessionId)}/${suffix}?${new URLSearchParams({ profile: this.profile, ...query })}`
  }
  private async page(before?: number): Promise<TranscriptSnapshot> {
    const value = await apiRequest<TranscriptSnapshot>(
      this.path('snapshot', { limit: '150', ...(before === undefined ? {} : { before: String(before) }) }),
      { signal: this.abort.signal },
    )
    if (
      value.protocol !== CHAT_TRANSCRIPT_FEATURE ||
      value.profile !== this.profile ||
      value.sessionId !== this.sessionId
    )
      throw new TranscriptGap()
    return value
  }
  private async commit(value: TranscriptSnapshot) {
    if (this.abort.signal.aborted) return
    await this.changed(value)
    if (!this.abort.signal.aborted) this.snapshot = value
  }
  private merge(current: TranscriptSnapshot, page: TranscriptSnapshot): TranscriptMessage[] {
    const deleted = new Set([...(current.deletedIds ?? []), ...(page.deletedIds ?? [])])
    const messages = new Map(current.messages.filter((m) => !deleted.has(m.id)).map((m) => [m.id, m]))
    for (const message of page.messages)
      if (!deleted.has(message.id) && (messages.get(message.id)?.revision ?? 0) < message.revision)
        messages.set(message.id, message)
    return [...messages.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
  }
  private async hydrate() {
    let value = await this.page()
    if (this.abort.signal.aborted) return
    while (value.messages.length < this.initialCount && value.hasOlder && value.messages.length) {
      const older = await this.page(value.messages[0]!.seq)
      if (older.epoch !== value.epoch) throw new TranscriptGap()
      const messages = this.merge(value, older),
        added = messages.length - value.messages.length
      value = {
        ...value,
        messages,
        hasOlder: older.hasOlder,
        deletedIds: [...new Set([...(value.deletedIds ?? []), ...(older.deletedIds ?? [])])],
      }
      if (!added) break
    }
    await this.serial(async () => {
      const old = this.snapshot
      if (old?.epoch === value.epoch && old.cursor > value.cursor) return
      // An authoritative generation replaces the covered window. Older loaded
      // pages can be retained only inside the same epoch and outside that window.
      if (old?.epoch === value.epoch && value.messages.length) {
        const first = value.messages[0]!.seq
        value = {
          ...value,
          messages: this.merge({ ...old, messages: old.messages.filter((m) => m.seq < first) }, value),
        }
      }
      await this.commit(value)
    })
  }
  async loadOlder() {
    const starting = this.snapshot
    if (this.fetchingOlder || !starting?.hasOlder || !starting.messages.length) return
    this.fetchingOlder = true
    try {
      const page = await this.page(starting.messages[0]!.seq)
      await this.serial(async () => {
        const current = this.snapshot
        if (!current || page.epoch !== current.epoch) return
        await this.commit({
          ...current,
          messages: this.merge(current, page),
          hasOlder: page.hasOlder,
          deletedIds: [...new Set([...(current.deletedIds ?? []), ...(page.deletedIds ?? [])])],
        })
      })
    } finally {
      this.fetchingOlder = false
    }
  }
  private async receive(event: TranscriptEvent) {
    await this.serial(async () => {
      const current = this.snapshot
      if (!current) throw new TranscriptGap()
      if (
        event.profile !== this.profile ||
        event.sessionId !== this.sessionId ||
        event.epoch !== current.epoch ||
        !Number.isSafeInteger(event.cursor)
      )
        throw new TranscriptGap()
      if (event.cursor <= current.cursor) return
      if (
        event.previousCursor !== current.cursor ||
        event.type === 'session.deleted' ||
        event.type === 'session.migrated'
      )
        throw new TranscriptGap()
      const data = event.data as Record<string, any>,
        deleted = new Set(current.deletedIds ?? [])
      if (event.type === 'message.deleted') deleted.add(String(data.id))
      const before = current.messages[0]?.seq
      const unloaded =
        ['message.patch', 'message.upsert'].includes(event.type) &&
        typeof data.seq === 'number' &&
        before !== undefined &&
        data.seq < before
      const messages =
        unloaded || (event.type !== 'message.deleted' && deleted.has(String(data.id)))
          ? current.messages
          : applyTranscriptEvent(current.messages, event)
      const next: TranscriptSnapshot = {
        ...current,
        messages,
        cursor: event.cursor,
        deletedIds: [...deleted],
        total: event.total ?? current.total,
      }
      if (event.type === 'session.changed') {
        for (const key of [
          'running',
          'queued',
          'pendingApproval',
          'pendingClarification',
          'liveStatus',
          'error',
        ] as const)
          if (data[key] !== undefined) (next as any)[key] = data[key]
        if (data.eventType === 'session.info' && data.payload)
          next.session = { ...next.session, ...data.payload }
      }
      await this.commit(next)
    })
  }
  private async control(input: unknown) {
    const value = input as Partial<TranscriptControlEvent>
    const cursor = value.cursor
    await this.serial(async () => {
      const current = this.snapshot
      if (
        !current ||
        value.epoch !== current.epoch ||
        typeof cursor !== 'number' ||
        !Number.isSafeInteger(cursor) ||
        cursor < current.cursor ||
        typeof value.running !== 'boolean' ||
        typeof value.queued !== 'boolean'
      ) throw new TranscriptGap()
      const nextCursor = cursor
      await this.commit({
        ...current,
        cursor: nextCursor,
        running: value.running,
        queued: value.queued,
        pendingApproval: value.pendingApproval ?? null,
        pendingClarification: value.pendingClarification ?? null,
        liveStatus: value.liveStatus ?? null,
        error: value.error ?? null,
      })
    })
  }
  async run() {
    let needsSnapshot = !this.snapshot
    let restorePending = Boolean(this.snapshot)
    while (!this.abort.signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let watchdog: ReturnType<typeof setTimeout> | undefined
      try {
        if (restorePending) {
          const saved = this.snapshot!
          await this.serial(() => this.commit(saved))
          restorePending = false
        }
        if (needsSnapshot) {
          await this.hydrate()
          needsSnapshot = false
        }
        if (this.abort.signal.aborted) return
        const current = this.snapshot
        if (!current) return
        const attempt = new AbortController()
        this.request = attempt
        watchdog = setTimeout(() => attempt.abort(), 45_000)
        const response = await fetch(this.path('events'), {
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': `${current.epoch}:${current.cursor}` },
          credentials: 'include',
          cache: 'no-store',
          signal: attempt.signal,
        })
        if (response.status === 409) throw new TranscriptGap()
        if (!response.ok || !response.body) throw new Error(`聊天消息流 HTTP ${response.status}`)
        const parser = new SSEParser(),
          decoder = new TextDecoder()
        reader = response.body.getReader()
        while (!this.abort.signal.aborted) {
          clearTimeout(watchdog)
          watchdog = setTimeout(() => attempt.abort(), 45_000)
          const { value, done } = await reader.read()
          if (done) break
          for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
            if (frame.event === 'reset') throw new TranscriptGap()
            if (frame.event === 'ready' || frame.event === 'state') {
              await this.control(JSON.parse(frame.data))
              continue
            }
            if (frame.event === 'transcript') await this.receive(JSON.parse(frame.data))
          }
        }
      } catch (error) {
        if (this.abort.signal.aborted) return
        if (error instanceof TranscriptGap) needsSnapshot = true
        this.failed(error instanceof Error ? error : new Error('聊天消息需要同步'))
      } finally {
        clearTimeout(watchdog)
        this.request = undefined
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          this.abort.signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, 1000)
        this.abort.signal.addEventListener('abort', finish, { once: true })
        if (this.abort.signal.aborted) finish()
      })
    }
  }
}
