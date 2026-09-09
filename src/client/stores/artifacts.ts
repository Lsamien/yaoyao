import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ArtifactKind, ChatMessage, ConversationArtifact, FileLibraryItem, SessionSummary } from '@shared/types'
import { getMessages, getSessions } from '@/api/sessions'
import { filePreviewUrl, getFiles } from '@/api/files'
import { ARTIFACT_EXTRACTOR_VERSION, extractArtifacts } from '@/utils/artifacts'
import { ScopedCache } from '@/utils/cache'
import { mergeChatMessages } from '@/utils/messageReducer'
import { useAuthStore } from './auth'

interface CachedArtifacts {
  extractorVersion: number
  fingerprint: string
  artifacts: ConversationArtifact[]
}

const cache = new ScopedCache<CachedArtifacts>('artifacts-v1')

function fingerprint(session: SessionSummary): string {
  return `${session.messageCount}:${session.toolCallCount}:${session.updatedAt}`
}

async function parallelMap<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      result[index] = await worker(items[index])
    }
  }))
  return result
}

export const useArtifactsStore = defineStore('artifacts', () => {
  const auth = useAuthStore()
  const artifacts = ref<ConversationArtifact[]>([])
  const isLoading = ref(false)
  const error = ref<string>()
  const kindFilter = ref<ArtifactKind | 'all'>('all')
  const searchQuery = ref('')
  const profile = ref<string>()
  const loadedSessionCount = ref(0)
  const totalSessionCount = ref(0)
  const failedSessionCount = ref(0)

  const filteredArtifacts = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    return artifacts.value.filter(artifact => {
      if (kindFilter.value !== 'all' && artifact.kind !== kindFilter.value) return false
      return !query || [artifact.label, artifact.value, artifact.sessionTitle, artifact.profile]
        .some(value => value?.toLowerCase().includes(query))
    })
  })

  function scope(selectedProfile?: string): string {
    return `${auth.user?.id ?? 'anonymous'}:${selectedProfile ?? 'all'}`
  }

  async function allSessions(selectedProfile?: string): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = []
    const visited = new Set<string>()
    let cursor: string | undefined
    do {
      const key = cursor ?? '<first-page>'
      if (visited.has(key)) break
      visited.add(key)
      const page = await getSessions(selectedProfile, cursor, 100)
      sessions.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor && sessions.length < 2_000)
    return sessions
  }

  async function allMessages(session: SessionSummary): Promise<ChatMessage[]> {
    let messages: ChatMessage[] = []
    let offset = 0
    const visited = new Set<number>()
    while (!visited.has(offset) && visited.size < 10_000) {
      visited.add(offset)
      const page = await getMessages(session.id, offset, 500, session.profile)
      messages = mergeChatMessages(messages, page.messages, 'prepend')
      offset += page.returned
      if (!page.hasMore || page.returned === 0) break
    }
    return messages
  }

  async function allFiles(selectedProfile?: string): Promise<FileLibraryItem[]> {
    const files: FileLibraryItem[] = []
    const profiles = selectedProfile
      ? [selectedProfile]
      : auth.profiles.map(item => item.name)
    for (const profileName of profiles.length ? profiles : [undefined]) {
      const visited = new Set<string>()
      let cursor: string | undefined
      do {
        const key = cursor ?? '<first-page>'
        if (visited.has(key)) break
        visited.add(key)
        const page = await getFiles({ profile: profileName, cursor, limit: 100 })
        files.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor && files.length < 5_000)
    }
    return files
  }

  function resolvedPath(value: string): string {
    if (!value.startsWith('file://')) return value
    try { return decodeURIComponent(new URL(value).pathname) } catch { return value }
  }

  function enrichPreview(items: ConversationArtifact[], files: FileLibraryItem[]): ConversationArtifact[] {
    const byPath = new Map<string, FileLibraryItem>()
    for (const file of files) {
      const profiles = new Set(file.origins.map(origin => origin.profile).filter(Boolean))
      if (!profiles.size) profiles.add('')
      for (const profileName of profiles) byPath.set(`${profileName}:${resolvedPath(file.path)}`, file)
      for (const origin of file.origins) {
        const profileName = origin.profile ?? ''
        if (origin.originalPath) byPath.set(`${profileName}:${resolvedPath(origin.originalPath)}`, file)
        if (origin.referencePath) byPath.set(`${profileName}:${resolvedPath(origin.referencePath)}`, file)
      }
    }
    return items.map(artifact => {
      if (artifact.kind === 'link') return artifact
      const path = resolvedPath(artifact.value)
      const file = byPath.get(`${artifact.profile ?? ''}:${path}`) ?? byPath.get(`:${path}`)
      if (!file) return artifact
      const kind = file.mimeType.startsWith('image/') ? 'image' : file.mimeType === 'application/pdf' ? 'pdf' : 'file'
      return {
        ...artifact,
        mimeType: file.mimeType,
        attachment: {
          ...artifact.attachment,
          id: `file-library:${file.id}`,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          path: file.path,
          url: filePreviewUrl(file.id, file.origins.find(origin => origin.profile)?.profile),
          kind,
        },
      }
    })
  }

  async function load(force = false): Promise<void> {
    if (isLoading.value) return
    isLoading.value = true
    artifacts.value = []
    error.value = undefined
    loadedSessionCount.value = 0
    failedSessionCount.value = 0
    const selectedProfile = profile.value || undefined
    try {
      const [sessions, files] = await Promise.all([
        allSessions(selectedProfile),
        allFiles(selectedProfile).catch(() => [] as FileLibraryItem[]),
      ])
      totalSessionCount.value = sessions.length
      const batches = await parallelMap(sessions, 4, async session => {
        const key = session.id
        const cached = force ? undefined : await cache.get(scope(selectedProfile), key)
        if (cached?.extractorVersion === ARTIFACT_EXTRACTOR_VERSION && cached.fingerprint === fingerprint(session)) {
          loadedSessionCount.value += 1
          return cached.artifacts
        }
        try {
          const extracted = extractArtifacts(session, await allMessages(session))
          await cache.set(scope(selectedProfile), key, {
            extractorVersion: ARTIFACT_EXTRACTOR_VERSION,
            fingerprint: fingerprint(session),
            artifacts: extracted,
          })
          loadedSessionCount.value += 1
          return extracted
        } catch {
          failedSessionCount.value += 1
          loadedSessionCount.value += 1
          return cached?.extractorVersion === ARTIFACT_EXTRACTOR_VERSION ? cached.artifacts : []
        }
      })
      artifacts.value = enrichPreview(batches.flat(), files).sort((a, b) => b.timestamp - a.timestamp)
      if (failedSessionCount.value) error.value = `${failedSessionCount.value} 个会话暂时无法读取，已保留其可用缓存`
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '产物库加载失败'
      throw cause
    } finally { isLoading.value = false }
  }

  const refresh = () => load(true)
  function clear(): void {
    artifacts.value = []
    loadedSessionCount.value = 0
    totalSessionCount.value = 0
    failedSessionCount.value = 0
    error.value = undefined
  }

  return {
    artifacts, filteredArtifacts, isLoading, error, kindFilter, searchQuery, profile,
    loadedSessionCount, totalSessionCount, failedSessionCount, load, refresh, clear,
  }
})
