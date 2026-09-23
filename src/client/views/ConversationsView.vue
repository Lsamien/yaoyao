<script setup lang="ts">
import { WORKSPACE_PATCH_CAPABILITY } from '@shared/workspaceMessagePatch'
import { setApiCsrfToken } from '@/api/client'
import { publishServerIdentity } from '@/api/serverIdentity'
import type { ServerIdentity } from '@shared/serverIdentity'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate, onBeforeRouteLeave } from 'vue-router'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import ConversationList from '@/components/workspace/ConversationList.vue'
import BotProfileDialog from '@/components/workspace/BotProfileDialog.vue'
import WorkspaceBotPanel from '@/components/workspace/WorkspaceBotPanel.vue'
import WorkspaceKnowledgePanel from '@/components/workspace/WorkspaceKnowledgePanel.vue'
import type { WorkspaceProject } from '@shared/workspaceKnowledge'
import LocalVmWorkspace from '@/components/workspace/LocalVmWorkspace.vue'
import ComputerPanel from '@/components/workspace/ComputerPanel.vue'
import TaskPlan from '@/components/workspace/TaskPlan.vue'
import type { AgentAssignment } from '@shared/agentTasks'
import type { WorkspaceSendReceipt, WorkspaceTask } from '@shared/workspace'
import { workspaceHasUnread } from '@shared/workspace'
import type { WorkspaceLifecycleAction, WorkspaceLifecyclePreview } from '@shared/workspaceLifecycle'
import FloatingResourceSearch from '@/components/app/FloatingResourceSearch.vue'
import type { SidebarItem } from '@/components/app/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { createUuid } from '@/utils/id'
import MessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import { WorkspaceTranscriptStore, transcriptKey, type WorkspaceDetail, type WorkspaceSnapshot } from '@/components/workspace/transcriptStore'
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
import { workspaceAgentActivity, workspaceAvatarMembers, workspaceAvatarState, workspaceConversationItem, workspaceMessagesToUi } from '@/components/workspace/viewModels'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { apiRequest, ApiError } from '@/api/client'
import { updateProfileIdentity, type ProfileIdentityInput } from '@/api/profiles'
import { encodeAgentAvatar, randomAgentIdentity } from '@shared/agentIdentity'
import type { JsonValue } from '@shared/types'
import {
  type WorkspaceAgent as Agent,
  type WorkspaceConversation as Conversation,
  type WorkspaceMessage as Message,
  type WorkspaceRun as Run,
  type WorkspaceInteraction as Interaction,
  type WorkspaceSource as Source,
  type WorkspaceFile,
  type WorkspaceEvent,
  workspaceHasUnfinishedOutput,
} from '@shared/workspace'
const auth = useAuthStore(),
  theme = useThemeStore(),
  route = useRoute(),
  router = useRouter()
const agents = ref<Agent[]>([]),
  conversations = ref<Conversation[]>([]),
  messages = shallowRef<Message[]>([]),
  sources = ref<Source[]>([])
const active = ref<Conversation>(),
  run = ref<Run | null>(null),
  interactions = ref<Interaction[]>([]),
  context = ref<Record<string, unknown> | null>(null)
const thinking = computed(() =>
  (!!run.value && ['queued', 'running', 'waiting', 'uncertain'].includes(run.value.status))
  || workspaceHasUnfinishedOutput(messages.value))
const activeTask = ref<WorkspaceTask | null>(null), tasks = ref<WorkspaceTask[]>([]), assignments = ref<AgentAssignment[]>([])
const deliveryMode = ref(false)
const knowledgePanel = ref<InstanceType<typeof WorkspaceKnowledgePanel>>()
const knowledgeRevision = ref(0)
const knowledgeEnabled = ref(false), projects = ref<WorkspaceProject[]>([]), directProjectId = ref(''), requestedRounds = ref<number | undefined>(), coordinatorId = ref('')
const coordinators = computed(() => members.value.filter(a => !a.temporaryGoalId && !a.archived && !a.remoteAgentId))
const canRequestGoal = computed(() => active.value?.kind === 'group' && !active.value.archived && !activeTask.value?.goal
  && (active.value.collaborationMode === 'discussion' ? coordinators.value.length > 0 : members.value.some(a => a.id === active.value?.administratorId && !a.temporaryGoalId && !a.archived && !a.remoteAgentId)))
const taskFiles = new Map<string,File[]>()
const taskQuotes = new Map<string,UiMessage | null>()
const composerKey = computed(() => `${auth.user?.id}:${active.value?.id}${activeTask.value ? `:${activeTask.value.id}` : ''}`)
watch(composerKey, () => { deliveryMode.value = false; directProjectId.value = ''; requestedRounds.value = undefined; coordinatorId.value = '' })
async function knowledgeChanged() { await refresh(); projects.value = (await apiRequest<{ projects: WorkspaceProject[] }>('/api/app/workspace/projects')).projects }
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
const respondingInteractionId = ref(''), interactionError = ref('')
watch(() => `${route.params.id}:${interactions.value[0]?.id}`, () => { interactionError.value = '' })
const agentActivity = computed(() => workspaceAgentActivity(conversations.value))
const searchItems = computed<SidebarItem[]>(() => [false, true].map(archived => {
  const items = conversations.value.filter(c => c.archived === archived).map(c => workspaceConversationItem(c, agents.value, agentActivity.value))
  return { id: archived ? 'archived' : 'unarchived', title: archived ? '已归档' : '未归档', children: items, emptyText: archived ? '没有已归档聊天' : '没有未归档聊天' }
}))
const archivedIds = computed(() => new Set(conversations.value.filter(c => c.archived).map(c => c.id)))
const lifecycleId = ref(''), searchActionError = ref(''), lifecycleError = ref(''), lifecycleAction = ref<WorkspaceLifecycleAction>()
const composer = ref<InstanceType<typeof ComposerShell>>()
const timeline = ref<InstanceType<typeof MessageTimeline>>()
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const mediaIndex = ref<number | null>(null)
const showThinking = ref(false)
const transcriptStore = new WorkspaceTranscriptStore()
const renderedMessages = new WeakMap<Message, UiMessage>()
const uiMessages = computed(() => messages.value.filter(m => m.visible !== false).map(message => {
  let rendered = renderedMessages.get(message)
  if (!rendered) { rendered = workspaceMessagesToUi([message])[0]!; renderedMessages.set(message, rendered) }
  return rendered
}))
const loadingOlder = ref(false)
const media = computed(() => mediaItemsFromMessages(uiMessages.value))
const lightboxMedia = computed(() => media.value.filter(item => item.kind === 'image' || item.kind === 'video').map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, content: quoted.value.content, author: quoted.value.author } : null)
const avatarProfile = computed(() => ({ name: editingId.value || '机器人', displayName: form.name || '机器人', agentName: form.name || '机器人', agentAvatar: form.avatar, isDefault: false, isRunning: true }))
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
  const sourceComposer = composer.value, token = sourceComposer?.submissionToken()
  const scope = composerKey.value, ownerEpoch = accountEpoch
  text.value = quoted.value ? `> ${(quoted.value.author || '我')}: ${quoted.value.content.replace(/\n/g, '\n> ')}\n\n${payload.text}` : payload.text
  mentions.value = payload.mentionIds
  if (payload.files.length) {
    try {
      busy.value = true
      if (payload.files.length === uploadedSources.length && payload.files.every((f, i) => f === uploadedSources[i])) files.value = uploadedReferences
      else {
        const data = new FormData()
        for (const file of payload.files) data.append('files', file)
        const uploaded = await apiRequest<{ files: WorkspaceFile[] }>('/api/app/uploads', {method: 'POST', body: data})
        if (scope !== composerKey.value || ownerEpoch !== accountEpoch) return
        files.value = uploaded.files
        uploadedSources = [...payload.files]
        uploadedReferences = [...files.value]
      }
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '上传失败'; return }
    finally { if (ownerEpoch === accountEpoch) busy.value = false }
  }
  if (scope !== composerKey.value || ownerEpoch !== accountEpoch) return
  if (!payload.files.length) files.value = []
  if (await send()) {
    const cleared = sourceComposer?.clearAfterSend(token)
    if (cleared && composer.value === sourceComposer && composerKey.value === scope && accountEpoch === ownerEpoch) {
      quoted.value = null; uploadedSources = []; uploadedReferences = []
    }
  }
}
const dialog = ref<'agent' | 'group' | 'editAgent' | 'editGroup' | null>(null),
  editingId = ref(''),
  editingConversationId = ref(''),
  scroller = ref<HTMLElement>(),
  fileInput = ref<HTMLInputElement>(),
  dialogElement = ref<HTMLDialogElement>()
const editingConversation = computed(() => conversations.value.find(c => c.id === editingConversationId.value) ?? (active.value?.id === editingConversationId.value ? active.value : undefined))
const editingBot = computed(() => agents.value.find(agent => agent.id === editingId.value))
const isRemoteAgent=computed(()=>dialog.value==='editAgent' && !!agents.value.find(a=>a.id===editingId.value)?.remoteAgentId)
const form = reactive({
  name: '',
  avatar: '',
  instructions: '',
  description: '',
  job: '',
  antiJobs: [] as string[],
  voice: '' as ''|'concise'|'casual'|'rigorous'|'custom',
  voiceCustom: '',
  actBias: '' as ''|'ask_first'|'ask_key_then_act'|'act_now',
  execution: 'profile' as 'profile'|'computer',
  canManageTeam: true,
  canCollaborate: true,
  memoryEnabled: true,
  approvalPolicy: 'ask' as 'ask'|'allow'|'deny',
  source: '',
  memberIds: [] as string[],
  memberRoles: {} as Record<string, WorkspaceMemberRole>,
  administratorId: '',
  mode: 'discussion' as 'discussion' | 'host' | 'free',
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
  const available = agents.value.filter(a => !a.archived && !a.temporaryGoalId)
  if (preset && available.length < preset.roles.length) return
  selectedPresetId.value = preset?.id ?? 'custom'
  Object.assign(form, { name: preset?.name ?? '', instructions: preset?.instructions ?? '', job: '', antiJobs: [], voice: '', voiceCustom: '', actBias: '', memberIds: preset ? available.slice(0, preset.roles.length).map(a => a.id) : [], memberRoles: {}, administratorId: '', mode: knowledgeEnabled.value ? 'discussion' : 'host', autoReplyIds: [], maxReplyRounds: 3 })
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
const selectedTask = computed(() => typeof route.query.taskId === 'string' ? route.query.taskId : '')
const shell=ref<InstanceType<typeof WorkspaceShell>>(),vmWorkspace=ref<InstanceType<typeof LocalVmWorkspace>>(),desktopViewer=ref<InstanceType<typeof ComputerPanel>>()
const computerOpen=ref(false),dockView=ref<'computer'|'inspector'>(),twoDesktops=ref(false),desktopAgent=ref<Agent>(),desktopBackend=ref<'desktop'|'cloud'|'vm'>(),desktopHost=ref('')
async function resolveDeviceHost(){try{return (await window.yaoyaoDesktop?.deviceHost?.())?.deviceHost??null}catch{return null}}
const creatingTask=ref(false)
const CREATE_TASK_VALUE='__create_task__'
function toggleDock(view:'computer'|'inspector'){dockView.value=dockView.value===view?undefined:view}
async function openComputer(agent:Agent,backend?:'desktop'|'cloud'|'vm',host?:string){
  if(window.yaoyaoDesktop?.openComputer){try{await window.yaoyaoDesktop.openComputer(agent.id,{backend,host})}catch(cause){error.value=cause instanceof Error?cause.message:'无法打开电脑窗口'}return}
  desktopAgent.value=agent;desktopBackend.value=backend;desktopHost.value=host??'';computerOpen.value=true
}
async function leaveComputer(){
  if(twoDesktops.value&&vmWorkspace.value&&!await vmWorkspace.value.close())return false
  if(computerOpen.value&&desktopViewer.value){try{await desktopViewer.value.releaseControl();computerOpen.value=false}catch{return false}}
  return true
}
onBeforeRouteUpdate(leaveComputer);onBeforeRouteLeave(leaveComputer)
const computerCandidates=computed(()=>agents.value.filter(agent=>!agent.archived&&(active.value?.memberIds.includes(agent.id)||(!!agent.temporaryGoalId&&agent.temporaryGoalId===activeTask.value?.goal?.id))))
const members = computed(() => agents.value.filter((a) => active.value?.memberIds.includes(a.id)))
const activeHeaderAgent = computed(() => active.value?.kind === 'direct' ? agents.value.find(agent => agent.id === active.value?.memberIds[0]) : undefined)
const activeHeaderTitle = computed(() => activeHeaderAgent.value?.name || active.value?.name || 'Bot 模式')
const activeHeaderAvatarName = computed(() => active.value ? activeHeaderAgent.value?.name || active.value.name : '')
const activeHeaderAvatar = computed(() => activeHeaderAgent.value?.avatar || active.value?.avatar || '')
const activeHeaderAvatarMembers = computed(() => active.value?.kind === 'group' ? workspaceAvatarMembers(active.value.memberIds, agents.value, active.value) : [])
const thinkingIdentity = computed(() => {
  const streamingAgentId = [...uiMessages.value].reverse().find(message => message.role === 'assistant' && message.status === 'streaming')?.profile
  const agentId = activeHeaderAgent.value?.id || run.value?.activeAgentId || streamingAgentId
    || active.value?.activeAgentId || Object.entries(active.value?.activeAgentStates ?? {}).find(([, state]) => state === 'running')?.[0]
    || active.value?.memberIds[0]
  const agent = agents.value.find(agent => agent.id === agentId)
  return { name: agent?.name || active.value?.name || '机器人', avatar: agent?.avatar || (active.value?.kind === 'direct' ? active.value.avatar : '') || '' }
})
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
    identityError.value = cause instanceof Error ? cause.message : '保存机器人身份失败'
  } finally {
    identityBusy.value = false
  }
}
async function refresh() {
  const startedAtCursor = transcriptStore.cursor
  const owner = auth.user?.id
  const [a, c] = await Promise.all([
    apiRequest<{ agents: Agent[] }>('/api/app/agents'),
    apiRequest<{ conversations: Conversation[]; cursor: number }>('/api/app/conversations'),
  ])
  if (disposed || auth.user?.id !== owner || transcriptStore.cursor !== startedAtCursor) return
  agents.value = a.agents
  const localConversations = new Map(conversations.value.map(row => [row.id, row]))
  transcriptStore.conversations = c.conversations.map(conversation => {
    const local = localConversations.get(conversation.id)
    return local && local.unreadVersion === conversation.unreadVersion && [...pendingReads].some(key => key.startsWith(`${conversation.id}:`))
      ? { ...conversation, unread: local.unread, unreadCount: local.unreadCount } : conversation
  })
  transcriptStore.agents = agents.value
  conversations.value = transcriptStore.conversations
  if (!cursor) { cursor = c.cursor; transcriptStore.cursor = c.cursor }
}
async function load(id = selected.value, append = false, signal?: AbortSignal) {
  if (!id) {
    generation++
    active.value = undefined
    messages.value = []
    run.value = null
    interactions.value = []
    context.value = null
    activeTask.value = null;tasks.value = [];assignments.value = []
    return
  }
  const own = ++generation
  const owner = auth.user?.id, epoch = accountEpoch
  const current = () => !disposed && own === generation && !signal?.aborted
    && auth.user?.id === owner && accountEpoch === epoch
  const previousComposer = composerKey.value
  const previousFiles = composer.value?.filesSnapshot() ?? []
  const previousQuote = quoted.value
  const requestedTask = selectedTask.value || (active.value?.id === id ? activeTask.value?.id : undefined)
  const cached = !append ? transcriptStore.get(id, requestedTask) : undefined
  const readToken = transcriptStore.beginRead()
  if (!append) loading.value = !cached
  if (active.value?.id !== id) {
    active.value = conversations.value.find(c => c.id === id)
    messages.value = cached?.messages ?? [];run.value = null;interactions.value = [];context.value = null
    activeTask.value = null;tasks.value = [];assignments.value = [];quoted.value = null;older.value = false
  }
  try {
    const incoming = cached ?? await apiRequest<WorkspaceDetail>(`/api/app/conversations/${id}?limit=50${requestedTask ? `&taskId=${encodeURIComponent(requestedTask)}` : ''}`, { signal })
    if (!current()) return
    const r = cached ?? transcriptStore.finishRead(readToken, incoming)
    if (cached && transcriptStore.staleDetails.has(transcriptKey(id, cached.task?.id))) {
      queueMicrotask(() => { if (current() && active.value?.id === id) void load(id, true, signal) })
    }
    const atBottom = timeline.value?.isFollowingBottom() ?? true
    active.value = r.conversation
    if (r.task) transcriptStore.selectedTasks.set(id, r.task.id)
    activeTask.value = r.task ?? null;tasks.value = r.tasks ?? [];assignments.value = r.assignments ?? []
    messages.value = r.messages
    run.value = r.run
    interactions.value = r.interactions
    context.value = r.context
    if (previousComposer !== composerKey.value) {
      taskFiles.set(previousComposer,previousFiles)
      taskQuotes.set(previousComposer,previousQuote)
      if (activeTask.value && !requestedTask) {
        const legacy = `hermes-yaoyao:composer:group:${auth.user?.id}:${active.value.id}`
        const current = `hermes-yaoyao:composer:group:${composerKey.value}`
        try {
          const draft = localStorage.getItem(legacy)
          if (draft && !localStorage.getItem(current)) { localStorage.setItem(current,draft);localStorage.removeItem(legacy) }
        } catch { /* Leave the original draft intact when browser storage is unavailable. */ }
      }
      await nextTick()
      if (!current()) return
      const saved = taskFiles.get(composerKey.value)
      if (saved?.length) await composer.value?.attachFiles(saved)
      if (!current()) return
      quoted.value = taskQuotes.get(composerKey.value) ?? null
    }
    if (!append) older.value = r.hasOlder ?? r.messages.length === 50
    if (!append || atBottom) {
      await nextTick()
      if (!current()) return
      if (!append) timeline.value?.scrollToBottom('auto')
      void markRead().catch(e => { if (current()) error.value = e instanceof Error ? e.message : '同步已读失败' })
    }
  } catch (e) {
    if (current() && requestedTask && e instanceof ApiError && e.status === 404) {
      try {
        const available = await apiRequest<{tasks:WorkspaceTask[]}>(`/api/app/conversations/${id}/tasks`, { signal })
        const fallback = available.tasks[0]
        if (current() && fallback && fallback.id !== requestedTask) {
          await router.replace({query:{...route.query,taskId:fallback.id}})
          return
        }
      } catch { /* A deleted conversation still reports its original error. */ }
    }
    if (current()) error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    transcriptStore.cancelRead(readToken)
    if (own === generation) loading.value = false
  }
}
const pendingReads = new Set<string>()
async function markRead() {
  const c = active.value
  const read = activeTask.value ?? c
  if (!c || !read || (!workspaceHasUnread(read) && read.readSeq >= read.lastSeq)) return
  const task = activeTask.value, seq = read.lastSeq, version = read.unreadVersion
  const key = `${c.id}:${task?.id ?? ''}:${version}:${seq}`
  if (pendingReads.has(key)) return
  pendingReads.add(key)
  const previous = { unread: read.unread, unreadCount: read.unreadCount, readSeq: read.readSeq }
  const previousConversation = { unread: c.unread, unreadCount: c.unreadCount }
  read.unread = false;read.unreadCount = 0;read.readSeq = seq
  if (task) tasks.value = tasks.value.map(t => t.id === task.id ? { ...t, unread: false, unreadCount: 0, readSeq: seq } : t)
  const publishUnread = () => {
    c.unread = task ? tasks.value.some(workspaceHasUnread) : read.unread
    c.unreadCount = c.unread ? 1 : 0
    const row = conversations.value.find(row => row.id === c.id)
    if (row && row.unreadVersion === c.unreadVersion) { row.unread = c.unread;row.unreadCount = c.unreadCount }
  }
  publishUnread()
  try {
    const result = await apiRequest<{conversation: Conversation}>(`/api/app/conversations/${c.id}/read${task ? `?taskId=${task.id}` : ''}`, {
      method: 'PUT', body: { seq, ...(version === undefined ? {} : {unreadVersion:version}) },
    })
    const row = conversations.value.find(row => row.id === c.id)
    if (row && result.conversation && (row.unreadVersion ?? 0) <= (result.conversation.unreadVersion ?? 0)) {
      row.unread = result.conversation.unread;row.unreadCount = result.conversation.unreadCount;row.unreadVersion = result.conversation.unreadVersion
    }
  } catch (error) {
    const row = conversations.value.find(row => row.id === c.id)
    if (row && row.unreadVersion === c.unreadVersion) Object.assign(row, previousConversation)
    if (active.value?.id === c.id && activeTask.value?.id === task?.id && (activeTask.value ?? active.value)?.unreadVersion === version) {
      Object.assign(activeTask.value ?? active.value!, previous)
      if (task) tasks.value = tasks.value.map(t => t.id === task.id ? { ...t, ...previous, unreadCount: previous.unreadCount ?? 0 } : t)
      publishUnread()
    }
    throw error
  } finally { pendingReads.delete(key) }
}
async function selectTask(event:Event){
  const select=event.currentTarget as HTMLSelectElement,value=select.value
  if(value!==CREATE_TASK_VALUE){await router.push({query:{...route.query,taskId:value}});return}
  select.value=activeTask.value?.id??''
  if(!active.value||active.value.kind!=='group'||creatingTask.value)return
  const conversationId=active.value.id
  creatingTask.value=true;error.value=''
  try{
    const result=await apiRequest<{task:WorkspaceTask}>(`/api/app/conversations/${conversationId}/tasks`,{method:'POST',body:{}})
    if(active.value?.id!==conversationId)return
    tasks.value=[result.task,...tasks.value.filter(task=>task.id!==result.task.id)]
    await router.push({query:{...route.query,taskId:result.task.id}})
  }catch(cause){error.value=cause instanceof Error?cause.message:'新建话题失败'}finally{creatingTask.value=false}
}
async function stopTask() {
  if (!active.value || !activeTask.value) return
  try {
    await apiRequest(`/api/app/conversations/${active.value.id}/tasks/${activeTask.value.id}/stop`,{method:'POST',body:{}})
    await load(undefined,true)
  } catch(cause) {error.value=cause instanceof Error?cause.message:'停止任务失败'}
}
async function resumeTask() {
  if (!active.value || !activeTask.value) return
  try {
    await apiRequest(`/api/app/conversations/${active.value.id}/tasks/${activeTask.value.id}/resume`,{method:'POST',body:{requestId:createUuid()}})
    await load(undefined,true)
  } catch(cause) {error.value=cause instanceof Error?cause.message:'恢复任务失败'}
}
async function saveGoalCriteria(goalId: string, expectedRevision: number, acceptanceCriteria: string[]) {
  const conversationId = active.value?.id
  if (!conversationId || activeTask.value?.id !== goalId) throw new Error('话题已切换，请重新打开目标')
  const result = await apiRequest<{goal: NonNullable<WorkspaceTask['goal']>}>(`/api/app/conversations/${conversationId}/tasks/${goalId}/plan`, {
    method: 'PATCH', body: { requestId: createUuid(), expectedRevision, acceptanceCriteria },
  })
  if (active.value?.id === conversationId && activeTask.value?.id === goalId) {
    activeTask.value.goal = result.goal
    await load(conversationId, true)
  }
}
function openTaskLink(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const anchor=(event.target as Element)?.closest?.('a[href]')
  if (!anchor) return
  try {
    const url=new URL(anchor.getAttribute('href') || '',window.location.origin)
    if(url.origin!==window.location.origin || !/^\/conversations\/[^/]+$/.test(url.pathname) || !url.searchParams.get('taskId'))return
    event.preventDefault();event.stopPropagation()
    void router.push(url.pathname+url.search)
  } catch { /* Leave other links to their normal handler. */ }
}
let patchEvents = false
let eventSource: EventSource | undefined
let eventFrame: number | undefined
let eventQueue: WorkspaceEvent[] = []
let recoveryAbort: AbortController | undefined
function cancelRecovery() {
  recoveryAbort?.abort(); recoveryAbort = undefined
  if (timer) clearTimeout(timer)
  timer = undefined
}
function presentDetail(detail: WorkspaceDetail) {
  const atBottom = timeline.value?.isFollowingBottom() ?? true
  active.value = detail.conversation
  messages.value = detail.messages
  activeTask.value = detail.task ?? null; tasks.value = detail.tasks ?? []
  run.value = detail.run; interactions.value = detail.interactions
  context.value = detail.context; assignments.value = detail.assignments ?? []
  older.value = detail.hasOlder ?? false
  if (atBottom) void markRead().catch(() => {})
}
function flushEvents() {
  eventFrame = undefined
  try { for (const event of eventQueue) {
    transcriptStore.apply(event)
    if (event.type === 'project.changed') { const project = event.data as WorkspaceProject; projects.value = [...projects.value.filter(p => p.id !== project.id), project] }
    if (/^(memory|project|collaboration)\./.test(event.type)) knowledgeRevision.value++
  } }
  catch { eventQueue = []; eventSource?.close(); void recoverEvents(); return }
  eventQueue = []
  cursor = transcriptStore.cursor
  agents.value = transcriptStore.agents
  conversations.value = transcriptStore.conversations
  if (selected.value) {
    const detail = transcriptStore.get(selected.value, selectedTask.value || activeTask.value?.id)
    if (detail) presentDetail(detail)
    else if (!conversations.value.some(c => c.id === selected.value)) void router.replace('/conversations')
    else if (activeTask.value && !transcriptStore.details.has(transcriptKey(selected.value, activeTask.value.id))) {
      void router.replace(`/conversations/${selected.value}`); void load(selected.value, true)
    }
  }
}
async function hydrateWorkspace(signal: AbortSignal) {
  const owner = auth.user?.id, epoch = accountEpoch
  const capabilities = await apiRequest<{ features: string[]; csrfToken?: string }>('/api/app/capabilities', { signal })
  if (signal.aborted || disposed || accountEpoch !== epoch || auth.user?.id !== owner) return
  patchEvents = capabilities.features.includes(WORKSPACE_PATCH_CAPABILITY)
  knowledgeEnabled.value = capabilities.features.includes('bot-file-memory-v1')
  if (capabilities.csrfToken) setApiCsrfToken(capabilities.csrfToken)
  const readToken = transcriptStore.beginRead()
  try {
  const snapshot = await apiRequest<WorkspaceSnapshot & { serverIdentity?: ServerIdentity; projects?: WorkspaceProject[] }>('/api/app/workspace/snapshot', { signal })
  if (signal.aborted || disposed || accountEpoch !== epoch || auth.user?.id !== owner) return
  transcriptStore.hydrate(snapshot)
  agents.value = snapshot.agents; conversations.value = transcriptStore.conversations; cursor = snapshot.cursor
  projects.value = snapshot.projects ?? []
  publishServerIdentity(snapshot.serverIdentity)
  } finally { transcriptStore.cancelRead(readToken) }
}
function connectEvents() {
  eventSource?.close()
  if (disposed) return
  if (!navigator.onLine) { suspendEvents(); return }
  const source = new EventSource(`/api/app/events/stream?after=${cursor}${patchEvents ? '&format=patch-v1' : ''}`)
  eventSource = source
  source.addEventListener('workspace', event => {
    if (disposed || eventSource !== source) return
    try {
      eventQueue.push(JSON.parse((event as MessageEvent).data))
      if (eventFrame === undefined) eventFrame = requestAnimationFrame(flushEvents)
    } catch { source.close(); error.value = '消息同步失败，正在恢复'; void recoverEvents() }
  })
  source.addEventListener('ready', event => {
    if (eventSource !== source) return
    flushEvents(); error.value = ''
    publishServerIdentity(JSON.parse((event as MessageEvent).data).serverIdentity)
  })
  source.addEventListener('reset', () => { if (!disposed && eventSource === source) { source.close(); void recoverEvents() } })
  source.onerror = () => {
    if (disposed || eventSource !== source) return
    error.value = '连接中断，正在重连'
    void apiRequest('/api/app/capabilities').catch(cause => {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        source.close()
        error.value = cause.message
      }
    })
  }
}
function suspendEvents() {
  cancelRecovery()
  eventSource?.close(); eventSource = undefined
  error.value = '网络已断开，恢复连接后将自动同步'
}
function resumeEvents() {
  if (!disposed && auth.user?.id) void recoverEvents()
}
async function recoverEvents(initial = false) {
  cancelRecovery()
  if (disposed || !auth.user?.id) return
  if (!navigator.onLine) { suspendEvents(); return }
  const controller = new AbortController(), owner = auth.user.id, epoch = accountEpoch
  recoveryAbort = controller
  const current = () => !disposed && !controller.signal.aborted && recoveryAbort === controller
    && accountEpoch === epoch && auth.user?.id === owner
  eventSource?.close(); eventSource = undefined; eventQueue = []
  if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
  eventFrame = undefined
  try {
    await hydrateWorkspace(controller.signal)
    if (!current()) return
    const detail = !initial && selected.value ? transcriptStore.get(selected.value, selectedTask.value || activeTask.value?.id) : undefined
    if (detail) {
      presentDetail(detail)
      if (transcriptStore.staleDetails.has(transcriptKey(detail.conversation.id, detail.task?.id))) await load(detail.conversation.id, true, controller.signal)
    } else await load(selected.value, false, controller.signal)
    if (current()) connectEvents()
  }
  catch (cause) {
    if (!current()) return
    if (!navigator.onLine) { suspendEvents(); return }
    error.value = cause instanceof Error ? cause.message : '连接中断'
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) return
    timer = setTimeout(() => void recoverEvents(), 1500)
  } finally { if (recoveryAbort === controller) recoveryAbort = undefined }
}
async function select(id: string) {
  error.value = ''
  files.value = []
  mentions.value = []
  text.value = ''
  preview.value = null
  mediaIndex.value = null
  pendingRequestId = undefined
  await router.push(`/conversations/${id}`)
}
function openConversationSettings(id: string) {
  const conversation = conversations.value.find(c => c.id === id)
  if (conversation) void openDialog(conversation.kind === 'direct' ? 'editAgent' : 'editGroup', conversation)
}
async function openDialog(kind: NonNullable<typeof dialog.value>, conversation = active.value) {
  error.value = ''
  dialog.value = kind
  editingId.value = ''
  editingConversationId.value = kind === 'editAgent' || kind === 'editGroup' ? conversation?.id ?? '' : ''
  selectedPresetId.value = 'custom'
  Object.assign(form, {
    name: '',
    avatar: kind === 'agent' ? encodeAgentAvatar(randomAgentIdentity('new-agent', '机器人')) : '',
    instructions: '',
    description: '',
    execution: 'profile' as 'profile'|'computer',
  canManageTeam: true,
    canCollaborate: true,
    memoryEnabled: true,
    approvalPolicy: 'ask',
    source: '',
    memberIds: [],
    memberRoles: {},
    administratorId: '',
    mode: knowledgeEnabled.value ? 'discussion' : 'host',
    autoReplyIds: [],
    maxReplyRounds: 3,
  })
  try {
    if (kind === 'agent' || kind === 'editAgent') {
      const s = await apiRequest<{ sources: Source[]; errors?: string[] }>('/api/app/agents/sources')
      if (!s.sources.length && s.errors?.length) throw new Error('基础机器人服务暂不可用，请联系管理员检查 Hermes 连接后重试。')
      sources.value = s.sources
      form.source = s.sources[0] ? JSON.stringify([s.sources[0].nodeId, s.sources[0].profile]) : ''
    }
    if (kind === 'editAgent') {
      const a = agents.value.find(a => a.id === conversation?.memberIds[0])
      if (!a) throw new Error('机器人不存在，请刷新后重试')
      Object.assign(form, a)
      form.description ??= ''; form.job ??= ''; form.antiJobs ??= []; form.voice ??= ''; form.voiceCustom ??= ''; form.actBias ??= ''
      form.source=JSON.stringify([a.nodeId,a.profile])
      if(a.remoteAgentId){
        const remote=(await apiRequest<{agents:Agent[]}>(`/api/app/nodes/${a.nodeId}/agents`)).agents.find(candidate=>candidate.id===a.remoteAgentId)
        if(remote)Object.assign(form,remote)
      }
      form.approvalPolicy = a.approvalPolicy ?? 'ask'
      editingId.value = a.id
    }
    if (kind === 'editGroup' && conversation) {
      editingId.value = conversation.id
      Object.assign(form, conversation, {
        mode: conversation.collaborationMode ?? conversation.mode,
        memberIds: [...conversation.memberIds],
        autoReplyIds: [...conversation.autoReplyIds],
        memberRoles: Object.fromEntries(Object.entries(conversation.memberRoles ?? {}).map(([id, role]) => [id, { ...role }])),
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
  editingConversationId.value = ''
}
function saveBotProfile(draft: Pick<typeof form, 'name'|'avatar'|'instructions'|'source'|'canManageTeam'|'canCollaborate'|'memoryEnabled'|'approvalPolicy'> & Partial<Pick<typeof form, 'description'|'job'|'antiJobs'|'voice'|'voiceCustom'|'actBias'>>) {
  Object.assign(form, draft)
  form.description ??= ''; form.job ??= ''; form.antiJobs ??= []; form.voice ??= ''; form.voiceCustom ??= ''; form.actBias ??= ''
  void save()
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
  busy.value = true
  error.value = ''
  try {
    const fields = { name: form.name, ...(isAgentDialog.value ? { avatar: form.avatar, description: form.description.trim(), canManageTeam: form.canManageTeam, approvalPolicy: form.approvalPolicy, execution:form.execution, ...(knowledgeEnabled.value ? { canCollaborate: form.canCollaborate, memoryEnabled: form.memoryEnabled } : {}) } : {}), instructions: form.instructions }
    const personaClears = { job: form.job.trim() ? form.job.trim() : null, antiJobs: form.antiJobs.length ? form.antiJobs : null, voice: form.voice || null, voiceCustom: form.voice === 'custom' && form.voiceCustom.trim() ? form.voiceCustom : null, actBias: form.actBias || null }
    const personaCreates = Object.fromEntries(Object.entries(personaClears).filter(([, value]) => value !== null && value !== undefined))
    if (isRemoteAgent.value) {
      await apiRequest(`/api/app/agents/${editingId.value}`, { method: 'PATCH', body: { approvalPolicy: form.approvalPolicy } })
    } else if (dialog.value === 'agent') {
      const [nodeId, profile] = JSON.parse(form.source)
      const result = await apiRequest<{ agent: Agent }>('/api/app/agents', {
        method: 'POST',
        body: { ...fields, ...personaCreates, nodeId, profile, computer: 'auto', envs: {vm:true,cloud:true,desktop:true}, execution:'profile' },
      })
      await refresh()
      const c = conversations.value.find(
        (c) => c.kind === 'direct' && c.memberIds[0] === result.agent.id,
      )
      if (c) await select(c.id)
    } else if (dialog.value === 'editAgent')
      await apiRequest(`/api/app/agents/${editingId.value}`, { method: 'PATCH', body: { ...fields, ...personaClears, ...(form.source?{nodeId:JSON.parse(form.source)[0],profile:JSON.parse(form.source)[1]}:{}) } })
    else {
      const payload = {
        ...fields,
        administratorId: form.administratorId || form.memberIds[0],
        mode: form.mode === 'discussion' ? 'free' : form.mode,
        ...(knowledgeEnabled.value ? { collaborationMode: form.mode } : {}),
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
let draftRevision = 0, accountEpoch = 0
watch([text, files, mentions], () => { draftRevision++ }, { deep: true, flush: 'sync' })
const sendRefreshes = new Map<string, ReturnType<typeof setTimeout>>()
function reconcileSend(receipt: WorkspaceSendReceipt, scope: string, id: string, owner: string | undefined) {
  clearTimeout(sendRefreshes.get(scope))
  sendRefreshes.set(scope, setTimeout(() => {
    sendRefreshes.delete(scope)
    if (disposed || auth.user?.id !== owner || composerKey.value !== scope) return
    if (receipt.cursor !== undefined && transcriptStore.cursor >= receipt.cursor && eventSource?.readyState === EventSource.OPEN) return
    void load(id, true).catch(() => { error.value = '消息已发送，正在恢复同步' })
  }, receipt.cursor === undefined ? 0 : 2000))
}
async function send() {
  const c = active.value
  if (!c || busy.value || (!text.value.trim() && !files.value.length)) return
  busy.value = true
  error.value = ''
  const owner = auth.user?.id, epoch = accountEpoch, revision = draftRevision, scope = composerKey.value, taskId = activeTask.value?.id
  const submittedText = text.value, submittedFiles = files.value, submittedMentions = [...mentions.value]
  const mode = deliveryMode.value && !activeTask.value?.goal ? 'goal' : 'chat'
  const fingerprint = JSON.stringify([c.id, activeTask.value?.id, text.value, mentions.value, files.value.map(f => f.id), mode, directProjectId.value, requestedRounds.value, coordinatorId.value])
  if (!pendingRequestId || pendingFingerprint !== fingerprint) {
    pendingRequestId = createUuid()
    pendingFingerprint = fingerprint
  }
  try {
    const deviceHost = await resolveDeviceHost()
    const receipt = await apiRequest<WorkspaceSendReceipt>(`/api/app/conversations/${c.id}/messages`, {
      method: 'POST',
      body: {
        requestId: pendingRequestId,
        mode,
        ...(knowledgeEnabled.value ? { ...(c.kind === 'direct' && directProjectId.value ? { projectId: directProjectId.value } : {}), ...(requestedRounds.value && c.collaborationMode === 'discussion' ? { rounds: requestedRounds.value } : {}), ...(deliveryMode.value && c.collaborationMode === 'discussion' ? { coordinatorId: coordinatorId.value || coordinators.value[0]?.id } : {}) } : {}),
        ...(activeTask.value ? { taskId: activeTask.value.id } : {}),
        content: text.value,
        mentionIds: mentions.value,
        fileIds: files.value.map((f) => f.id),
        deviceHost,
      },
    })
    if (disposed || accountEpoch !== epoch || auth.user?.id !== owner) return true
    busy.value = false
    if (draftRevision === revision && composerKey.value === scope && text.value === submittedText && files.value === submittedFiles
      && JSON.stringify(mentions.value) === JSON.stringify(submittedMentions)) {
      text.value = ''; files.value = []; mentions.value = []
      pendingRequestId = undefined; pendingFingerprint = ''; deliveryMode.value = false
    }
    flushEvents()
    transcriptStore.acceptReceipt(receipt)
    conversations.value = transcriptStore.conversations
    const accepted = transcriptStore.get(c.id, taskId)
    if (accepted && composerKey.value === scope) presentDetail(accepted)
    reconcileSend(receipt, scope, c.id, owner)
    return true
  } catch (e) {
    if (accountEpoch === epoch) error.value = e instanceof Error ? e.message : '发送失败'
  } finally {
    if (accountEpoch === epoch) busy.value = false
  }
}

async function action(operation: 'pin' | 'archive', id = active.value?.id) {
  const c = conversations.value.find(c => c.id === id)
  if (!c) return
  if (operation === 'archive') return changeLifecycle(c.archived ? 'restore' : 'archive', c.id)
  try {
    await apiRequest(`/api/app/conversations/${c.id}`, {
        method: 'PATCH',
        body: { pinned: !c.pinned },
      })
    await refresh()
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
async function changeLifecycle(operation: WorkspaceLifecycleAction, id: string, fromSearch = false) {
  const conversation = conversations.value.find(c => c.id === id)
  if (!conversation || lifecycleId.value) return
  const actionError = fromSearch ? searchActionError : lifecycleError
  actionError.value = ''
  lifecycleId.value = id
  lifecycleAction.value = operation
  try {
    const path = `/api/app/conversations/${id}/lifecycle`
    let confirmationToken: string | undefined
    if (operation !== 'restore') {
      const preview = await apiRequest<WorkspaceLifecyclePreview>(path)
      const managed = preview.groups.filter(group => group.administrator)
      if (managed.length) throw new Error(`此 Bot 是群聊${managed.map(group => `「${group.name}」`).join('、')}的管理者，请先转交管理权，再归档或删除。`)
      const verb = operation === 'delete' ? '永久删除' : '归档'
      const target = preview.kind === 'direct' ? 'Bot' : '群聊'
      let message = `${verb} ${target}「${preview.name}」${operation === 'delete' ? '及其聊天记录' : ''}？`
      if (preview.groups.length) message += `\n此 Bot 已加入群聊：${preview.groups.map(group => `「${group.name}」`).join('、')}。确认后会先从这些群聊移除，再${verb}。`
      message += operation === 'delete'
        ? `\n此操作无法撤销，${preview.kind === 'group' ? '成员 Bot 和' : ''}文件库中的文件会保留。`
        : '\n聊天记录会保留，可在搜索的“已归档”中取消归档。'
      if (!confirm(message)) return
      confirmationToken = preview.confirmationToken
    }
    await apiRequest(path, { method: 'POST', body: { action: operation, ...(confirmationToken ? { confirmationToken } : {}) } })
    if (operation === 'delete') {
      conversations.value = conversations.value.filter(c => c.id !== id)
      if (conversation.kind === 'direct') agents.value = agents.value.filter(a => a.id !== conversation.memberIds[0])
      if (selected.value === id) await router.replace('/conversations')
    }
    await refresh()
    if (selected.value === id) await load()
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : '操作失败，请重试'
  } finally {
    lifecycleId.value = ''
    lifecycleAction.value = undefined
  }
}
async function stopMember(id: string) {
  if (!editingConversation.value) return
  try {
    await apiRequest(`/api/app/conversations/${editingConversation.value.id}/agents/${id}/stop`, { method: 'POST', body: {} })
    await load(); await refresh()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '停止失败' }
}
async function control(action: 'stop' | 'reconcile') {
  const targetId = run.value?.id ?? active.value?.activeRunId ?? activeTask.value?.activeRunId
  if (!targetId) return
  try {
    await apiRequest(`/api/app/runs/${targetId}/${action}`, { method: 'POST', body: {} })
    await load(undefined, true)
  } catch (e) {
    error.value = String(e)
  }
}
async function respond(i: Interaction, answer: string) {
  if (respondingInteractionId.value) return
  respondingInteractionId.value = i.id
  interactionError.value = ''
  try {
    await apiRequest(`/api/app/interactions/${i.id}/respond`, { method: 'POST', body: { answer } })
    await load(undefined, true)
  } catch (e) {
    interactionError.value = e instanceof Error ? e.message : '审批答复失败，请重试'
  } finally { respondingInteractionId.value = '' }
}
async function loadOlder() {
  const c = active.value
  if (!c || loadingOlder.value) return
  loadingOlder.value = true
  const readToken = transcriptStore.beginRead()
  const taskId = activeTask.value?.id, own = generation
  try {
    const r = await apiRequest<{ messages: Message[]; cursor?: number }>(
      `/api/app/conversations/${c.id}/messages?limit=50&before=${messages.value[0]?.seq ?? 0}${activeTask.value ? `&taskId=${activeTask.value.id}` : ''}`,
    )
    if (own !== generation || active.value?.id !== c.id || activeTask.value?.id !== taskId) return
    const current = transcriptStore.get(c.id, taskId)
    if (!current) return
    const detail = transcriptStore.finishRead(readToken, { ...current, messages: r.messages, cursor: r.cursor })
    detail.hasOlder = r.messages.length === 50
    messages.value = detail.messages; older.value = detail.hasOlder
  } catch (e) {
    error.value = String(e)
  } finally { transcriptStore.cancelRead(readToken); loadingOlder.value = false }
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

watch([selected,selectedTask], () => {
  taskFiles.set(composerKey.value, composer.value?.filesSnapshot() ?? [])
  taskQuotes.set(composerKey.value, quoted.value)
  files.value = [];mentions.value = [];text.value = ''
  pendingRequestId = undefined;uploadedSources = [];uploadedReferences = []
  void load()
})
watch(() => auth.user?.id, (owner, previous) => {
  if (owner === previous) return
  knowledgePanel.value?.close(); knowledgeEnabled.value = false; projects.value = []; knowledgeRevision.value++
  accountEpoch++; busy.value = false
  generation++
  cancelRecovery()
  text.value = ''; files.value = []; mentions.value = []; quoted.value = null
  pendingRequestId = undefined; pendingFingerprint = ''; uploadedSources = []; uploadedReferences = []
  eventSource?.close(); eventSource = undefined; eventQueue = []
  if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
  eventFrame = undefined; cursor = 0
  transcriptStore.hydrate({ agents: [], conversations: [], details: [], cursor: 0 })
  transcriptStore.selectedTasks.clear()
  agents.value = []; conversations.value = []; messages.value = []; active.value = undefined
  tasks.value = []; activeTask.value = null; run.value = null; interactions.value = []; context.value = null
  taskFiles.clear(); taskQuotes.clear()
  if (owner) void recoverEvents()
})
onMounted(async () => {
  window.addEventListener('offline', suspendEvents)
  window.addEventListener('online', resumeEvents)
  void auth.refreshProfileAvatars().catch(() => undefined)
  await recoverEvents(true)
})
onBeforeUnmount(() => {
  window.removeEventListener('offline', suspendEvents)
  window.removeEventListener('online', resumeEvents)
  for (const timer of sendRefreshes.values()) clearTimeout(timer)
  sendRefreshes.clear()
  disposed = true
  eventSource?.close()
  if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
  generation++
  cancelRecovery()
})
</script>
<template>
  <WorkspaceShell ref="shell" :server-name="auth.serverIdentity?.displayName"
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
    @bot-settings-changed="knowledgeChanged"
  >
    <template #sidebar
      ><ConversationList :conversations="conversations" :agents="agents" :selected="selected" @select="select" @settings="openConversationSettings" @pin="action('pin', $event)" @archive="action('archive', $event)" @delete="changeLifecycle('delete', $event)"
    /></template>
    <template #mobile-sidebar
      ><ConversationList :conversations="conversations" :agents="agents" :selected="selected" @select="select" @settings="openConversationSettings" @pin="action('pin', $event)" @archive="action('archive', $event)" @delete="changeLifecycle('delete', $event)"
    /></template>
    <div v-show="!twoDesktops" class="conversation-with-computer">
    <section class="workspace-chat" aria-label="聊天" @click.capture="openTaskLink">
      <MessageTimeline ref="timeline" :identity="`${selected}:${activeTask?.id ?? ''}`" :loading-older="loadingOlder" :messages="uiMessages" :title="activeHeaderTitle"
        :subtitle="active?.kind === 'group' ? `${members.length} 位成员` : ''"
        :header-avatar-name="activeHeaderAvatarName" :header-avatar="activeHeaderAvatar" :header-avatar-kind="active?.kind === 'group' ? 'team' : 'agent'"
        :header-avatar-members="activeHeaderAvatarMembers" :header-avatar-state="activeHeaderAgent ? workspaceAvatarState(active, activeHeaderAgent.id) : 'idle'" :header-avatar-activity-key="active?.lastSeq"
        :loading="loading" :has-older="older && !!active"
        :show-tools="showThinking" :allow-branch="false" :thinking="thinking" :thinking-identity="thinkingIdentity"
        :agent-avatars="Object.fromEntries(agents.map(a => [a.id, a.avatar]))"
        :agent-states="Object.fromEntries(members.map(a => [a.id, workspaceAvatarState(active, a.id)]))"
        :mention-names="members.map(a => a.name)"
        :empty-title="active ? '开始一段新对话' : '还没有聊天'"
        :empty-description="active ? '从下方输入框发送消息。' : '创建机器人，或选择成员新建群聊。'"
        :interaction="interactions[0] ? { id: interactions[0].id, kind: interactions[0].kind, prompt: interactions[0].message, options: interactions[0].choices } : null"
        :interaction-busy="!!respondingInteractionId" :interaction-error="interactionError"
        :approval-agent-name="agents.find(agent => agent.id === interactions[0]?.agentId)?.name"
        @load-older="loadOlder" @quote="quoted = $event" @preview="openPreview" @preview-file="openPreview"
        @approval-choice="interactions[0] && respond(interactions[0], $event)"
        @clarify="interactions[0] && respond(interactions[0], $event)">
        <template #header-leading><button v-if="active" class="workspace-list-back icon-button" aria-label="返回 Bot 列表" @click="router.push('/conversations')"><AppIcon name="chevron-left" /></button></template>
        <template #header-actions>
          <div v-if="active" class="header-actions">
            <button v-if="knowledgeEnabled" type="button" class="icon-button" aria-label="记忆与协作" title="记忆与协作" @click="knowledgePanel?.open(active.kind === 'group' ? 'collaboration' : 'agent', active.memberIds[0], active.projectId)"><AppIcon name="users" /></button>
            <button v-if="active.kind==='direct'" type="button" class="icon-button" aria-label="电脑与定时任务" title="电脑与定时任务" :aria-pressed="dockView==='computer'" @click="toggleDock('computer')"><AppIcon name="monitor"/></button>
            <span v-if="active.kind === 'group' && tasks.length" class="task-picker-shell">
              <select class="task-picker" aria-label="当前话题" :aria-busy="creatingTask" :disabled="creatingTask" :value="activeTask?.id" @change="selectTask">
                <option v-for="task in tasks" :key="task.id" :value="task.id">{{ !task.messageCount && task.titleSource === 'automatic' ? '新话题' : task.title }}</option>
                <option :value="CREATE_TASK_VALUE">新建话题</option>
              </select>
              <AppIcon name="chevron-down" :size="14"/>
            </span>
            <button class="icon-button" :aria-label="active.kind === 'direct' ? '编辑资料' : '群聊设置'" :title="active.kind === 'direct' ? '编辑资料' : '群聊设置'" @click="openDialog(active.kind === 'direct' ? 'editAgent' : 'editGroup')"><AppIcon :name="active.kind === 'direct' ? 'edit' : 'settings'" /></button>
            <button type="button" class="icon-button" aria-label="Inspector" title="Inspector" :aria-pressed="dockView==='inspector'" @click="toggleDock('inspector')"><AppIcon name="bug"/></button>
          </div>
        </template>
      </MessageTimeline>
      <p v-if="run?.status === 'queued'" class="task-queue-status" role="status">正在等待可用机器人</p>
      <p v-if="active?.collaborationWaiting" class="task-queue-status" role="status"><button @click="knowledgePanel?.open('collaboration', active.memberIds[0])">等待同伴回复 · 查看协作</button></p>
      <p v-if="error" class="error" role="alert">{{ error }}<button class="icon-button" @click="error = ''" aria-label="关闭错误"><AppIcon name="close" /></button></p>
      <ComposerShell v-if="active" :key="composerKey" ref="composer" mode="group" :draft-key="composerKey"
        v-model:delivery-mode="deliveryMode" :delivery-available="active.kind === 'group' && !activeTask?.goal"
        :delivery-disabled="!canRequestGoal || busy || loading || !!activeTask?.activeRunId"
        :delivery-disabled-reason="!canRequestGoal ? '负责人需要是本机上未归档的 Bot' : ''"
        :disabled="active.archived || loading || active.id !== selected" :sending="busy" stop-while-running :streaming="!!active.activeRunId"
        :tool-trace-visible="showThinking" :reference="reference" :context-used="Number(context?.usedTokens || 0)" :context-limit="Number(context?.limitTokens || 0)"
        :mention-options="active.kind === 'group' ? members.map(a => ({id:a.id,label:a.name,insertText:`@${a.name} `})) : []"
        @send="sendFromComposer" @stop="control('stop')" @tool-trace-toggle="showThinking = !showThinking" @clear-reference="quoted = null" @error="error = $event">
        <template #before-input>
          <div v-if="knowledgeEnabled" class="knowledge-shortcuts composer-knowledge">
            <label v-if="active.kind === 'direct' && projects.some(p => p.memberIds.includes(active!.memberIds[0]!))">当前项目<select v-model="directProjectId"><option value="">不关联项目</option><option v-for="project in projects.filter(p => !p.archived && p.memberIds.includes(active!.memberIds[0]!))" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
            <label v-if="active.collaborationMode === 'discussion' && !deliveryMode">讨论轮数<select v-model="requestedRounds"><option :value="undefined">按消息要求</option><option v-for="n in 12" :key="n" :value="n">{{ n }} 轮</option></select></label>
            <label v-if="deliveryMode && active.collaborationMode === 'discussion'">交付负责人<select v-model="coordinatorId"><option value="">{{ coordinators[0]?.name ?? '请先授权负责人' }}</option><option v-for="agent in coordinators" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
          </div>
          <TaskPlan :key="activeTask?.id" :goal="activeTask?.goal" :assignments="assignments" :agents="agents" :save-criteria="saveGoalCriteria" @stop="stopTask" @resume="resumeTask" />
        </template>
      </ComposerShell>
    </section>
    <WorkspaceBotPanel v-if="dockView&&active" :conversation-id="active.id" :task-id="activeTask?.id" :mode="dockView" :active="!twoDesktops" :agents="computerCandidates" :is-admin="auth.user?.role === 'admin'" @close="dockView=undefined" @changed="refresh()" @settings="shell?.openLocalVm()" @desktop="openComputer" @workspace="desktopAgent=$event;twoDesktops=true" />
    </div>
    <ComputerPanel ref="desktopViewer" v-if="computerOpen&&desktopAgent" :agents="[desktopAgent]" :backend="desktopBackend" :host="desktopHost" auto-take @changed="load()" @close="computerOpen=false" />
    <LocalVmWorkspace ref="vmWorkspace" v-if="twoDesktops&&desktopAgent" :agents="agents.filter(a=>a.execution==='computer'&&!a.archived&&!a.computerEnvironmentId)" :primary="desktopAgent.id" @close="twoDesktops=false" />
    <FloatingResourceSearch section="groups" label="搜索聊天" :items="searchItems" tabbed @open="searchActionError = ''" @select="select">
      <template #item-actions="{ item }">
        <div v-if="archivedIds.has(item.id)" class="search-lifecycle-actions">
          <button type="button" class="search-restore" :aria-label="`取消归档：${item.title}`" :disabled="!!lifecycleId" @click="changeLifecycle('restore', item.id, true)">{{ lifecycleId === item.id && lifecycleAction === 'restore' ? '恢复中…' : '取消归档' }}</button>
          <button type="button" class="search-delete" :aria-label="`删除聊天：${item.title}`" :disabled="!!lifecycleId" :aria-busy="lifecycleId === item.id && lifecycleAction === 'delete'" @click="changeLifecycle('delete', item.id, true)">
            <AppIcon name="trash" :size="15" />{{ lifecycleId === item.id && lifecycleAction === 'delete' ? '删除中…' : '删除' }}
          </button>
        </div>
      </template>
      <template #footer><p v-if="searchActionError" class="search-delete-error" role="alert">{{ searchActionError }}</p></template>
    </FloatingResourceSearch>
    <Teleport to="body"><div v-if="lifecycleError" class="lifecycle-error" role="alert"><span>{{ lifecycleError }}</span><button type="button" aria-label="关闭聊天操作提示" @click="lifecycleError = ''"><AppIcon name="close" :size="16" /></button></div></Teleport>
    <PreviewModal v-if="preview" :item="preview" :items="media" @close="preview = null" />
    <ImagePreviewLightbox v-model="mediaIndex" :images="lightboxMedia" />
    <BotProfileDialog v-if="dialog === 'editAgent' && editingBot" :key="editingBot.id" :agent="editingBot" :draft="form" :sources="sources" :profiles="auth.profiles" :agents="agents" :conversations="conversations" :conversation-id="editingConversationId" :is-admin="auth.user?.role === 'admin'" :knowledge-enabled="knowledgeEnabled" :busy="busy" :error="error" @close="closeDialog" @save="saveBotProfile" @changed="knowledgeChanged" />
    <Teleport to="body"><dialog v-if="dialog && dialog !== 'editAgent'" ref="dialogElement" class="editor" aria-labelledby="conversation-editor-title" @cancel.prevent="closeDialog">
      <form @submit.prevent="save">
        <header>
          <h2 id="conversation-editor-title">
            {{ dialog === 'agent' ? '创建机器人' : dialog === 'group' ? '创建群聊' : '群聊设置' }}
          </h2>
          <button type="button" class="icon-button" aria-label="关闭" @click="closeDialog"><AppIcon name="close" :size="18" /></button>
        </header>
        <div class="editor-content">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label>名称<input v-model="form.name" :readonly="isRemoteAgent" required maxlength="100" /></label>
        <details v-if="dialog === 'group'" class="group-options">
          <summary>从团队模板选择（可选）</summary>
          <TeamPresetPicker :selected="selectedPresetId" :available="agents.filter(a => !a.archived && !a.temporaryGoalId).length" @select="choosePreset" />
        </details>
        <p v-if="isRemoteAgent">引用的机器人配置由远端管理，请在远端修改名称、头像和角色规则。</p>
        <AgentIdentityPanel v-if="isAgentDialog && !isRemoteAgent" :key="`${dialog}:${editingId}`" :profile="avatarProfile" embedded :show-name="false" :show-default-model="false" :show-actions="false" @avatar-change="form.avatar = $event" />
        <div v-else-if="dialog === 'editGroup'" class="team-avatar-settings">
          <TeamAvatar :name="form.name" :members="workspaceAvatarMembers(form.memberIds, agents, dialog === 'editGroup' ? editingConversation : undefined)" :size="64" />
          <small>群聊头像由成员头像自动组合，随成员头像更新。</small>
        </div>
        <label
          v-if="isAgentDialog&&!isRemoteAgent"
          >基础机器人<select v-model="form.source" required>
            <option
              v-for="s in sources"
              :key="`${s.nodeId}:${s.profile}`"
              :value="JSON.stringify([s.nodeId, s.profile])"
            >
              {{ s.name }} · {{ s.nodeId === 'local' ? '当前服务' : s.nodeId }}
            </option></select
          ><small v-if="!sources.length"
            >{{ auth.isBotOnly ? '暂无可用的已分配机器人，请联系管理员分配或检查连接。' : '没有可用的基础机器人，请检查 Web 的 Hermes 连接。' }}</small
          ></label
        ><label v-if="isAgentDialog"
          >角色提示词与规则<textarea
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
        <template v-if="knowledgeEnabled && isAgentDialog && !isRemoteAgent">
          <label class="team-management-permission"><span><input v-model="form.memoryEnabled" type="checkbox" />自动记录长期事实</span></label>
          <button v-if="editingId" type="button" @click="knowledgePanel?.open('agent', editingId)">查看此 Bot 的记忆</button>
        </template>
        <fieldset v-if="selectedPreset" class="preset-role-mapping">
          <legend>角色分配</legend>
          <label v-for="(role, index) in selectedPreset.roles" :key="role.name">
            {{ role.name }}{{ role.host ? ' · 管理员' : '' }}
            <select :value="form.memberIds[index]" :aria-label="`${role.name}对应的机器人`" @change="assignPresetRole(index, ($event.target as HTMLSelectElement).value)">
              <option v-for="a in agents.filter(a => !a.archived && !a.temporaryGoalId)" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
            <small>{{ role.description }}</small>
          </label>
          <small>角色分工仅在本群生效，聊天中保留机器人的名称和头像。</small>
        </fieldset>
        <fieldset v-else-if="!isAgentDialog">
          <legend>选择成员</legend>
          <label
            v-for="a in agents.filter((a) =>
              !a.temporaryGoalId && (!a.archived || (dialog === 'editGroup' && editingConversation?.memberIds.includes(a.id))),
            )"
            :key="a.id"
            ><input
              v-model="form.memberIds"
              type="checkbox"
              :value="a.id"
              :disabled="busy || (form.mode !== 'discussion' && dialog === 'editGroup' && (a.id === editingConversation?.administratorId || a.id === form.administratorId)) || (!form.memberIds.includes(a.id) && form.memberIds.length >= 8)"
            />{{ a.name }}</label
          ><small v-if="dialog === 'group' && agents.filter((a) => !a.archived && !a.temporaryGoalId).length < 2"
            >至少需要两个机器人才能创建群聊。</small
          >
          <small v-if="dialog === 'editGroup'">可增减成员，最多 8 位。当前管理员不能移除；如需移除，请先更换管理员并保存。</small>
          <button v-for="a in agents.filter(a => editingConversation?.activeAgentStates?.[a.id])" :key="`stop:${a.id}`" type="button" @click="stopMember(a.id)">停止 {{ a.name }}</button>
        </fieldset>
        <fieldset v-if="dialog === 'editGroup' && Object.keys(form.memberRoles).length">
          <legend>角色分工</legend>
          <p v-for="(role, id) in form.memberRoles" :key="id">{{ agents.find(a => a.id === id)?.name }} · {{ role.name }}<br /><small>{{ role.description }}</small></p>
        </fieldset>
        <template v-if="!isAgentDialog"
          ><label v-if="form.mode !== 'discussion'"
            >负责人<select v-model="form.administratorId" required>
              <option
                v-for="a in agents.filter((a) => form.memberIds.includes(a.id))"
                :key="a.id"
                :value="a.id"
              >
                {{ a.name }}
              </option>
            </select></label
          >
          <label>群规则（可选）<textarea v-model="form.instructions" rows="3" maxlength="24000" placeholder="例如：回答简洁，重要结论注明来源" /></label>
          <button v-if="knowledgeEnabled" type="button" @click="knowledgePanel?.open('projects', form.memberIds[0], editingConversation?.projectId)">关联项目与共享记忆</button>
          <p v-if="dialog === 'group'" class="group-help">创建后即可聊天。需要交付具体结果时，再开启交付目标。</p>
          <details class="group-options">
            <summary>高级协作设置</summary>
          <label
            >协作方式<select v-model="form.mode">
              <option v-if="knowledgeEnabled" value="discussion">平等讨论</option>
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
          <label v-if="form.mode !== 'discussion'"
            ><input type="checkbox" :checked="form.maxReplyRounds === -1" @change="form.maxReplyRounds = ($event.target as HTMLInputElement).checked ? -1 : 3" />不限制自动协作轮数</label>
          <label v-if="form.mode !== 'discussion' && form.maxReplyRounds !== -1">自动协作轮数<input
              v-model.number="form.maxReplyRounds"
              type="number"
              min="1"
              max="100"
              required /></label
        >
          </details>
        </template>
        </div>
        <footer>
          <button class="quiet-button" type="button" @click="closeDialog">取消</button
          ><button v-if="!isRemoteAgent" class="solid-button" :disabled="busy || (!isAgentDialog && (form.memberIds.length < (dialog === 'group' ? 2 : 1) || form.memberIds.length > 8))">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </dialog></Teleport>
    <WorkspaceKnowledgePanel v-if="knowledgeEnabled" ref="knowledgePanel" :agents="agents" :conversations="conversations" :conversation-id="active?.id" :revision="knowledgeRevision" @changed="knowledgeChanged" />
  </WorkspaceShell>
</template>
<style scoped>
.knowledge-shortcuts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px}.knowledge-shortcuts button,.knowledge-shortcuts select{min-height:44px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit;font-size:13px;cursor:pointer}.knowledge-shortcuts button:hover{background:var(--surface-hover)}.knowledge-shortcuts button:focus-visible,.knowledge-shortcuts select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.knowledge-shortcuts label{display:flex;align-items:center;gap:8px;font-size:13px}.composer-knowledge{max-width:760px;margin:auto}
.conversation-with-computer{display:flex;height:100%;min-width:0;min-height:0}.conversation-with-computer>.workspace-chat{flex:1;min-width:0}
.workspace-chat{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}.new-actions{display:grid;gap:2px}.new-actions button{display:flex;align-items:center;min-height:40px;padding:0 11px;border:0;border-radius:9px;background:transparent;color:var(--text-primary);text-align:left;font-size:12px;font-weight:610;cursor:pointer}.new-actions button:hover{background:var(--surface-hover)}.header-actions{display:flex;gap:4px;margin-left:auto}.error{display:flex;align-items:center;justify-content:space-between;margin:0 18px 9px;color:var(--danger);font-size:12px}.team-avatar-settings{display:grid;gap:12px}.team-avatar-options{display:flex;gap:10px}.team-avatar-options button{padding:5px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft);cursor:pointer}.team-avatar-options button[aria-pressed=true]{border-color:var(--accent)}.nodes-overlay{position:fixed;inset:0;z-index:1000;background:var(--scrim);display:grid;place-items:center}.nodes-overlay>div{padding:20px;max-height:85vh;overflow:auto;width:min(520px,90vw);background:var(--surface-raised);border:1px solid var(--line);border-radius:16px}
.editor {
  border: 1px solid var(--line);
  border-radius: 18px;
  width: min(520px, calc(100vw - 48px));
  max-height: 85vh;
  overflow: hidden;
  background: var(--surface);
  color: var(--text-primary);
  padding: 25px;
}
.editor::backdrop {
  background: #0006;
}
.editor form{display:flex;flex-direction:column;max-height:calc(85dvh - 32px);min-height:0}
.editor-content{min-height:0;overflow:auto;padding:0 4px;scrollbar-gutter:stable}
.editor header,.editor footer{flex-shrink:0}
.editor header{min-height:44px}
.editor .remote-picker,.editor footer button{min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text-primary);font:inherit;font-size:13px;cursor:pointer}
.editor .remote-picker:hover,.editor footer .quiet-button:hover{background:var(--surface-hover)}
.editor footer .solid-button{background:var(--text-primary);color:var(--surface);border-color:var(--text-primary)}
.editor footer button:disabled{opacity:.5;cursor:default}
.editor .remote-picker:focus-visible,.editor footer button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.editor header,
.editor footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor h2 {
  font-size: 20px;
  margin: 12px 0;
}
.editor label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 15px 0;
  font-size: 13px;
}
.task-picker-shell{position:relative;display:inline-flex;align-items:center;max-width:210px;min-width:0}.task-picker-shell>.app-icon{position:absolute;right:11px;pointer-events:none;color:var(--text-muted)}.task-picker{width:100%;min-width:0;max-width:210px;min-height:38px;appearance:none;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text-primary);padding:6px 34px 6px 14px;font:inherit;font-size:12px;font-weight:520;text-overflow:ellipsis;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 5%,transparent);transition:border-color 140ms ease,background-color 140ms ease,box-shadow 140ms ease}.task-picker:hover{border-color:var(--line-strong);background:var(--surface-hover)}.task-picker:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.task-picker:disabled{cursor:wait;opacity:.55}
.task-queue-status{margin:0 20px 8px;font-size:13px;color:var(--text-muted)}
.group-options{margin:12px 0;border-top:1px solid var(--line)}.group-options summary{min-height:44px;align-content:center;cursor:pointer;font-size:13px;color:var(--text-secondary)}.group-options summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.group-help{font-size:13px;line-height:1.6;color:var(--text-secondary)}
@media(max-width:720px){.task-picker-shell,.task-picker{max-width:118px}.task-picker{min-height:44px;padding-left:12px}}
.team-management-permission > span {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}
.team-management-permission small {
  color: var(--text-muted);
  line-height: 1.6;
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
  margin-top: 12px;
}
.status {
  margin-top: 8px;
}
.workspace-list-back{display:none}@media(max-width:900px){.workspace-list-back{display:grid}}
.search-delete{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;gap:5px;min-width:64px;min-height:44px;margin-right:4px;padding:6px 9px;border:0;border-radius:8px;background:transparent;color:var(--danger);font:12px var(--font-ui);cursor:pointer}
.search-delete:hover:not(:disabled){background:var(--surface-hover)}
.search-delete:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.search-delete:disabled{opacity:.5;cursor:wait}
.search-delete-error{margin:0;padding:10px 16px 14px;color:var(--danger);font-size:12px;line-height:1.5}
.search-lifecycle-actions{display:flex;flex:0 0 auto;align-items:center;gap:2px}
.search-restore{min-height:44px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--text-secondary);font:12px var(--font-ui);cursor:pointer;white-space:nowrap}
.search-restore:hover:not(:disabled){background:var(--surface-hover)}
.search-restore:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.search-restore:disabled{opacity:.5;cursor:wait}
.lifecycle-error{position:fixed;z-index:220;left:50%;bottom:max(24px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:flex-start;gap:12px;width:max-content;max-width:min(520px,calc(100vw - 32px));padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface-raised);box-shadow:var(--shadow-float);color:var(--danger);font-size:13px;line-height:1.6}
.lifecycle-error button{display:grid;place-items:center;flex:0 0 28px;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer}
.lifecycle-error button:hover{background:var(--surface-hover)}
.lifecycle-error button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
