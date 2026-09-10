<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '@shared/types'
import type { GroupAgent, GroupRoomSummary, GroupTopicSummary, ModelOption } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import type { ComposerOption, ComposerReference, ComposerSubmit } from '@/components/composer/types'
import CreateGroupDialog from '@/components/groups/CreateGroupDialog.vue'
import GroupManager from '@/components/groups/GroupManager.vue'
import TopicTeamPickerDialog from '@/components/groups/TopicTeamPickerDialog.vue'
import type { GroupProfileOption } from '@/components/groups/types'
import PreviewModal from '@/components/library/PreviewModal.vue'
import ImagePreviewLightbox from '@/components/library/ImagePreviewLightbox.vue'
import type { PreviewMedia } from '@/components/library/ImagePreviewLightbox.vue'
import type { UiLibraryItem } from '@/components/library/types'
import { mediaItemsFromMessages, mediaUrlIdentity, previewItemFromUrl } from '@/components/library/mediaSequence'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import FloatingResourceSearch from '@/components/app/FloatingResourceSearch.vue'
import type { SidebarItem, SidebarItemBase } from '@/components/app/types'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { loadComposerFile } from '@/components/workspace/pendingComposer'
import { readAgentShowThinking, writeAgentShowThinking } from '@/utils/sessionPreferences'
import { MODEL_CATALOG_CHANGED_EVENT, modelCatalogChangedProfile } from '@/utils/modelCatalogEvents'
import { agentToUi, groupInteraction, groupMessageToUi, roomSidebarItem, roomToUi } from '@/components/workspace/viewModels'
import { getModels } from '@/api/profiles'
import { getGroupPushSubscriptions, getPushCapabilities, setGroupPushSubscription } from '@/api/push'
import { useAuthStore } from '@/stores/auth'
import { useGroupsStore } from '@/stores/groups'

const auth = useAuthStore()
const groups = useGroupsStore()
const route = useRoute()
const router = useRouter()
const createOpen = ref(false)
const topicTeamPickerOpen = ref(false)
const managerOpen = ref(false)
const showThinking = ref(true)
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const mediaPreviewIndex = ref<number | null>(null)
const composer = ref<InstanceType<typeof ComposerShell> | null>(null)
const modelOptionsByProfile = ref<Record<string, ModelOption[]>>({})
const modelOptionsLoading = ref<Record<string, boolean>>({})
const modelOptionsError = ref<Record<string, string>>({})
const agentUpdateBusy = ref<Record<string, boolean>>({})
const agentUpdateError = ref<Record<string, string>>({})
const managerError = ref('')
const createError = ref('')
const creatingRoom = ref(false)
const roomActionMenu = ref<{ roomId: string; topicId?: string; x: number; y: number } | null>(null)
const topicActionRenaming = ref(false)
const topicActionRenameValue = ref('')
const archivedOverlayOpen = ref(false)
const archivedRoomList = shallowRef<GroupRoomSummary[]>([])
const archivedTopicList = shallowRef<GroupTopicSummary[]>([])
const archivedTopicCatalog = shallowRef<GroupTopicSummary[]>([])
const archivedTopicRoomId = ref('')
const archivedSearchLoading = ref(false)
const pushProtocolSupported = ref(false)
const pushConfigured = ref(false)
const subscribedPushRooms = ref<Set<string>>(new Set())
const pushSubscriptionBusy = ref(false)
const pushSubscriptionError = ref('')

function handleModelCatalogChanged(event: Event) {
  const profile = modelCatalogChangedProfile(event)
  if (!profile) return
  const { [profile]: _removed, ...remaining } = modelOptionsByProfile.value
  modelOptionsByProfile.value = remaining
  if (groups.agents.some(agent => agent.profile === profile)) void loadAgentModels(profile)
}

const activeRooms = computed(() => groups.rooms.filter(room => !room.archived))
const roomSidebarItems = computed<SidebarItemBase[]>(() => activeRooms.value.map(room => {
  const currentMembers = room.id === groups.selectedRoomId && displayAgents.value.length
    ? displayAgents.value.slice(0, 4).map(agent => ({
      profile: agent.profile,
      nodeId: agent.nodeId,
      displayName: agent.displayName,
    }))
    : room.avatarMembers
  return roomSidebarItem({ ...room, avatarMembers: currentMembers }, agentAvatars.value, agentAvatarsByName.value)
}))
const activeRoomById = computed(() => new Map(activeRooms.value.map(room => [room.id, room])))
const allTopics = computed(() => {
  const topics = new Map<string, GroupTopicSummary>()
  for (const topic of groups.pinnedTopics) {
    if (!topic.archived && activeRoomById.value.has(topic.roomId)) topics.set(topic.id, topic)
  }
  for (const room of activeRooms.value) {
    for (const topic of groups.topicsForRoom(room.id)) {
      if (!topic.archived) topics.set(topic.id, topic)
    }
  }
  return [...topics.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
})
const sidebarSubtitle = computed(() => groups.availability === 'available'
  ? `${allTopics.value.length} 个话题`
  : `9119 团队 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL}`)
const SEARCH_ALL_ID = 'search:all'
const SEARCH_ARCHIVED_ID = 'search:archived'
const SEARCH_ROOM_PREFIX = 'room:'
const SEARCH_ARCHIVED_ROOM_PREFIX = 'archived-room:'
const SEARCH_ARCHIVED_TOPIC_PREFIX = 'archived-topic:'
function topicSidebarItemId(roomId: string, topicId: string): string { return `topic:${roomId}:${topicId}` }
function topicFromSidebarItemId(id: string): { roomId: string; topicId: string } | undefined {
  const match = /^topic:([^:]+):([^:]+)$/.exec(id)
  return match ? { roomId: match[1]!, topicId: match[2]! } : undefined
}
function sidebarDate(updatedAt: number): string {
  const timestamp = updatedAt < 10_000_000_000 ? updatedAt * 1000 : updatedAt
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp))
}
function topicSidebarItem(topic: GroupTopicSummary, section?: string): SidebarItem {
  const room = activeRoomById.value.get(topic.roomId)
  const roomItem = roomSidebarItems.value.find(item => item.id === topic.roomId)
  return {
    id: topicSidebarItemId(topic.roomId, topic.id),
    title: topic.title,
    subtitle: `${room?.name || '未知团队'}：${topic.preview || '暂无消息'}`,
    meta: sidebarDate(topic.updatedAt),
    unread: topic.unreadCount,
    pinned: topic.pinned,
    section,
    topic: true,
    avatar: roomItem?.avatar ?? '',
    avatarFallbackKey: topic.roomId,
    avatarMembers: roomItem?.avatarMembers,
    active: topic.roomId === groups.selectedRoomId && topic.id === groups.selectedTopicId,
  }
}
const sidebarItems = computed<SidebarItem[]>(() => {
  const pinned = allTopics.value.filter(topic => topic.pinned).map(topic => topicSidebarItem(topic, '话题置顶'))
  const recent = allTopics.value.filter(topic => !topic.pinned).map(topic => topicSidebarItem(topic, '最近话题'))
  const items = [...pinned, ...recent]
  if (groups.selectedRoomId && groups.selectedTopicId && !groups.selectedTopic && !items.some(item => item.id === topicSidebarItemId(groups.selectedRoomId!, groups.selectedTopicId!))) {
    const room = activeRoomById.value.get(groups.selectedRoomId)
    const roomItem = roomSidebarItems.value.find(item => item.id === groups.selectedRoomId)
    items.unshift({
      id: topicSidebarItemId(groups.selectedRoomId, groups.selectedTopicId),
      title: '新话题',
      subtitle: `${room?.name || '未知团队'}：发送第一条消息以创建`,
      section: '最近话题',
      topic: true,
      avatar: roomItem?.avatar ?? '',
      avatarFallbackKey: groups.selectedRoomId,
      avatarMembers: roomItem?.avatarMembers,
      active: true,
    })
  }
  return items
})
function archivedRoomSidebarItems(): SidebarItemBase[] {
  return archivedRoomList.value.map(room => ({
  id: room.id,
  title: room.name || '未命名团队',
  subtitle: room.lastMessage?.content || `${room.agentCount} 个机器人`,
  meta: sidebarDate(room.updatedAt),
  avatar: room.avatar || '',
  avatarFallbackKey: room.id,
  avatarMembers: (room.avatarMembers || []).map(member => ({ name: member.displayName || member.profile })),
  }))
}
const archivedRoomById = computed(() => new Map(archivedRoomList.value.map(room => [room.id, room])))
const archivedTopicRoomName = computed(() => activeRoomById.value.get(archivedTopicRoomId.value)?.name
  || archivedRoomById.value.get(archivedTopicRoomId.value)?.name
  || '所选团队')
function archivedTopicSidebarItem(topic: GroupTopicSummary): SidebarItem {
  const room = activeRoomById.value.get(topic.roomId) || archivedRoomById.value.get(topic.roomId)
  const roomItem = roomSidebarItems.value.find(item => item.id === topic.roomId)
    || archivedRoomSidebarItems().find(item => item.id === topic.roomId)
  return {
    id: `${SEARCH_ARCHIVED_TOPIC_PREFIX}${topic.roomId}:${topic.id}`,
    title: topic.title,
    subtitle: `${room?.name || '未知团队'}：${topic.preview || '暂无消息'}`,
    meta: sidebarDate(topic.updatedAt),
    section: '话题',
    avatar: roomItem?.avatar ?? '',
    avatarFallbackKey: topic.roomId,
    avatarMembers: roomItem?.avatarMembers,
    showMore: false,
  }
}
const groupSearchItems = computed<SidebarItem[]>(() => [
  {
    id: SEARCH_ALL_ID,
    title: '全部',
    subtitle: `${allTopics.value.length} 个话题`,
    section: '团队',
    icon: 'groups',
    showMore: false,
    emptyText: '暂无话题',
    children: allTopics.value.map(topic => topicSidebarItem(topic, '话题')),
  },
  ...roomSidebarItems.value.map(item => ({
    ...item,
    id: `${SEARCH_ROOM_PREFIX}${item.id}`,
    section: '团队',
    showMore: false,
    emptyText: '该团队暂无话题',
    children: allTopics.value.filter(topic => topic.roomId === item.id).map(topic => topicSidebarItem(topic, '话题')),
  })),
  {
    id: SEARCH_ARCHIVED_ID,
    title: '已归档内容',
    subtitle: archivedSearchLoading.value ? '正在加载归档内容…' : `${archivedRoomList.value.length} 个团队 · ${archivedTopicCatalog.value.length} 个话题`,
    section: '归档',
    icon: 'archive' as const,
    showMore: false,
    emptyText: '暂无归档团队或话题',
    children: [
      ...archivedRoomSidebarItems().map(item => ({ ...item, id: `${SEARCH_ARCHIVED_ROOM_PREFIX}${item.id}`, section: '团队', showMore: false })),
      ...archivedTopicCatalog.value.map(archivedTopicSidebarItem),
    ],
  },
])
const localAgentIdentities = computed(() => new Map(auth.profiles.map(profile => [profile.name, {
  name: profile.agentName || profile.displayName || profile.name,
}])))
const displayAgents = computed(() => groups.agents.map(agent => {
  const identity = agent.nodeId === 'local' ? localAgentIdentities.value.get(agent.profile) : undefined
  return identity ? { ...agent, displayName: identity.name } : agent
}))
const messages = computed(() => groups.messages.map(message => groupMessageToUi(message, displayAgents.value)))
const selectedRoomPushEnabled = computed(() => Boolean(
  groups.selectedRoomId && subscribedPushRooms.value.has(groups.selectedRoomId),
))
const conversationMediaItems = computed(() => mediaItemsFromMessages(messages.value))
const lightboxMedia = computed(() => conversationMediaItems.value.map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const agents = computed(() => displayAgents.value.map(agentToUi))
const agentAvatars = computed(() => Object.fromEntries([
  ...auth.profiles.flatMap(profile =>
    profile.agentAvatar ? [[profile.name, profile.agentAvatar] as const] : []),
  ...groups.nodes.flatMap(node => node.profiles.flatMap(profile =>
    profile.avatar ? [[`node:${node.nodeId}:${profile.name}`, profile.avatar] as const] : [])),
]))
const agentAvatarsByName = computed(() => Object.fromEntries([
  ...auth.profiles.flatMap(profile =>
    profile.agentAvatar ? [[profile.agentName || profile.displayName || profile.name, profile.agentAvatar] as const] : []),
  ...groups.nodes.flatMap(node => node.profiles.flatMap(profile =>
    profile.avatar ? [[profile.displayName || profile.name, profile.avatar] as const] : [])),
]))
function serverAddress(value: string): string {
  try { return new URL(value).host }
  catch { return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') }
}
const remoteServerAddresses = computed(() => Object.fromEntries(groups.nodes
  .filter(node => node.nodeId && node.serverUrl)
  .map(node => [node.nodeId, serverAddress(node.serverUrl)])))
const hostAgent = computed(() => groups.hostProtocol ? displayAgents.value.find(agent => agent.isHost) : undefined)
const connected = computed(() => ['connected', 'ready'].includes(groups.connectionState))
const synced = computed(() => groups.connectionState === 'ready' && !groups.isLoading)
const activeInteraction = computed(() => groupInteraction(groups.pendingInteractions[0]))
const room = computed(() => groups.selectedRoom ? roomToUi(groups.selectedRoom) : null)
const profiles = computed<GroupProfileOption[]>(() => [
  ...auth.profiles.map(profile => ({
    id: `local|${profile.name}`,
    profile: profile.name,
    displayName: profile.agentName || profile.displayName || profile.name,
    nodeId: 'local',
    nodeLabel: '当前 Hermes',
    avatar: profile.agentAvatar,
  })),
  ...groups.nodes.flatMap(node => node.profiles.map(profile => ({
    id: `${node.nodeId}|${profile.name}`,
    profile: profile.name,
    displayName: profile.displayName || profile.name,
    nodeId: node.nodeId,
    nodeLabel: node.name,
    avatar: profile.avatar,
  }))),
])
const availableProfiles = computed(() => profiles.value.filter(profile => !groups.agents.some(agent =>
  agent.profile === profile.profile && agent.nodeId === profile.nodeId)))
const uploadsEnabled = computed(() => auth.groupUploadsEnabled)
const managerBusy = computed(() => groups.isLoading || Object.values(agentUpdateBusy.value).some(Boolean))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, author: quoted.value.author, content: quoted.value.content } : null)
const mentionNames = computed(() => ['所有人', ...displayAgents.value.map(agent => agent.displayName || agent.profile)])
const mentionOptions = computed<ComposerOption[]>(() => [
  { id: 'all', label: '所有人', detail: '通知团队内全部机器人' },
  ...displayAgents.value.map(agent => ({
    id: agent.id,
    label: agent.displayName || agent.profile,
    detail: groups.hostProtocol && agent.isHost ? `管理员 · ${agent.profile}` : agent.profile,
    disabled: !agent.enabled,
  })),
])
const roomSubtitle = computed(() => {
  if (!groups.selectedRoom) return '选择或新建一个团队'
  const host = hostAgent.value ? `管理员 ${hostAgent.value.displayName || hostAgent.value.profile} · ` : ''
  const mode = groups.selectedRoom.orchestrationMode === 'host' ? '管理员协调 · ' : ''
  return `${groups.selectedRoom.name} · ${mode}${host}${groups.agents.length} 个机器人 · 最多 ${groups.selectedRoom.maxReplyRounds} 轮回复`
})
const activeAgentIds = computed(() => {
  if (!groups.topicProtocol) {
    return new Set(groups.agents.filter(agent => ['queued', 'running'].includes(agent.status)).map(agent => agent.id))
  }
  return new Set((groups.selectedRoom?.runs ?? [])
    .filter(run => run.topicId === groups.selectedTopicId && ['queued', 'running'].includes(run.status))
    .map(run => run.agentId))
})
const typingAgentIds = computed(() => {
  if (!groups.topicProtocol) return new Set(groups.agents.filter(agent => agent.status === 'running').map(agent => agent.id))
  return new Set((groups.selectedRoom?.runs ?? [])
    .filter(run => run.topicId === groups.selectedTopicId && run.status === 'running')
    .map(run => run.agentId))
})
const typingAgentNames = computed(() => [...new Set(groups.agents
  .filter(agent => typingAgentIds.value.has(agent.id))
  .map(agent => displayAgents.value.find(candidate => candidate.id === agent.id)?.displayName || agent.profile))])
const typingActivity = computed(() => {
  if (!connected.value) return ''
  const names = typingAgentNames.value
  if (!names.length) return ''
  if (names.length <= 3) return `${names.join('、')}正在输入…`
  return `${names.slice(0, 2).join('、')}等 ${names.length} 个机器人正在输入…`
})

function groupRoute(roomId = groups.selectedRoomId, topicId = groups.selectedTopicId): string {
  if (!roomId) return '/groups'
  const roomPath = `/groups/${encodeURIComponent(roomId)}`
  return groups.topicProtocol && topicId ? `${roomPath}/${encodeURIComponent(topicId)}` : roomPath
}

const roomActionMenuStyle = computed(() => roomActionMenu.value
  ? { left: `${roomActionMenu.value.x}px`, top: `${roomActionMenu.value.y}px` }
  : {})
const actionTopic = computed(() => {
  const action = roomActionMenu.value
  if (!action?.topicId) return undefined
  return groups.topicsForRoom(action.roomId).find(item => item.id === action.topicId)
    || groups.pinnedTopics.find(item => item.id === action.topicId)
})

function restoreShowThinking(profile = auth.activeProfile?.name || 'default') {
  showThinking.value = readAgentShowThinking(auth.user?.id ?? 'local', profile)
}

function toggleShowThinking() {
  showThinking.value = !showThinking.value
  writeAgentShowThinking(auth.user?.id ?? 'local', auth.activeProfile?.name || 'default', showThinking.value)
}

function stopActiveTopic() {
  for (const agentId of activeAgentIds.value) void groups.interruptAgent(agentId).catch(() => undefined)
}

async function selectRoom(id: string) {
  try { await groups.selectRoom(id) }
  catch { return }
  await router.push(groupRoute())
  quoted.value = null
}

async function selectTopic(id: string) {
  if (!id || id === groups.selectedTopicId) return
  try { await groups.selectTopic(id) }
  catch { return }
  await router.push(groupRoute())
  quoted.value = null
}

async function selectSidebarItem(id: string) {
  const topic = topicFromSidebarItemId(id)
  if (!topic) return
  if (topic.roomId !== groups.selectedRoomId) {
    try { await groups.selectRoom(topic.roomId, topic.topicId) }
    catch { return }
    await router.push(groupRoute())
    quoted.value = null
    return
  }
  await selectTopic(topic.topicId)
}

async function selectGroupSearchItem(id: string) {
  if (id === SEARCH_ARCHIVED_ID) {
    await openArchivedOverlay()
    return
  }
  if (id.startsWith(SEARCH_ARCHIVED_ROOM_PREFIX)) {
    await openArchivedOverlay(id.slice(SEARCH_ARCHIVED_ROOM_PREFIX.length))
    return
  }
  if (id.startsWith(SEARCH_ARCHIVED_TOPIC_PREFIX)) {
    const match = /^archived-topic:([^:]+):/.exec(id)
    await openArchivedOverlay(match?.[1])
    return
  }
  if (id.startsWith(SEARCH_ROOM_PREFIX)) {
    await selectRoom(id.slice(SEARCH_ROOM_PREFIX.length))
    return
  }
  await selectSidebarItem(id)
}

async function openSelectedRoomManager() {
  managerOpen.value = true
  try { await groups.refreshNodes() }
  catch { /* Keep the current node list when refreshing is unavailable. */ }
}

async function openCreateGroup() {
  try { await groups.refreshNodes() }
  catch { /* A node refresh must not prevent creating a local-only group. */ }
  createError.value = ''
  createOpen.value = true
}

function openRoomActions(roomId: string, event: MouseEvent) {
  const topic = topicFromSidebarItemId(roomId)
  const width = 174
  const height = topic ? 80 : 80
  const inset = 8
  if (topic) {
    topicActionRenaming.value = false
    topicActionRenameValue.value = groups.topicsForRoom(topic.roomId).find(item => item.id === topic.topicId)?.title
      || groups.pinnedTopics.find(item => item.id === topic.topicId)?.title
      || ''
    roomActionMenu.value = {
      roomId: topic.roomId,
      topicId: topic.topicId,
      x: Math.max(inset, Math.min(event.clientX, window.innerWidth - width - inset)),
      y: Math.max(inset, Math.min(event.clientY, window.innerHeight - height - inset)),
    }
    return
  }
  if (!groups.topicProtocol || !activeRooms.value.some(room => room.id === roomId)) return
  roomActionMenu.value = {
    roomId,
    x: Math.max(inset, Math.min(event.clientX, window.innerWidth - width - inset)),
    y: Math.max(inset, Math.min(event.clientY, window.innerHeight - height - inset)),
  }
}

function openTopicActions(roomId: string, topicId: string, event: MouseEvent) {
  openRoomActions(topicSidebarItemId(roomId, topicId), event)
}

function closeRoomActions() {
  roomActionMenu.value = null
  topicActionRenaming.value = false
  topicActionRenameValue.value = ''
}

function handleRoomActionPointer(event: PointerEvent) {
  if (!roomActionMenu.value || (event.target as HTMLElement).closest('.group-room-actions')) return
  closeRoomActions()
}

function handleRoomActionKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && roomActionMenu.value) closeRoomActions()
}

async function startTopicFromRoomAction() {
  const roomId = roomActionMenu.value?.roomId
  if (roomActionMenu.value?.topicId) return
  closeRoomActions()
  if (!roomId) return
  await startTopic(roomId)
}

async function startTopic(roomId: string) {
  try {
    await groups.selectRoom(roomId)
    const topicId = await groups.startNewTopic()
    if (!topicId) return
    await router.push(groupRoute(roomId, topicId))
    quoted.value = null
    await nextTick()
    composer.value?.focus()
  } catch { /* store publishes the error */ }
}

async function chooseTopicTeam(roomId: string) {
  topicTeamPickerOpen.value = false
  await startTopic(roomId)
}

async function createRoom(payload: { name: string; avatar?: string; members: Array<GroupProfileOption & { description?: string }>; autoReply: boolean; replyRounds: number; instructions?: string; hostProfile?: string; orchestrationMode?: 'free' | 'host' }) {
  const hostProfile = payload.hostProfile || payload.members[0]?.id
  createError.value = ''
  creatingRoom.value = true
  try {
    const detail = await groups.createRoom({
      name: payload.name,
      ...(groups.roomAvatarProtocol ? { avatar: payload.avatar ?? '' } : {}),
      ...(groups.roomInstructionsProtocol ? { instructions: payload.instructions ?? '' } : {}),
      agents: payload.members.map(member => ({
        profile: member.profile,
        nodeId: member.nodeId,
        nodeLabel: member.nodeLabel,
        displayName: member.displayName,
        description: member.description,
        replyWithoutMention: payload.autoReply,
        ...(groups.hostProtocol ? { isHost: member.id === hostProfile } : {}),
      })),
      maxReplyRounds: payload.replyRounds,
      ...(groups.hostFlowProtocol ? { orchestrationMode: payload.orchestrationMode ?? 'free' } : {}),
    })
    createOpen.value = false
    await router.push(groupRoute(detail.id, groups.selectedTopicId))
  } catch (cause) {
    createError.value = cause instanceof Error ? cause.message : '创建团队失败'
  } finally {
    creatingRoom.value = false
  }
}

async function send(payload: ComposerSubmit) {
  const prefix = quoted.value ? `> ${quoted.value.content.replace(/\n/g, '\n> ')}\n\n` : ''
  try {
    await groups.sendMessage(`${prefix}${payload.text}`, payload.mentionIds, payload.files)
    if (pushProtocolSupported.value && groups.selectedRoomId) {
      void loadPushSubscriptions()
    }
    quoted.value = null
    composer.value?.clearAfterSend()
  } catch { /* store publishes the error */ }
}

async function loadPushSubscriptions() {
  pushSubscriptionError.value = ''
  try {
    const capabilities = await getPushCapabilities()
    pushProtocolSupported.value = capabilities.protocolVersion === 1
    pushConfigured.value = capabilities.enabled
    subscribedPushRooms.value = pushProtocolSupported.value
      ? await getGroupPushSubscriptions()
      : new Set()
  } catch {
    // Older 15300 installations do not expose push capability. Keep group chat
    // fully functional and simply omit the subscription control.
    pushProtocolSupported.value = false
    pushConfigured.value = false
    subscribedPushRooms.value = new Set()
  }
}

async function toggleSelectedRoomPush() {
  const roomId = groups.selectedRoomId
  if (!roomId || !pushProtocolSupported.value || !pushConfigured.value || pushSubscriptionBusy.value) return
  pushSubscriptionBusy.value = true
  pushSubscriptionError.value = ''
  try {
    const enabled = await setGroupPushSubscription(roomId, !selectedRoomPushEnabled.value)
    const next = new Set(subscribedPushRooms.value)
    if (enabled) next.add(roomId)
    else next.delete(roomId)
    subscribedPushRooms.value = next
  } catch (cause) {
    pushSubscriptionError.value = cause instanceof Error ? cause.message : '无法更新团队推送设置'
  } finally {
    pushSubscriptionBusy.value = false
  }
}

async function updateRoom(patch: { name?: string; instructions?: string; avatar?: string; replyRounds?: number; orchestrationMode?: 'free' | 'host' }) {
  if (!groups.selectedRoom) return
  await groups.updateRoom(groups.selectedRoom.id, {
    name: patch.name,
    ...(groups.roomInstructionsProtocol ? { instructions: patch.instructions } : {}),
    ...(groups.roomAvatarProtocol ? { avatar: patch.avatar } : {}),
    maxReplyRounds: patch.replyRounds,
    ...(groups.hostFlowProtocol ? { orchestrationMode: patch.orchestrationMode } : {}),
  })
}

async function addAgent(profileID: string) {
  if (!groups.selectedRoom) return
  const member = profiles.value.find(profile => profile.id === profileID)
  if (!member) return
  await groups.addAgent(groups.selectedRoom.id, {
    profile: member.profile,
    nodeId: member.nodeId,
    nodeLabel: member.nodeLabel,
    displayName: member.displayName,
    replyWithoutMention: true,
    ...(groups.hostProtocol ? { isHost: false } : {}),
  })
}

type AgentSettingsPatch = Partial<Pick<GroupAgent,
  'displayName' | 'description' | 'enabled' | 'replyWithoutMention' | 'isHost' | 'model' | 'provider' | 'reasoningEffort' | 'fastMode'>>

async function loadAgentModels(profile: string) {
  if (modelOptionsLoading.value[profile] || Object.prototype.hasOwnProperty.call(modelOptionsByProfile.value, profile)) return
  modelOptionsLoading.value = { ...modelOptionsLoading.value, [profile]: true }
  modelOptionsError.value = { ...modelOptionsError.value, [profile]: '' }
  try {
    modelOptionsByProfile.value = { ...modelOptionsByProfile.value, [profile]: await getModels(profile) }
  } catch (cause) {
    modelOptionsError.value = { ...modelOptionsError.value, [profile]: cause instanceof Error ? cause.message : '模型选项加载失败' }
  } finally {
    modelOptionsLoading.value = { ...modelOptionsLoading.value, [profile]: false }
  }
}

async function updateAgent(id: string, patch: AgentSettingsPatch) {
  if (!groups.selectedRoom) return
  managerError.value = ''
  agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: true }
  agentUpdateError.value = { ...agentUpdateError.value, [id]: '' }
  try { await groups.updateAgent(groups.selectedRoom.id, id, patch) }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : '机器人设置保存失败'
    agentUpdateError.value = { ...agentUpdateError.value, [id]: message }
    managerError.value = message
  }
  finally { agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: false } }
}

async function removeAgent(id: string) {
  if (!groups.selectedRoom) return
  managerError.value = ''
  agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: true }
  try { await groups.removeAgent(groups.selectedRoom.id, id) }
  catch (cause) { managerError.value = cause instanceof Error ? cause.message : '移除机器人失败' }
  finally { agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: false } }
}

function clearAgentError(id: string) {
  if (!agentUpdateError.value[id]) return
  agentUpdateError.value = { ...agentUpdateError.value, [id]: '' }
  managerError.value = ''
}

async function archiveRoom() {
  if (!groups.selectedRoom) return
  await groups.archiveRoom(groups.selectedRoom.id)
  managerOpen.value = false
  await router.replace(groupRoute())
}

async function loadArchivedSearchCatalog() {
  if (archivedSearchLoading.value) return
  archivedSearchLoading.value = true
  try {
    const archivedRooms = await groups.archivedRooms()
    archivedRoomList.value = archivedRooms
    const roomIds = [...new Set([...activeRooms.value.map(room => room.id), ...archivedRooms.map(room => room.id)])]
    const topics = await Promise.all(roomIds.map(roomId => groups.archivedTopics(roomId).catch(() => [])))
    archivedTopicCatalog.value = topics.flat().sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
  } finally {
    archivedSearchLoading.value = false
  }
}

async function openArchivedOverlay(roomId = groups.selectedRoomId) {
  archivedOverlayOpen.value = true
  await loadArchivedSearchCatalog()
  archivedTopicRoomId.value = roomId || ''
  archivedTopicList.value = roomId
    ? await groups.archivedTopics(roomId)
    : []
}

async function restoreArchivedRoom(roomId: string) {
  await groups.restoreRoom(roomId)
  await loadArchivedSearchCatalog()
}

async function archiveTopicFromAction() {
  const action = roomActionMenu.value
  closeRoomActions()
  if (!action?.topicId) return
  await groups.archiveTopic(action.roomId, action.topicId)
}

async function toggleTopicPinnedFromAction() {
  const action = roomActionMenu.value
  const topic = actionTopic.value
  closeRoomActions()
  if (!action?.topicId) return
  await groups.setTopicPinned(action.roomId, action.topicId, !topic?.pinned)
}

async function renameTopicFromAction() {
  const action = roomActionMenu.value
  const title = topicActionRenameValue.value.trim()
  if (!action?.topicId || !title) return
  await groups.renameTopic(action.roomId, action.topicId, title)
  closeRoomActions()
}

async function archiveRoomFromAction() {
  const action = roomActionMenu.value
  closeRoomActions()
  if (!action || action.topicId) return
  await groups.archiveRoom(action.roomId)
  if (route.params.roomId === action.roomId) await router.replace(groupRoute())
}

async function restoreArchivedTopic(topicId: string) {
  const roomId = archivedTopicRoomId.value
  if (!roomId) return
  await groups.restoreTopic(roomId, topicId)
  archivedTopicList.value = await groups.archivedTopics(roomId)
  await loadArchivedSearchCatalog()
}

function openLocalFile({ name, url }: { name: string; url: string }) {
  const item = previewItemFromUrl(name, url)
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else preview.value = item
}

function openMedia(item: UiLibraryItem) {
  const target = mediaUrlIdentity(item.previewUrl || item.downloadUrl || '')
  const index = lightboxMedia.value.findIndex(media => mediaUrlIdentity(media.url) === target)
  mediaPreviewIndex.value = index >= 0 ? index : null
}

function openAttachment(attachment: NonNullable<UiMessage['attachments']>[number]) {
  const item = previewItemFromUrl(attachment.name, attachment.url || '', attachment.id, attachment.kind)
  item.size = attachment.size
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else preview.value = item
}

async function addPreviewToComposer(item: UiLibraryItem) {
  if (!uploadsEnabled.value) return
  const file = await loadComposerFile(item)
  if (!file || !composer.value) return
  composer.value.attachFiles([file])
  preview.value = null
  mediaPreviewIndex.value = null
  await nextTick()
  composer.value?.focus()
}

async function addMediaToComposer(media: PreviewMedia) {
  await addPreviewToComposer(previewItemFromUrl(media.name, media.url, `preview:${media.url}`, media.type))
}

onMounted(async () => {
  document.addEventListener('pointerdown', handleRoomActionPointer)
  document.addEventListener('keydown', handleRoomActionKey)
  window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, handleModelCatalogChanged)
  restoreShowThinking()
  void loadPushSubscriptions()
  try {
    await groups.start()
    if (groups.topicProtocol) {
      await Promise.all(activeRooms.value.map(room => groups.loadRoomTopics(room.id).catch(() => undefined)))
    }
    void loadArchivedSearchCatalog()
    const requested = typeof route.params.roomId === 'string' ? route.params.roomId : ''
    const requestedTopic = typeof route.params.topicId === 'string' ? route.params.topicId : undefined
    if (requested) {
      try {
        await groups.selectRoom(requested, requestedTopic)
      }
      catch {
        if (groups.selectedRoomId) await router.replace(groupRoute())
        return
      }
    }
    if (groups.selectedRoomId) {
      if (route.fullPath !== groupRoute()) await router.replace(groupRoute())
    }
  } catch { /* availability state renders the error */ }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleRoomActionPointer)
  document.removeEventListener('keydown', handleRoomActionKey)
  window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, handleModelCatalogChanged)
  groups.stop()
})

watch(() => [route.params.roomId, route.params.topicId] as const, async ([roomValue, topicValue]) => {
  const roomId = typeof roomValue === 'string' ? roomValue : ''
  const topicId = typeof topicValue === 'string' ? topicValue : undefined
  if (!roomId) return
  if (roomId && (roomId !== groups.selectedRoomId || (groups.topicProtocol && topicId && topicId !== groups.selectedTopicId))) {
    try {
      await groups.selectRoom(roomId, topicId)
    }
    catch { if (groups.selectedRoomId && route.fullPath !== groupRoute()) await router.replace(groupRoute()) }
  }
})
watch(() => groups.selectedRoomId, () => {
  managerError.value = ''
  agentUpdateError.value = {}
})
watch(() => auth.activeProfile?.name, profile => { if (profile) restoreShowThinking(profile) })
</script>

<template>
  <WorkspaceView sidebar-title="话题" :sidebar-subtitle="sidebarSubtitle" :inspector-open="managerOpen && !!room" inspector-close-label="关闭团队管理" @close-inspector="managerOpen = false">
    <template #sidebar-action>
      <button class="sidebar-primary-action" type="button" :disabled="groups.availability !== 'available' || !groups.topicProtocol || !activeRooms.length" title="新建话题" aria-label="新建话题" @click="topicTeamPickerOpen = true">
        <AppIcon name="topic" :size="18" />
        <span>新建话题</span>
      </button>
      <button class="sidebar-primary-action" type="button" :disabled="groups.availability !== 'available'" title="新建团队" aria-label="新建团队" @click="openCreateGroup">
        <YaoYaoSidebarIcon name="add" />
        <span>新建团队</span>
      </button>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :items="sidebarItems"
        :active-id="groups.selectedRoomId && groups.selectedTopicId ? topicSidebarItemId(groups.selectedRoomId, groups.selectedTopicId) : ''"
        :loading="groups.isLoading"
        external-search
        search-placeholder="搜索话题"
        empty-title="还没有话题"
        empty-description="点击新建话题，选择一个团队开始协作。"
        @select="selectSidebarItem"
        @more="openRoomActions"
        @context-menu="openRoomActions"
      />
    </template>

    <div v-if="groups.availability === 'unsupported' || groups.availability === 'unavailable'" class="groups-unavailable">
      <EmptyState icon="alert" :title="groups.availability === 'unsupported' ? '团队协议版本不兼容' : '团队服务暂不可用'" :description="groups.error || '请检查团队服务连接后重试。'" action-label="重新检查" @action="groups.refresh" />
    </div>
    <div v-else class="groups-workspace">
      <MessageTimeline
        :messages="messages"
        :title="groups.topicProtocol ? (groups.selectedTopic?.title || '新话题') : (groups.selectedRoom?.name || '团队')"
        :subtitle="roomSubtitle"
        :loading="groups.isLoading"
        :has-older="groups.hasMoreBefore"
        :connected="connected"
        :synced="synced"
        :show-tools="showThinking"
        :interaction="activeInteraction"
        :mention-names="mentionNames"
        :agent-avatars="agentAvatars"
        :empty-title="groups.topicProtocol ? '开始一个新话题' : '让多个机器人一起工作'"
        :empty-description="groups.topicProtocol ? '第一条消息会创建独立话题，各话题分别保留机器人上下文。' : '使用 @ 提及指定机器人，或直接发送消息触发已启用自动回复的成员。'"
        @load-older="groups.loadOlder"
        @quote="quoted = $event"
        @preview="openAttachment"
        @preview-file="openLocalFile"
        @approve="activeInteraction && groups.approveInteraction(activeInteraction.id, $event ? 'once' : 'deny')"
        @clarify="activeInteraction && groups.clarifyInteraction(activeInteraction.id, $event)"
      >
        <template #header-actions>
          <div class="group-header-actions">
            <span v-if="hostAgent" class="group-host-chip" :title="`用户未明确 @ 时由管理员 ${hostAgent.displayName || hostAgent.profile} 负责回应`">管理员 {{ hostAgent.displayName || hostAgent.profile }}</span>
            <div class="group-avatars" aria-label="团队成员"><AgentAvatar v-for="agent in agents.slice(0, 4)" :key="agent.id" :name="agent.name" :avatar="agentAvatars[agent.nodeId === 'local' ? agent.profile || '' : `node:${agent.nodeId}:${agent.profile}`] || ''" :size="24" :title="agent.isHost ? `${agent.name} · 管理员` : agent.name" /><em v-if="agents.length > 4">+{{ agents.length - 4 }}</em></div>
            <button v-if="pushProtocolSupported" class="icon-button group-push-button" :class="{ active: selectedRoomPushEnabled }" type="button" :title="!pushConfigured ? '服务器尚未配置 iOS 推送' : selectedRoomPushEnabled ? '关闭该团队的 iOS 推送' : '开启该团队的 iOS 推送'" :aria-label="selectedRoomPushEnabled ? '关闭团队推送' : '开启团队推送'" :disabled="!groups.selectedRoom || !pushConfigured || pushSubscriptionBusy" @click="toggleSelectedRoomPush"><AppIcon name="bell" /></button>
            <button class="icon-button" type="button" title="管理团队" aria-label="管理团队" :disabled="!groups.selectedRoom" @click="openSelectedRoomManager"><AppIcon name="dots" /></button>
          </div>
        </template>
      </MessageTimeline>
      <p v-if="groups.error || pushSubscriptionError" class="group-error" role="alert"><AppIcon name="alert" :size="13" />{{ groups.error || pushSubscriptionError }}</p>
      <ComposerShell
        ref="composer"
        mode="group"
        :draft-key="`${auth.user?.id || 'local'}:${groups.selectedRoomId || 'new'}:${groups.selectedTopicId || 'legacy'}`"
        :disabled="!groups.selectedRoom || groups.availability !== 'available'"
        :streaming="activeAgentIds.size > 0"
        :sending="groups.isSending"
        :activity-text="typingActivity"
        :tool-trace-visible="showThinking"
        :reference="reference"
        :mention-options="mentionOptions"
        :attachments-enabled="uploadsEnabled"
        placeholder="发消息给团队，输入 @ 提及机器人"
        @send="send"
        @stop="stopActiveTopic"
        @tool-trace-toggle="toggleShowThinking"
        @clear-reference="quoted = null"
      />
    </div>

    <template #inspector>
      <GroupManager
        v-if="room && groups.selectedRoom"
        :room="room"
        :agents="displayAgents"
        :host-enabled="groups.hostProtocol"
        :host-flow-enabled="groups.hostFlowProtocol"
        :room-instructions-enabled="groups.roomInstructionsProtocol"
        :avatar-enabled="groups.roomAvatarProtocol"
        :available-profiles="availableProfiles"
        :busy="managerBusy"
        :model-options-by-profile="modelOptionsByProfile"
        :model-options-loading="modelOptionsLoading"
        :model-options-error="modelOptionsError"
        :remote-server-addresses="remoteServerAddresses"
        :agent-update-error="agentUpdateError"
        :agent-avatars="agentAvatars"
        :manager-error="managerError"
        @update-room="updateRoom"
        @add-agent="addAgent"
        @load-models="loadAgentModels"
        @clear-agent-error="clearAgentError"
        @update-agent="updateAgent"
        @remove-agent="removeAgent"
        @interrupt-agent="groups.interruptAgent($event, groups.selectedRoom.id)"
        @archive-room="archiveRoom"
      />
    </template>
  </WorkspaceView>

  <FloatingResourceSearch section="groups" label="搜索话题、团队或归档" :items="groupSearchItems" split @open="loadArchivedSearchCatalog" @select="selectGroupSearchItem" />
  <TopicTeamPickerDialog :open="topicTeamPickerOpen" :rooms="activeRooms" :current-room-id="groups.selectedRoomId" @close="topicTeamPickerOpen = false" @select="chooseTopicTeam" />
  <CreateGroupDialog :open="createOpen" :profiles="profiles" :avatar-enabled="groups.roomAvatarProtocol" :host-enabled="groups.hostProtocol" :host-flow-enabled="groups.hostFlowProtocol" :room-instructions-enabled="groups.roomInstructionsProtocol" :error="createError" :busy="groups.isLoading || creatingRoom" @close="createOpen = false" @create="createRoom" />
  <PreviewModal v-if="preview" :item="preview" :items="conversationMediaItems" @close="preview = null" @add-to-composer="addPreviewToComposer" @source="preview = null" />
  <ImagePreviewLightbox v-model="mediaPreviewIndex" :images="lightboxMedia" :can-add="uploadsEnabled" @add="addMediaToComposer" />

  <Teleport to="body">
    <Transition name="group-menu">
      <section v-if="roomActionMenu" class="group-room-actions" :style="roomActionMenuStyle" role="menu" aria-label="团队操作" @contextmenu.prevent>
        <template v-if="roomActionMenu.topicId">
          <template v-if="topicActionRenaming">
            <label class="group-topic-rename">话题名称<input v-model="topicActionRenameValue" maxlength="120" autofocus @keydown.enter="renameTopicFromAction" /></label>
            <div class="group-topic-rename__actions"><button class="quiet-button" type="button" @click="topicActionRenaming = false">取消</button><button class="solid-button" type="button" @click="renameTopicFromAction">保存</button></div>
          </template>
          <template v-else>
            <button class="group-action-row" role="menuitem" type="button" @click="toggleTopicPinnedFromAction"><AppIcon :name="actionTopic?.pinned ? 'pin-off' : 'pin'" :size="14" />{{ actionTopic?.pinned ? '取消置顶' : '置顶话题' }}</button>
            <button class="group-action-row" role="menuitem" type="button" @click="topicActionRenaming = true"><AppIcon name="edit" :size="14" />重命名</button>
            <button class="group-action-row danger" role="menuitem" type="button" @click="archiveTopicFromAction"><AppIcon name="archive" :size="14" />归档话题</button>
          </template>
        </template>
        <template v-else>
          <button class="group-action-row" role="menuitem" type="button" @click="startTopicFromRoomAction"><AppIcon name="plus" :size="14" />新建话题</button>
          <button class="group-action-row danger" role="menuitem" type="button" @click="archiveRoomFromAction"><AppIcon name="archive" :size="14" />归档团队</button>
        </template>
      </section>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="group-menu">
      <div v-if="archivedOverlayOpen" class="archived-overlay-backdrop" role="presentation" @click.self="archivedOverlayOpen = false">
        <section class="archived-overlay" role="dialog" aria-modal="true" aria-label="已归档团队和话题">
          <header><div><small>团队归档</small><strong>已归档内容</strong></div><button type="button" aria-label="关闭" @click="archivedOverlayOpen = false"><AppIcon name="close" :size="16" /></button></header>
          <section class="archived-section"><h3>团队</h3><p v-if="!archivedRoomList.length">没有已归档团队</p><article v-for="archived in archivedRoomList" :key="archived.id"><span>{{ archived.name }}</span><button type="button" @click="restoreArchivedRoom(archived.id)">恢复</button></article></section>
          <section class="archived-section"><h3>{{ archivedTopicRoomName }}的话题</h3><p v-if="!archivedTopicRoomId">请先选择一个团队查看其已归档话题</p><p v-else-if="!archivedTopicList.length">没有已归档话题</p><article v-for="topic in archivedTopicList" :key="topic.id"><span>{{ topic.title }}</span><button type="button" @click="restoreArchivedTopic(topic.id)">恢复</button></article></section>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.groups-workspace, .groups-unavailable { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; background: var(--conversation-canvas); }.groups-unavailable { overflow: auto; }
.group-room-actions { position: fixed; z-index: 205; width: 174px; box-sizing: border-box; padding: 6px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-raised); box-shadow: 0 12px 34px rgba(0,0,0,.16); }
.group-action-row { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; text-align: left; }.group-action-row:hover, .group-action-row:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }
.group-action-row.danger:hover, .group-action-row.danger:focus-visible { color: var(--danger); }
.group-topic-rename { display: grid; gap: 6px; padding: 6px 8px; color: var(--text-secondary); font-size: 10px; }.group-topic-rename input { width: 100%; min-height: 30px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font: inherit; }.group-topic-rename input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.group-topic-rename__actions { display: flex; justify-content: flex-end; gap: 6px; padding: 2px 8px 5px; }.group-topic-rename__actions button { min-height: 28px; padding: 0 8px; font-size: 10px; }
.group-menu-enter-active, .group-menu-leave-active { transition: opacity 100ms ease, transform 120ms var(--ease-out); transform-origin: top right; }.group-menu-enter-from, .group-menu-leave-to { opacity: 0; transform: translateY(-3px) scale(.98); }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action:disabled { cursor: not-allowed; opacity: .35; }
.archived-overlay-backdrop { position: fixed; z-index: 220; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.36); }.archived-overlay { width: min(460px, 100%); max-height: min(620px, calc(100vh - 40px)); overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: 0 24px 70px rgba(0,0,0,.28); }.archived-overlay header { display: flex; align-items: center; justify-content: space-between; padding: 18px 18px 14px; border-bottom: 1px solid var(--line); }.archived-overlay header small { display: block; color: var(--text-secondary); font-size: 10px; }.archived-overlay header strong { font-size: 15px; }.archived-overlay header button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }.archived-section { display: grid; gap: 8px; padding: 16px 18px; }.archived-section + .archived-section { border-top: 1px solid var(--line); }.archived-section h3 { margin: 0; font-size: 12px; }.archived-section p { margin: 0; color: var(--text-secondary); font-size: 12px; }.archived-section article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; }.archived-section article span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.archived-section article button { border: 0; border-radius: 7px; background: var(--surface-hover); color: var(--text-primary); cursor: pointer; padding: 5px 9px; }
.group-header-actions { display: flex; align-items: center; gap: 8px; }.group-host-chip { max-width: 150px; overflow: hidden; padding: 4px 7px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); font-size: 9px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.group-push-button.active { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }.group-avatars { display: flex; align-items: center; }.group-avatars span, .group-avatars em { display: grid; width: 24px; height: 24px; margin-left: -5px; place-items: center; border: 2px solid var(--canvas); border-radius: 8px; font-size: 8px; font-style: normal; font-weight: 650; }.group-avatars span { background: transparent; color: var(--text-secondary); }.group-avatars span:first-child { margin-left: 0; }.group-avatars em { background: var(--surface-hover); color: var(--text-secondary); }
.group-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
@media (max-width: 480px) { .group-avatars, .group-host-chip { display: none; } }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action, .group-menu-enter-active, .group-menu-leave-active { transition: none; } }
</style>
