<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import RemoteAgentPicker from '@/components/workspace/RemoteAgentPicker.vue'
import ConversationList from '@/components/workspace/ConversationList.vue'
import FloatingResourceSearch from '@/components/app/FloatingResourceSearch.vue'
import type { SidebarItem } from '@/components/app/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { createUuid } from '@/utils/id'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import type { ComposerSubmit, ComposerReference } from '@/components/composer/types'
import PreviewModal from '@/components/library/PreviewModal.vue'
import ImagePreviewLightbox from '@/components/library/ImagePreviewLightbox.vue'
import { previewItemFromUrl, mediaItemsFromMessages } from '@/components/library/mediaSequence'
import type { UiLibraryItem } from '@/components/library/types'
import type { UiMessage } from '@/components/messages/types'
import AgentIdentityPanel from '@/components/app/AgentIdentityPanel.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import TeamPresetPicker from '@/components/workspace/TeamPresetPicker.vue'
import { TEAM_PRESETS, type TeamPreset } from '@/components/groups/teamPresets'
import type { WorkspaceMemberRole } from '@shared/workspace'
import AppIcon from '@/components/common/AppIcon.vue'
import { workspaceAvatarMembers, workspaceAvatarState, workspaceConversationItem, workspaceMessagesToUi } from '@/components/workspace/viewModels'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { apiRequest } from '@/api/client'
import { updateProfileIdentity, type ProfileIdentityInput } from '@/api/profiles'
import { encodeAgentAvatar, randomAgentIdentity } from '@shared/agentIdentity'
import type { JsonValue } from '@shared/types'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun as Run,
  WorkspaceInteraction as Interaction,
  WorkspaceSource as Source,
  WorkspaceFile,
  WorkspaceEvent,
} from '@shared/workspace'
const auth = useAuthStore(),
  theme = useThemeStore(),
  route = useRoute(),
  router = useRouter()
const agents = ref<Agent[]>([]),
  conversations = ref<Conversation[]>([]),
  messages = ref<Message[]>([]),
  sources = ref<Source[]>([])
const active = ref<Conversation>(),
  run = ref<Run | null>(null),
  interactions = ref<Interaction[]>([]),
  context = ref<Record<string, unknown> | null>(null)
const text = ref(''),
  error = ref(''),
  busy = ref(false),
  loading = ref(false),
  files = ref<WorkspaceFile[]>([]),
  mentions = ref<string[]>([]),
  older = ref(true)
const identityBusy = ref(false),
  identityError = ref(''),
  identityResetVersion = ref(0)
const searchItems = computed<SidebarItem[]>(() => [false, true].map(archived => {
  const items = conversations.value.filter(c => c.archived === archived).map(c => workspaceConversationItem(c, agents.value))
  return { id: archived ? 'archived' : 'unarchived', title: archived ? '已归档' : '未归档', children: items, emptyText: archived ? '没有已归档聊天' : '没有未归档聊天' }
}))
const composer = ref<InstanceType<typeof ComposerShell>>()
const timeline = ref<InstanceType<typeof MessageTimeline>>()
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const mediaIndex = ref<number | null>(null)
const showThinking = ref(true)
const uiMessages = computed(() => workspaceMessagesToUi(messages.value))
const media = computed(() => mediaItemsFromMessages(uiMessages.value))
const lightboxMedia = computed(() => media.value.filter(item => item.kind === 'image' || item.kind === 'video').map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, content: quoted.value.content, author: quoted.value.author } : null)
const avatarProfile = computed(() => ({ name: editingId.value || 'Agent', displayName: form.name || 'Agent', agentName: form.name || 'Agent', agentAvatar: form.avatar, isDefault: false, isRunning: true }))
function openPreview(file: {name: string; url?: string; kind?: string}) {
  let path = file.url || ''
  try { path = decodeURIComponent(new URL(path, window.location.origin).pathname) } catch { /* preserve the supplied URL */ }
  const attachment = messages.value.flatMap(message => message.attachments).find(candidate =>
    path === candidate.sourcePath || path === `/api/app/files/${candidate.id}/download`
      || path === `/api/app/files/${candidate.id}/preview`)
  // A Markdown label such as “报告” has no extension. The archived file's name
  // determines its viewer; the label is not reliable file-type metadata.
  const mime = attachment?.mimeType.toLowerCase().split(';')[0] || ''
  const textual = mime.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime)
  const item = previewItemFromUrl(attachment?.name || file.name, file.url || '', undefined, textual ? 'text' : undefined)
  const index = lightboxMedia.value.findIndex(m => m.url === (item.previewUrl || item.downloadUrl))
  if (index >= 0) mediaIndex.value = index
  else preview.value = item
}
let uploadedSources: File[] = [], uploadedReferences: WorkspaceFile[] = []
async function sendFromComposer(payload: ComposerSubmit) {
  text.value = quoted.value ? `> ${(quoted.value.author || '我')}: ${quoted.value.content.replace(/\n/g, '\n> ')}\n\n${payload.text}` : payload.text
  mentions.value = payload.mentionIds
  if (payload.files.length) {
    try {
      busy.value = true
      if (payload.files.length === uploadedSources.length && payload.files.every((f, i) => f === uploadedSources[i])) files.value = uploadedReferences
      else {
        const data = new FormData()
        for (const file of payload.files) data.append('files', file)
        files.value = (await apiRequest<{ files: WorkspaceFile[] }>('/api/app/uploads', {method: 'POST', body: data})).files
        uploadedSources = [...payload.files]
        uploadedReferences = [...files.value]
      }
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '上传失败'; return }
    finally { busy.value = false }
  }
  if (!payload.files.length) files.value = []
  if (await send()) { composer.value?.clearAfterSend(); quoted.value = null; uploadedSources = []; uploadedReferences = [] }
}
const dialog = ref<'agent' | 'group' | 'editAgent' | 'editGroup' | null>(null),
  editingId = ref(''),
  scroller = ref<HTMLElement>(),
  fileInput = ref<HTMLInputElement>(),
  dialogElement = ref<HTMLDialogElement>()
const remotePickerOpen=ref(false)
const isRemoteAgent=computed(()=>dialog.value==='editAgent' && !!agents.value.find(a=>a.id===editingId.value)?.remoteAgentId)
async function remoteAdded(agent:Agent){
  remotePickerOpen.value=false;await refresh()
  if(dialog.value==='group'||dialog.value==='editGroup'){
    if(!form.memberIds.includes(agent.id))form.memberIds.push(agent.id)
  }else{
    const conversation=conversations.value.find(c=>c.kind==='direct'&&c.memberIds[0]===agent.id)
    if(conversation)await select(conversation.id)
  }
}
const form = reactive({
  name: '',
  avatar: '',
  instructions: '',
  source: '',
  memberIds: [] as string[],
  memberRoles: {} as Record<string, WorkspaceMemberRole>,
  administratorId: '',
  mode: 'host' as 'host' | 'free',
  autoReplyIds: [] as string[],
  maxReplyRounds: 3,
})
const selectedPresetId = ref('custom')
const selectedPreset = computed(() => dialog.value === 'group' ? TEAM_PRESETS.find(p => p.id === selectedPresetId.value) : undefined)
function applyPresetRoles(preset: TeamPreset) {
  form.memberRoles = Object.fromEntries(preset.roles.flatMap((role, index) => {
    const id = form.memberIds[index]
    return id ? [[id, { name: role.name, description: role.description }]] : []
  }))
  form.administratorId = form.memberIds[Math.max(0, preset.roles.findIndex(role => role.host))] ?? ''
}
function choosePreset(preset?: TeamPreset) {
  const available = agents.value.filter(a => !a.archived)
  if (preset && available.length < preset.roles.length) return
  selectedPresetId.value = preset?.id ?? 'custom'
  Object.assign(form, { name: preset?.name ?? '', instructions: preset?.instructions ?? '', memberIds: preset ? available.slice(0, preset.roles.length).map(a => a.id) : [], memberRoles: {}, administratorId: '', mode: 'host', autoReplyIds: [], maxReplyRounds: 3 })
  if (preset) applyPresetRoles(preset)
}
function assignPresetRole(index: number, id: string) {
  if (!selectedPreset.value) return
  const next = [...form.memberIds], previous = next[index], occupied = next.indexOf(id)
  next[index] = id
  if (occupied >= 0 && occupied !== index && previous) next[occupied] = previous
  form.memberIds = next
  applyPresetRoles(selectedPreset.value)
}
const answers = reactive<Record<string, string>>({})
let cursor = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  pendingRequestId: string | undefined,
  pendingFingerprint = ''
const selected = computed(() => (typeof route.params.id === 'string' ? route.params.id : undefined))
const members = computed(() => agents.value.filter((a) => active.value?.memberIds.includes(a.id)))
const isAgentDialog = computed(() => dialog.value === 'agent' || dialog.value === 'editAgent')
const body = (v: unknown) => v as JsonValue
async function saveProfileIdentity(input: ProfileIdentityInput) {
  const profile = auth.activeProfile
  if (!profile) return
  identityBusy.value = true
  identityError.value = ''
  try {
    await updateProfileIdentity(profile, input)
    await auth.refreshProfiles()
    await auth.refreshProfileAvatars()
    identityResetVersion.value += 1
  } catch (cause) {
    identityError.value = cause instanceof Error ? cause.message : '保存 Agent 身份失败'
  } finally {
    identityBusy.value = false
  }
}
async function refresh() {
  const [a, c] = await Promise.all([
    apiRequest<{ agents: Agent[] }>('/api/app/agents'),
    apiRequest<{ conversations: Conversation[]; cursor: number }>('/api/app/conversations'),
  ])
  if (disposed) return
  agents.value = a.agents
  conversations.value = c.conversations
  if (!cursor) cursor = c.cursor
}
async function load(id = selected.value, append = false) {
  if (!id) {
    generation++
    active.value = undefined
    messages.value = []
    run.value = null
    interactions.value = []
    context.value = null
    return
  }
  const own = ++generation
  if (!append) loading.value = true
  try {
    const r = await apiRequest<{
      conversation: Conversation
      messages: Message[]
      run: Run | null
      interactions: Interaction[]
      context: Record<string, unknown> | null
      hiddenMessageIds?: string[]
    }>(`/api/app/conversations/${id}`)
    if (disposed || own !== generation) return
    const atBottom = timeline.value?.isFollowingBottom() ?? true
    active.value = r.conversation
    messages.value = append
      ? [...new Map([...messages.value, ...r.messages].map((m) => [m.id, m])).values()].sort(
          (a, b) => a.seq - b.seq,
        )
      : r.messages
    messages.value = messages.value.filter(m => m.visible !== false && !r.hiddenMessageIds?.includes(m.id))
    run.value = r.run
    interactions.value = r.interactions
    context.value = r.context
    if (!append) older.value = r.messages.length === 100
    if (!append || atBottom) {
      await nextTick()
      if (!append) timeline.value?.scrollToBottom('auto')
      await markRead()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (own === generation) loading.value = false
  }
}
async function markRead() {
  const c = active.value
  if (!c || c.readSeq >= c.lastSeq) return
  await apiRequest(`/api/app/conversations/${c.id}/read`, {
    method: 'PUT',
    body: { seq: c.lastSeq },
  })
  c.readSeq = c.lastSeq
}
async function poll() {
  try {
    const r = await apiRequest<{ events: WorkspaceEvent[]; cursor: number }>(
      `/api/app/events?after=${cursor}`,
    )
    if (disposed) return
    cursor = r.cursor
    if (r.events.length) {
      await refresh()
      if (r.events.some((e) => e.conversationId === selected.value || e.type === 'agent.changed'))
        await load(selected.value, true)
    }
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '连接中断，正在重连'
  } finally {
    if (!disposed) timer = setTimeout(() => void poll(), 1200)
  }
}
async function select(id: string) {
  error.value = ''
  files.value = []
  mentions.value = []
  text.value = ''
  quoted.value = null
  preview.value = null
  mediaIndex.value = null
  pendingRequestId = undefined
  await router.push(`/conversations/${id}`)
}
async function openDialog(kind: NonNullable<typeof dialog.value>) {
  error.value = ''
  dialog.value = kind
  editingId.value = ''
  selectedPresetId.value = 'custom'
  Object.assign(form, {
    name: '',
    avatar: kind === 'agent' ? encodeAgentAvatar(randomAgentIdentity('new-agent', 'Agent')) : '',
    instructions: '',
    source: '',
    memberIds: [],
    memberRoles: {},
    administratorId: '',
    mode: 'host',
    autoReplyIds: [],
    maxReplyRounds: 3,
  })
  try {
    if (kind === 'agent') {
      const s = await apiRequest<{ sources: Source[] }>('/api/app/agents/sources')
      sources.value = s.sources
      form.source = s.sources[0] ? JSON.stringify([s.sources[0].nodeId, s.sources[0].profile]) : ''
    }
    if (kind === 'editAgent') {
      const a = members.value[0]
      if (!a) return
      editingId.value = a.id
      Object.assign(form, a)
      if(a.remoteAgentId){
        const remote=(await apiRequest<{agents:Agent[]}>(`/api/app/nodes/${a.nodeId}/agents`)).agents.find(candidate=>candidate.id===a.remoteAgentId)
        if(remote)Object.assign(form,remote)
      }
    }
    if (kind === 'editGroup' && active.value) {
      editingId.value = active.value.id
      Object.assign(form, active.value, {
        memberIds: [...active.value.memberIds],
        autoReplyIds: [...active.value.autoReplyIds],
        memberRoles: Object.fromEntries(Object.entries(active.value.memberRoles ?? {}).map(([id, role]) => [id, { ...role }])),
      })
    }
    await nextTick()
    dialogElement.value?.showModal()
  } catch (e) {
    error.value = String(e)
    dialog.value = null
  }
}
function closeDialog() {
  dialogElement.value?.close()
  dialog.value = null
}
watch(
  () => form.memberIds.slice(),
  (ids) => {
    if (!ids.includes(form.administratorId)) form.administratorId = ids[0] ?? ''
    form.autoReplyIds = form.autoReplyIds.filter((id) => ids.includes(id))
    form.memberRoles = Object.fromEntries(Object.entries(form.memberRoles).filter(([id]) => ids.includes(id)))
  },
)
async function save() {
  if(isRemoteAgent.value)return
  busy.value = true
  error.value = ''
  try {
    const fields = { name: form.name, ...(isAgentDialog.value ? { avatar: form.avatar } : {}), instructions: form.instructions }
    if (dialog.value === 'agent') {
      const [nodeId, profile] = JSON.parse(form.source)
      const result = await apiRequest<{ agent: Agent }>('/api/app/agents', {
        method: 'POST',
        body: { ...fields, nodeId, profile },
      })
      await refresh()
      const c = conversations.value.find(
        (c) => c.kind === 'direct' && c.memberIds[0] === result.agent.id,
      )
      if (c) await select(c.id)
    } else if (dialog.value === 'editAgent')
      await apiRequest(`/api/app/agents/${editingId.value}`, { method: 'PATCH', body: fields })
    else {
      const payload = {
        ...fields,
        administratorId: form.administratorId,
        mode: form.mode,
        autoReplyIds: form.autoReplyIds,
        maxReplyRounds: form.maxReplyRounds,
        memberIds: form.memberIds,
        memberRoles: form.memberRoles,
      }
      const result = await apiRequest<{ conversation: Conversation }>(
        dialog.value === 'group'
          ? '/api/app/conversations'
          : `/api/app/conversations/${editingId.value}`,
        { method: dialog.value === 'group' ? 'POST' : 'PATCH', body: body(payload) },
      )
      await select(result.conversation.id)
    }
    closeDialog()
    await refresh()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}
async function upload(event: Event) {
  const picked = (event.target as HTMLInputElement).files
  if (!picked?.length) return
  busy.value = true
  error.value = ''
  try {
    const data = new FormData()
    for (const file of picked) data.append('files', file)
    const r = await apiRequest<{ files: WorkspaceFile[] }>('/api/app/uploads', {
      method: 'POST',
      body: data,
    })
    files.value = [...files.value, ...r.files].slice(0, 8)
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
    ;(event.target as HTMLInputElement).value = ''
  }
}
async function send() {
  const c = active.value
  if (!c || busy.value || (!text.value.trim() && !files.value.length)) return
  busy.value = true
  error.value = ''
  const fingerprint = JSON.stringify([c.id, text.value, mentions.value, files.value.map(f => f.id)])
  if (!pendingRequestId || pendingFingerprint !== fingerprint) {
    pendingRequestId = createUuid()
    pendingFingerprint = fingerprint
  }
  try {
    await apiRequest(`/api/app/conversations/${c.id}/messages`, {
      method: 'POST',
      body: {
        requestId: pendingRequestId,
        content: text.value,
        mentionIds: mentions.value,
        fileIds: files.value.map((f) => f.id),
      },
    })
    text.value = ''
    files.value = []
    mentions.value = []
    pendingRequestId = undefined
    pendingFingerprint = ''
    await load(c.id, true)
    await refresh()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : '发送失败'
  } finally {
    busy.value = false
  }
}

async function action(operation: 'pin' | 'archive', id = active.value?.id) {
  const c = conversations.value.find(c => c.id === id)
  if (!c) return
  try {
    if (operation === 'pin')
      await apiRequest(`/api/app/conversations/${c.id}`, {
        method: 'PATCH',
        body: { pinned: !c.pinned },
      })
    else
      await apiRequest(
        c.kind === 'direct'
          ? `/api/app/agents/${c.memberIds[0]}`
          : `/api/app/conversations/${c.id}`,
        { method: 'PATCH', body: { archived: !c.archived } },
      )
    await refresh()
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
async function stopMember(id: string) {
  if (!active.value) return
  try {
    await apiRequest(`/api/app/conversations/${active.value.id}/agents/${id}/stop`, { method: 'POST', body: {} })
    await load(); await refresh()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '停止失败' }
}
async function control(action: 'stop' | 'reconcile') {
  if (!run.value) return
  try {
    await apiRequest(`/api/app/runs/${run.value.id}/${action}`, { method: 'POST', body: {} })
    await load(undefined, true)
  } catch (e) {
    error.value = String(e)
  }
}
async function respond(i: Interaction, answer: string) {
  try {
    await apiRequest(`/api/app/interactions/${i.id}/respond`, { method: 'POST', body: { answer } })
    await load(undefined, true)
  } catch (e) {
    error.value = String(e)
  }
}
async function loadOlder() {
  const c = active.value
  if (!c) return
  try {
    const r = await apiRequest<{ messages: Message[] }>(
      `/api/app/conversations/${c.id}/messages?before=${messages.value[0]?.seq ?? 0}`,
    )
    messages.value = [...r.messages, ...messages.value]
    older.value = r.messages.length === 100
  } catch (e) {
    error.value = String(e)
  }
}
function rendered(m: Message) {
  return m.content.replace(
    /(!?\[[^\]]*\])\(<?([^)>]+)>?\)/g,
    (whole, label: string, path: string) => {
      const file =
        m.attachments.find((f) => f.sourcePath === path) ||
        m.attachments.find((f) => path.split('/').at(-1) === f.name)
      return file
        ? `${label}(/api/app/files/${file.id}/${label.startsWith('!') ? 'preview' : 'download'})`
        : whole
    },
  )
}

watch(selected, () => void load())
onMounted(async () => {
  void auth.refreshProfileAvatars().catch(() => undefined)
  try {
    await apiRequest('/api/app/capabilities')
    await refresh()
    await load()
    if (!disposed) void poll()
  } catch (e) {
    error.value = String(e)
  }
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  if (timer) clearTimeout(timer)
})
</script>
<template>
  <WorkspaceShell
    :user-name="auth.user?.username"
    :user-avatar="auth.user?.avatar"
    :profiles="auth.profiles"
    :active-profile="auth.activeProfile"
    :is-admin="auth.user?.role === 'admin'"
    :upstream-ready="auth.upstreamReady"
    :upstream-error="auth.upstreamError"
    :theme="theme.resolvedTheme"
    :theme-preference="theme.theme"
    :identity-busy="identityBusy"
    :identity-error="identityError"
    :identity-reset-version="identityResetVersion"
    sidebar-title="聊天"
    sidebar-context-title="聊天列表"
    @logout="auth.logout"
    @select-profile="auth.selectProfile"
    @toggle-theme="theme.toggle"
    @set-theme="theme.setTheme"
    @save-identity="saveProfileIdentity"
    @create-agent="openDialog('agent')"
    @create-group="openDialog('group')"
    @create-remote-agent="remotePickerOpen = true"
  >
    <template #sidebar
      ><ConversationList :conversations="conversations" :agents="agents" :selected="selected" @select="select" @pin="action('pin', $event)" @archive="action('archive', $event)"
    /></template>
    <template #mobile-sidebar
      ><ConversationList :conversations="conversations" :agents="agents" :selected="selected" @select="select" @pin="action('pin', $event)" @archive="action('archive', $event)"
    /></template>
    <section class="workspace-chat" aria-label="聊天">
      <MessageTimeline ref="timeline" :messages="uiMessages" :title="active?.name || 'Bot 模式'"
        :subtitle="active?.kind === 'group' ? `${members.length} 位成员` : ''"
        :loading="loading" :has-older="older && !!active" :connected="!error" :synced="!loading"
        :show-tools="showThinking" :allow-branch="false" :thinking="!!active?.activeRunId"
        :agent-avatars="Object.fromEntries(agents.map(a => [a.id, a.avatar]))"
        :agent-states="Object.fromEntries(members.map(a => [a.id, workspaceAvatarState(active, a.id)]))"
        :mention-names="members.map(a => a.name)"
        :empty-title="active ? '开始一段新对话' : '还没有聊天'"
        :empty-description="active ? '从下方输入框发送消息。' : '创建 Agent，或选择成员新建群聊。'"
        :interaction="interactions[0] ? { id: interactions[0].id, kind: interactions[0].kind, prompt: interactions[0].message, options: interactions[0].choices } : null"
        @load-older="loadOlder" @quote="quoted = $event" @preview="openPreview" @preview-file="openPreview"
        @approve="interactions[0] && respond(interactions[0], $event ? 'once' : 'deny')"
        @clarify="interactions[0] && respond(interactions[0], $event)">
        <template #header-leading><button v-if="active" class="workspace-list-back icon-button" aria-label="返回 Bot 列表" @click="router.push('/conversations')"><AppIcon name="chevron-left" /></button></template>
        <template #header-actions>
          <div v-if="active" class="header-actions">
            <button class="icon-button" :aria-label="active.pinned ? '取消置顶' : '置顶聊天'" :title="active.pinned ? '取消置顶' : '置顶聊天'" @click="action('pin')"><AppIcon :name="active.pinned ? 'pin-off' : 'pin'" /></button>
            <button class="icon-button" aria-label="聊天设置" title="聊天设置" @click="openDialog(active.kind === 'direct' ? 'editAgent' : 'editGroup')"><AppIcon name="settings" /></button>
            <button class="icon-button" :aria-label="active.archived ? '恢复聊天' : '归档聊天'" :title="active.archived ? '恢复聊天' : '归档聊天'" @click="action('archive')"><AppIcon name="archive" /></button>
          </div>
        </template>
      </MessageTimeline>
      <p v-if="error" class="error" role="alert">{{ error }}<button class="icon-button" @click="error = ''" aria-label="关闭错误"><AppIcon name="close" /></button></p>
      <ComposerShell v-if="active" :key="active.id" ref="composer" mode="group" :draft-key="`${auth.user?.id}:${active.id}`"
        :disabled="active.archived || loading || active.id !== selected" :sending="busy" stop-while-running :streaming="!!active.activeRunId"
        :tool-trace-visible="showThinking" :reference="reference" :context-used="Number(context?.usedTokens || 0)" :context-limit="Number(context?.limitTokens || 0)"
        :mention-options="active.kind === 'group' ? members.map(a => ({id:a.id,label:a.name,insertText:`@${a.name} `})) : []"
        @send="sendFromComposer" @stop="control('stop')" @tool-trace-toggle="showThinking = !showThinking" @clear-reference="quoted = null" @error="error = $event" />
    </section>
    <FloatingResourceSearch section="groups" label="搜索聊天" :items="searchItems" tabbed @select="select" />
    <PreviewModal v-if="preview" :item="preview" :items="media" @close="preview = null" />
    <ImagePreviewLightbox v-model="mediaIndex" :images="lightboxMedia" />
    <RemoteAgentPicker v-if="remotePickerOpen && !auth.isBotOnly" @close="remotePickerOpen = false" @added="remoteAdded" />
    <dialog v-if="dialog" ref="dialogElement" class="editor" @cancel.prevent="closeDialog">
      <form @submit.prevent="save">
        <header>
          <h2>
            {{ dialog === 'agent' ? '创建 Agent' : dialog === 'group' ? '创建群聊' : '编辑资料' }}
          </h2>
          <button type="button" aria-label="关闭" @click="closeDialog">×</button>
        </header>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <TeamPresetPicker v-if="dialog === 'group'" :selected="selectedPresetId" :available="agents.filter(a => !a.archived).length" @select="choosePreset" />
        <label>名称<input v-model="form.name" :readonly="isRemoteAgent" required maxlength="100" /></label>
        <p v-if="isRemoteAgent">引用的 Agent 配置由远端管理，请在远端修改名称、头像和角色规则。</p>
        <AgentIdentityPanel v-if="isAgentDialog && !isRemoteAgent" :key="`${dialog}:${editingId}`" :profile="avatarProfile" embedded :show-name="false" :show-default-model="false" :show-actions="false" @avatar-change="form.avatar = $event" />
        <div v-else-if="!isAgentDialog" class="team-avatar-settings">
          <TeamAvatar :name="form.name" :members="workspaceAvatarMembers(form.memberIds, agents, dialog === 'editGroup' ? active : undefined)" :size="64" />
          <small>群聊头像由成员头像自动组合，随成员头像更新。</small>
        </div>
        <label
          v-if="dialog === 'agent'"
          >基础 Agent<select v-model="form.source" required>
            <option
              v-for="s in sources"
              :key="`${s.nodeId}:${s.profile}`"
              :value="JSON.stringify([s.nodeId, s.profile])"
            >
              {{ s.name }} · {{ s.nodeId === 'local' ? '当前服务' : s.nodeId }}
            </option></select
          ><small v-if="!sources.length"
            >{{ auth.isBotOnly ? '暂无可用的已分配 Agent，请联系管理员分配或检查连接。' : '没有可用的基础 Agent，请检查 Web 的 Hermes 连接。' }}</small
          ></label
        ><label
          >{{ isAgentDialog ? '角色提示词与规则' : '群规则'
          }}<textarea
            v-model="form.instructions"
            :readonly="isRemoteAgent"
            rows="6"
            maxlength="24000"
            :placeholder="
              isAgentDialog
                ? '例如：你是代码审查员。重点检查正确性、边界情况和测试证据。'
                : '所有成员共同遵守的协作规则'
            "
          />
        </label>
        <button v-if="!isAgentDialog && !auth.isBotOnly" type="button" @click="remotePickerOpen = true">添加远程 Agent</button>
        <fieldset v-if="selectedPreset" class="preset-role-mapping">
          <legend>角色分配</legend>
          <label v-for="(role, index) in selectedPreset.roles" :key="role.name">
            {{ role.name }}{{ role.host ? ' · 管理员' : '' }}
            <select :value="form.memberIds[index]" :aria-label="`${role.name}对应的 Agent`" @change="assignPresetRole(index, ($event.target as HTMLSelectElement).value)">
              <option v-for="a in agents.filter(a => !a.archived)" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
            <small>{{ role.description }}</small>
          </label>
          <small>角色分工仅在本群生效，聊天中保留 Agent 的名称和头像。</small>
        </fieldset>
        <fieldset v-else-if="!isAgentDialog">
          <legend>选择成员</legend>
          <label
            v-for="a in agents.filter((a) =>
              !a.archived || (dialog === 'editGroup' && active?.memberIds.includes(a.id)),
            )"
            :key="a.id"
            ><input
              v-model="form.memberIds"
              type="checkbox"
              :value="a.id"
              :disabled="busy || (dialog === 'editGroup' && (a.id === active?.administratorId || a.id === form.administratorId)) || (!form.memberIds.includes(a.id) && form.memberIds.length >= 8)"
            />{{ a.name }}</label
          ><small v-if="dialog === 'group' && agents.filter((a) => !a.archived).length < 2"
            >至少需要两个 Agent 才能创建群聊。</small
          >
          <small v-if="dialog === 'editGroup'">可增减成员，最多 8 位。当前管理员不能移除；如需移除，请先更换管理员并保存。</small>
          <button v-for="a in agents.filter(a => active?.activeAgentStates?.[a.id])" :key="`stop:${a.id}`" type="button" @click="stopMember(a.id)">停止 {{ a.name }}</button>
        </fieldset>
        <fieldset v-if="dialog === 'editGroup' && Object.keys(form.memberRoles).length">
          <legend>角色分工</legend>
          <p v-for="(role, id) in form.memberRoles" :key="id">{{ agents.find(a => a.id === id)?.name }} · {{ role.name }}<br /><small>{{ role.description }}</small></p>
        </fieldset>
        <template v-if="!isAgentDialog"
          ><label
            >管理员<select v-model="form.administratorId" required>
              <option
                v-for="a in agents.filter((a) => form.memberIds.includes(a.id))"
                :key="a.id"
                :value="a.id"
              >
                {{ a.name }}
              </option>
            </select></label
          ><label
            >协作方式<select v-model="form.mode">
              <option value="host">管理员协调</option>
              <option value="free">自由协作</option>
            </select></label
          >
          <fieldset v-if="form.mode === 'free'">
            <legend>未 @ 时自动回复</legend>
            <label v-for="a in agents.filter((a) => form.memberIds.includes(a.id))" :key="a.id"
              ><input v-model="form.autoReplyIds" type="checkbox" :value="a.id" />{{
                a.name
              }}</label
            >
          </fieldset>
          <label
            ><input type="checkbox" :checked="form.maxReplyRounds === -1" @change="form.maxReplyRounds = ($event.target as HTMLInputElement).checked ? -1 : 3" />不限制自动协作轮数</label>
          <label v-if="form.maxReplyRounds !== -1">自动协作轮数<input
              v-model.number="form.maxReplyRounds"
              type="number"
              min="1"
              max="100"
              required /></label
        ></template>
        <footer>
          <button class="quiet-button" type="button" @click="closeDialog">取消</button
          ><button v-if="!isRemoteAgent" class="solid-button" :disabled="busy || (!isAgentDialog && (form.memberIds.length < (dialog === 'group' ? 2 : 1) || form.memberIds.length > 8))">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </dialog>
  </WorkspaceShell>
</template>
<style scoped>
.workspace-chat{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}.new-actions{display:grid;gap:2px}.new-actions button{display:flex;align-items:center;min-height:40px;padding:0 11px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);text-align:left;font-size:12px;font-weight:610;cursor:pointer}.new-actions button:hover{background:var(--surface-hover)}.header-actions{display:flex;gap:4px;margin-left:auto}.error{display:flex;align-items:center;justify-content:space-between;margin:0 18px 9px;color:var(--danger);font-size:12px}.team-avatar-settings{display:grid;gap:12px}.team-avatar-options{display:flex;gap:10px}.team-avatar-options button{padding:5px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft);cursor:pointer}.team-avatar-options button[aria-pressed=true]{border-color:var(--accent)}.nodes-overlay{position:fixed;inset:0;z-index:1000;background:var(--scrim);display:grid;place-items:center}.nodes-overlay>div{padding:20px;max-height:85vh;overflow:auto;width:min(520px,90vw);background:var(--surface-raised);border:1px solid var(--line);border-radius:16px}
.editor {
  border: 1px solid var(--line);
  border-radius: 18px;
  width: min(520px, calc(100vw - 48px));
  max-height: 85vh;
  overflow: auto;
  background: var(--surface);
  color: var(--text-primary);
  padding: 25px;
}
.editor::backdrop {
  background: #0006;
}
.editor header,
.editor footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor h2 {
  font-size: 20px;
}
.editor label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 15px 0;
  font-size: 13px;
}
.editor input:not([type='checkbox']),
.editor textarea,
.editor select,
.interaction input {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-soft);
  color: inherit;
  font: inherit;
}
.editor fieldset {
  border: 1px solid var(--line);
  border-radius: 10px;
}
.editor fieldset label {
  flex-direction: row;
  align-items: center;
}
.editor footer {
  justify-content: flex-end;
  margin-top: 25px;
}
.status {
  margin-top: 8px;
}
.workspace-list-back{display:none}@media(max-width:900px){.workspace-list-back{display:grid}}
</style>
