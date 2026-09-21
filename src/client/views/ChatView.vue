<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import type { ChoiceOption } from '@/components/common/types'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import ModelChoiceDialog from '@/components/composer/ModelChoiceDialog.vue'
import type { ComposerOption, ComposerReference, ComposerSubmit } from '@/components/composer/types'
import PreviewInspector from '@/components/library/PreviewInspector.vue'
import PreviewModal from '@/components/library/PreviewModal.vue'
import ImagePreviewLightbox from '@/components/library/ImagePreviewLightbox.vue'
import type { PreviewMedia } from '@/components/library/ImagePreviewLightbox.vue'
import type { UiLibraryItem } from '@/components/library/types'
import { mediaItemsFromMessages, mediaUrlIdentity, previewItemFromUrl } from '@/components/library/mediaSequence'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import SessionOutline from '@/components/messages/SessionOutline.vue'
import type { UiMessage } from '@/components/messages/types'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import FloatingResourceSearch from '@/components/app/FloatingResourceSearch.vue'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { chatInteraction, chatMessagesToUi, sessionSidebarItem } from '@/components/workspace/viewModels'
import { consumeLibraryItemForComposer, loadComposerFile } from '@/components/workspace/pendingComposer'
import { readAgentShowThinking, writeAgentShowThinking } from '@/utils/sessionPreferences'
import { modelChoiceId, modelForChoiceId } from '@/utils/sessionModel'
import { MODEL_CATALOG_CHANGED_EVENT, modelCatalogChangedProfile } from '@/utils/modelCatalogEvents'
import { estimateConversationTokens } from '@/utils/contextUsage'
import { isOwnedChatSession } from '@/utils/sessionOwnership'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { getSession } from '@/api/sessions'

const auth = useAuthStore()
const chat = useChatStore()
const route = useRoute()
const router = useRouter()
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const filePreview = ref<UiLibraryItem | null>(null)
const mediaPreviewIndex = ref<number | null>(null)
const outlineOpen = ref(false)
const modelDialog = ref(false)
const modelSwitching = ref(false)
const showThinking = ref(false)
const queueMode = ref(false)
const actionSessionId = ref('')
const renaming = ref(false)
const renameValue = ref('')
const actionMenuPosition = ref({ x: 8, y: 8 })
const composer = ref<InstanceType<typeof ComposerShell> | null>(null)
const timeline = ref<InstanceType<typeof MessageTimeline> | null>(null)
const headerSessionMenuButton = ref<HTMLButtonElement | null>(null)
const restoringRouteProfile = ref('')

function handleModelCatalogChanged(event: Event) {
  const profile = modelCatalogChangedProfile(event)
  if (profile && profile === auth.activeProfile?.name) void chat.loadModels(profile).catch(() => undefined)
}

const sessions = computed(() => [...chat.sessions]
  .filter(isOwnedChatSession))
const agentNames = computed(() => new Map(auth.profiles.map(profile => [
  profile.name,
  profile.agentName || profile.displayName || profile.name,
])))
const agentAvatars = computed(() => Object.fromEntries(auth.profiles.flatMap(profile =>
  profile.agentAvatar ? [[profile.name, profile.agentAvatar] as const] : []
)))
const sidebarItems = computed(() => sessions.value.map(session => sessionSidebarItem(
  session,
  chat.unreadCounts[session.id] ?? 0,
  agentNames.value.get(session.profile || auth.activeProfile?.name || ''),
)))
const messages = computed(() => chatMessagesToUi(chat.messages, profile => profile ? agentNames.value.get(profile) : undefined))
const reportedContextTokens = computed(() => chat.contextUsage?.contextTokens
  || chat.contextUsage?.totalTokens
  || (activeSession.value?.inputTokens ?? 0) + (activeSession.value?.outputTokens ?? 0))
const estimatedContextTokens = computed(() => estimateConversationTokens(chat.messages))
const contextUsed = computed(() => reportedContextTokens.value || estimatedContextTokens.value)
const contextIsEstimated = computed(() => !reportedContextTokens.value && contextUsed.value > 0)
const conversationMediaItems = computed(() => mediaItemsFromMessages(messages.value))
const lightboxMedia = computed(() => conversationMediaItems.value.map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const activeSession = computed(() => chat.activeSession)
const actionSession = computed(() => chat.sessions.find(session => session.id === actionSessionId.value))
const connected = computed(() => ['connected', 'ready'].includes(chat.connectionState))
const interaction = computed(() => chatInteraction(chat.pendingApproval, chat.pendingClarification))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, content: quoted.value.content, author: quoted.value.author } : null)
const forkSourceTitle = computed(() => {
  const parentId = activeSession.value?.parentSessionId
  if (!parentId) return ''
  return chat.sessions.find(session => session.id === parentId && session.profile === activeSession.value?.profile)?.title || parentId
})
const selectedModelId = computed(() => chat.selectedModel ? modelChoiceId(chat.selectedModel) : '')
const reasoningOptions: ChoiceOption[] = [
  { id: '', label: '默认', description: '使用模型或 Profile 的默认强度' },
  { id: 'none', label: '关闭', description: '不使用额外推理' },
  { id: 'low', label: '低', description: '更快的轻量推理' },
  { id: 'medium', label: '中', description: '速度与深度平衡' },
  { id: 'high', label: '高', description: '更深入地分析复杂问题' },
  { id: 'xhigh', label: '极高', description: '适用于最复杂的任务' },
]
const reasoningComposerOptions = computed<ComposerOption[]>(() => reasoningOptions.map(option => ({
  id: option.id,
  label: option.label,
  detail: option.description,
})))
const reasoningLabel = computed(() => reasoningOptions.find(option => option.id === (chat.reasoningEffort || ''))?.label || '默认')
const actionMenuStyle = computed(() => ({ left: `${actionMenuPosition.value.x}px`, top: `${actionMenuPosition.value.y}px` }))

function routeProfile(): string {
  const value = typeof route.query.profile === 'string' ? route.query.profile : ''
  return auth.profiles.some(profile => profile.name === value) ? value : ''
}

function sessionLocation(id: string, profile: string) {
  return { path: `/chat/${encodeURIComponent(id)}`, query: { profile } }
}

async function findLegacySessionProfile(sessionId: string): Promise<string> {
  for (const profile of auth.profiles) {
    try {
      const session = await getSession(sessionId, profile.name)
      if (session.id === sessionId) return profile.name
    } catch { /* Try the next profile: 9119 returns 404 for a foreign session. */ }
  }
  return auth.activeProfile?.name || ''
}

async function ensureRouteProfile(profile: string): Promise<void> {
  if (!profile || auth.activeProfile?.name === profile) return
  chat.switchProfile(profile)
  restoringRouteProfile.value = profile
  auth.selectProfile(profile)
  await nextTick()
}

async function refreshSessions() {
  const requestedId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  const profile = routeProfile() || (requestedId ? await findLegacySessionProfile(requestedId) : auth.activeProfile?.name || '')
  if (profile && auth.activeProfile?.name !== profile) {
    if (requestedId) await router.replace(sessionLocation(requestedId, profile))
    await ensureRouteProfile(profile)
  }
  // The session route is the authoritative navigation target. A secondary
  // unread-count request must never prevent its history from being restored.
  await chat.loadSessions(profile, 'chat')
  if (requestedId) {
    const target = await getSession(requestedId, profile).catch(() => undefined)
    if (target && !isOwnedChatSession(target)) {
      await router.replace({ path: `/history/${encodeURIComponent(requestedId)}`, query: { profile } })
      return
    }
  }
  if (requestedId && chat.activeSessionId !== requestedId) await chat.selectSession(requestedId, profile)
  if (requestedId && profile && routeProfile() !== profile) await router.replace(sessionLocation(requestedId, profile))
  void chat.loadUnread(profile).catch(() => undefined)
  if (!requestedId && chat.activeSession && !isOwnedChatSession(chat.activeSession)) {
    chat.clearSelection()
  }
}

async function chooseSession(id: string) {
  outlineOpen.value = false
  preview.value = null
  const session = chat.sessions.find(item => item.id === id)
  const profile = session?.profile || auth.activeProfile?.name || 'default'
  await router.push(sessionLocation(id, profile))
  await ensureRouteProfile(profile)
    if (chat.activeProfileName !== profile) await chat.loadSessions(profile, 'chat')
  await chat.selectSession(id, profile)
  await chat.markRead(id, profile).catch(() => undefined)
  quoted.value = null
}

async function createSession() {
  outlineOpen.value = false
  preview.value = null
  const id = chat.createSession(auth.activeProfile?.name)
  await router.push(sessionLocation(id, auth.activeProfile?.name || 'default'))
}

async function send(payload: ComposerSubmit) {
  try {
    await chat.send(payload.text, payload.files, queueMode.value ? 'queue' : chat.isStreaming ? 'steer' : 'submit')
    composer.value?.clearAfterSend()
  } catch { /* store exposes the error and the composer keeps its draft */ }
}

function openAttachment(attachment: NonNullable<UiMessage['attachments']>[number]) {
  const item = previewItemFromUrl(attachment.name, attachment.url || '', attachment.id, attachment.kind)
  item.size = attachment.size
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else { outlineOpen.value = false; preview.value = null; filePreview.value = item }
}

function openMedia(item: UiLibraryItem) {
  const target = mediaUrlIdentity(item.previewUrl || item.downloadUrl || '')
  const index = lightboxMedia.value.findIndex(media => mediaUrlIdentity(media.url) === target)
  mediaPreviewIndex.value = index >= 0 ? index : null
}

function openLocalFile({ name, url }: { name: string; url: string }) {
  const item = previewItemFromUrl(name, url)
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else { outlineOpen.value = false; filePreview.value = item }
}

async function addPreviewToComposer(item: UiLibraryItem) {
  const file = await loadComposerFile(item)
  if (!file || !composer.value) return
  composer.value.attachFiles([file])
  preview.value = null
  filePreview.value = null
  mediaPreviewIndex.value = null
  await nextTick()
  composer.value?.focus()
}

async function addMediaToComposer(media: PreviewMedia) {
  await addPreviewToComposer(previewItemFromUrl(media.name, media.url, `preview:${media.url}`, media.type))
}

async function selectModel(id: string) {
  if (id === selectedModelId.value) {
    modelDialog.value = false
    return
  }
  const model = modelForChoiceId(chat.models, id)
  if (!model || modelSwitching.value) return
  modelSwitching.value = true
  try {
    await chat.setModel(model)
    modelDialog.value = false
  } finally {
    modelSwitching.value = false
  }
}

function selectReasoning(id: string) {
  chat.reasoningEffort = id || undefined
}

async function toggleFastMode(enabled: boolean) {
  try { await chat.setFastMode(enabled) } catch { /* store restores the acknowledged state */ }
}

function restoreShowThinking(profile = auth.activeProfile?.name || 'default') {
  showThinking.value = readAgentShowThinking(auth.user?.id ?? 'local', profile)
}

function toggleShowThinking() {
  showThinking.value = !showThinking.value
  writeAgentShowThinking(auth.user?.id ?? 'local', auth.activeProfile?.name || 'default', showThinking.value)
}

function openSessionActions(id: string, event?: MouseEvent) {
  actionSessionId.value = id
  const session = chat.sessions.find(item => item.id === id)
  renameValue.value = session?.title || ''
  renaming.value = false
  const menuWidth = 208
  const menuHeight = 210
  const inset = 8
  const anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null
  const requestedX = event?.type === 'contextmenu' ? event.clientX : anchor ? anchor.right - menuWidth : window.innerWidth - menuWidth - 14
  const requestedY = event?.type === 'contextmenu' ? event.clientY : anchor ? anchor.bottom + 5 : 46
  actionMenuPosition.value = {
    x: Math.max(inset, Math.min(requestedX, window.innerWidth - menuWidth - inset)),
    y: Math.max(inset, Math.min(requestedY, window.innerHeight - menuHeight - inset)),
  }
}

function closeSessionActions() {
  actionSessionId.value = ''
  renaming.value = false
}

async function forceRefreshHistory() {
  closeSessionActions()
  try { await chat.forceRefreshHistory() }
  catch { /* The chat store displays the refresh error without clearing messages. */ }
}

function handleSessionActionPointer(event: PointerEvent) {
  if (!actionSessionId.value || (event.target as HTMLElement).closest('.session-actions')) return
  closeSessionActions()
}

function handleSessionActionKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && actionSessionId.value) closeSessionActions()
}

async function saveRename() {
  const session = chat.sessions.find(item => item.id === actionSessionId.value)
  if (!session || !renameValue.value.trim()) return
  await chat.renameSession(session.id, renameValue.value.trim(), session.profile)
  closeSessionActions()
}

async function toggleSessionPinned() {
  const session = actionSession.value
  if (!session) return
  await chat.setSessionPinned(session.id, !session.pinned, session.profile)
  closeSessionActions()
}

async function openSessionOutline() {
  const session = actionSession.value
  if (!session) return
  closeSessionActions()
  if (session.id !== chat.activeSessionId || session.profile !== chat.activeProfileName) await chooseSession(session.id)
  preview.value = null
  outlineOpen.value = true
}

function closeInspector() {
  const restoreMenuFocus = outlineOpen.value
  preview.value = null
  outlineOpen.value = false
  if (restoreMenuFocus) void nextTick(() => headerSessionMenuButton.value?.focus())
}

function navigateOutline(target: { messageId: string; anchorId: string }) {
  timeline.value?.scrollToAnchor(target.messageId, target.anchorId)
  if (window.matchMedia('(max-width: 900px)').matches) closeInspector()
}

async function deleteSession() {
  const session = chat.sessions.find(item => item.id === actionSessionId.value)
  if (!session) return
  await chat.removeSession(session.id, session.profile)
  closeSessionActions()
  if (route.params.sessionId === session.id) await router.replace('/chat')
}

async function branch() {
  const id = await chat.branchSession()
  if (id) await router.push(sessionLocation(id, chat.activeProfileName || auth.activeProfile?.name || 'default'))
}

async function revealSourceMessage() {
  const messageId = typeof route.query.message === 'string' ? route.query.message : ''
  if (!messageId) return
  await nextTick()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (timeline.value?.scrollToMessage(messageId)) return
    if (!chat.hasMoreBefore) return
    await chat.loadOlder()
    await nextTick()
  }
}

onMounted(async () => {
  restoreShowThinking()
  document.addEventListener('pointerdown', handleSessionActionPointer)
  document.addEventListener('keydown', handleSessionActionKey)
  window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, handleModelCatalogChanged)
  await refreshSessions()
  await Promise.allSettled([chat.loadModels(auth.activeProfile?.name), chat.connect()])
  void chat.refreshActiveSessionModel().catch(() => undefined)
  await revealSourceMessage()
  const pendingFile = await consumeLibraryItemForComposer()
  if (pendingFile) composer.value?.attachFiles([pendingFile])
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleSessionActionPointer)
  document.removeEventListener('keydown', handleSessionActionKey)
  window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, handleModelCatalogChanged)
})

watch(() => auth.activeProfile?.name, async (profile, previous) => {
  if (!profile || profile === previous) return
  restoreShowThinking(profile)
  outlineOpen.value = false
  preview.value = null
  if (restoringRouteProfile.value === profile) {
    restoringRouteProfile.value = ''
    return
  }
  chat.switchProfile(profile)
  const requestedId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  if (requestedId && routeProfile() === profile) {
    await Promise.allSettled([chat.loadSessions(profile, 'chat'), chat.loadModels(profile), chat.loadUnread(profile), chat.connect()])
    await chat.selectSession(requestedId, profile)
    return
  }
  await router.replace({ path: '/chat', query: { profile } })
  await Promise.allSettled([chat.loadSessions(profile, 'chat'), chat.loadModels(profile), chat.loadUnread(profile), chat.connect()])
})

watch(() => chat.activeSessionId, async id => {
  const profile = chat.activeProfileName || auth.activeProfile?.name || ''
  if (id) void chat.refreshActiveSessionModel().catch(() => undefined)
  if (!id || (route.params.sessionId === id && routeProfile() === profile)) return
  await router.replace(sessionLocation(id, profile))
})
</script>

<template>
  <WorkspaceView sidebar-title="对话" :sidebar-subtitle="`${sessions.length} 个会话`" :inspector-open="!!preview || outlineOpen" :inspector-close-label="outlineOpen ? '关闭会话大纲' : '关闭预览'" @close-inspector="closeInspector">
    <template #sidebar-action>
      <button class="sidebar-primary-action" type="button" title="新建聊天" aria-label="新建聊天" @click="createSession">
        <YaoYaoSidebarIcon name="add" />
        <span>新建聊天</span>
      </button>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :items="sidebarItems"
        :active-id="chat.activeSessionId"
        :loading="chat.isLoading"
        external-search
        single-line
        :has-more="chat.hasMoreSessions"
        :loading-more="chat.isLoadingMoreSessions"
        search-placeholder="搜索会话"
        empty-title="还没有会话"
        empty-description="新建会话后，从输入框开始聊天。"
        @load-more="chat.loadMoreSessions(auth.activeProfile?.name)"
        @select="chooseSession"
        @more="openSessionActions"
        @context-menu="openSessionActions"
      />
    </template>

    <div class="chat-workspace">
      <MessageTimeline
        ref="timeline"
        :messages="messages"
        :title="activeSession?.title || '新会话'"
        :subtitle="activeSession ? `${activeSession.profile || auth.activeProfile?.name || ''} · ${activeSession.model || chat.selectedModel?.name || '默认模型'}` : '选择会话或直接开始输入'"
        :loading="chat.activeRouteState?.isLoadingHistory"
        :loading-older="chat.activeRouteState?.isLoadingHistory"
        :has-older="chat.hasMoreBefore"
        :connected="connected"
        :synced="chat.historySynced"
        :show-tools="showThinking"
        :thinking="chat.isSending || chat.isStreaming"
        :show-assistant-identity="false"
        :agent-avatars="agentAvatars"
        :interaction="interaction"
        empty-logo
        transparent-header
        :fork-source-title="forkSourceTitle"
        @load-older="chat.loadOlder"
        @quote="quoted = $event"
        @branch="branch"
        @preview="openAttachment"
        @preview-file="openLocalFile"
        @approve="interaction && chat.respondToApproval(interaction.id, $event)"
        @clarify="interaction && chat.respondToClarification(interaction.id, $event)"
      >
        <template #header-actions>
          <button v-if="activeSession" ref="headerSessionMenuButton" class="icon-button header-session-menu" type="button" title="会话操作" aria-label="会话操作" @click="openSessionActions(activeSession.id, $event)"><AppIcon name="dots" :size="18" /></button>
        </template>
      </MessageTimeline>
      <p v-if="chat.error" class="chat-error" role="alert"><AppIcon name="alert" :size="13" />{{ chat.error }}</p>
      <ComposerShell
        ref="composer"
        mode="chat"
        :draft-key="`${auth.user?.id || 'local'}:${auth.activeProfile?.name || 'default'}:${chat.activeSessionId || 'new'}`"
        :disabled="chat.connectionState === 'failed'"
        :streaming="chat.isStreaming"
        :sending="chat.isSending"
        :model-label="chat.selectedModel?.name || '选择模型'"
        :fast-mode="chat.fastMode"
        :fast-mode-disabled="!chat.activeSessionId"
        :reasoning-effort="reasoningLabel"
        :reasoning-value="chat.reasoningEffort || ''"
        :reasoning-options="reasoningComposerOptions"
        :context-used="contextUsed"
        :context-limit="chat.contextUsage?.contextLimit || 262144"
        :context-estimated="contextIsEstimated"
        :queue-mode="queueMode || chat.isQueued"
        :tool-trace-visible="showThinking"
        :reference="reference"
        :slash-commands="[
          { id: 'fork', label: 'fork', detail: '从当前会话创建分支' },
          { id: 'compact', label: 'compact', detail: '压缩当前会话上下文' },
          { id: 'model', label: 'model', detail: '切换模型' },
        ]"
        @send="send"
        @stop="chat.interrupt"
        @model-click="modelDialog = true"
        @fast-mode-toggle="toggleFastMode"
        @reasoning-change="selectReasoning"
        @settings-click="toggleShowThinking"
        @queue-toggle="queueMode = !queueMode"
        @clear-reference="quoted = null"
      />
    </div>

    <template #inspector>
      <SessionOutline v-if="outlineOpen" :messages="messages" :has-older="chat.hasMoreBefore" @navigate="navigateOutline" />
      <PreviewInspector v-else-if="preview" :item="preview" @close="preview = null" @add-to-composer="addPreviewToComposer" />
    </template>
  </WorkspaceView>

  <FloatingResourceSearch section="chat" label="搜索会话" :items="sidebarItems" @select="chooseSession" />
  <PreviewModal v-if="filePreview" :item="filePreview" :items="conversationMediaItems" @close="filePreview = null" @add-to-composer="addPreviewToComposer" @source="filePreview = null" />
  <ImagePreviewLightbox v-model="mediaPreviewIndex" :images="lightboxMedia" @add="addMediaToComposer" />

  <ModelChoiceDialog :open="modelDialog" :options="chat.models" :selected-id="selectedModelId" :busy="modelSwitching" @close="modelDialog = false" @select="selectModel" />

  <Teleport to="body">
    <Transition name="session-menu">
      <section v-if="actionSessionId" class="session-actions" :style="actionMenuStyle" role="menu" aria-label="会话操作" @contextmenu.prevent>
        <template v-if="renaming">
          <label>会话名称<input v-model="renameValue" maxlength="120" autofocus @keydown.enter="saveRename" /></label>
          <div><button class="quiet-button" type="button" @click="renaming = false">取消</button><button class="solid-button" type="button" @click="saveRename">保存</button></div>
        </template>
        <template v-else>
          <button class="action-row" role="menuitem" type="button" @click="openSessionOutline"><AppIcon name="menu" :size="14" />会话大纲</button>
          <button v-if="actionSessionId === chat.activeSessionId" class="action-row" role="menuitem" type="button" :disabled="chat.isStreaming || chat.isQueued || chat.isSending || chat.activeRouteState?.isLoadingHistory" @click="forceRefreshHistory"><AppIcon name="refresh" :size="14" />强制刷新历史</button>
          <button class="action-row" role="menuitem" type="button" @click="toggleSessionPinned"><AppIcon :name="actionSession?.pinned ? 'pin-off' : 'pin'" :size="14" />{{ actionSession?.pinned ? '取消置顶' : '置顶会话' }}</button>
          <button class="action-row" role="menuitem" type="button" @click="renaming = true"><AppIcon name="edit" :size="14" />重命名</button>
          <button class="action-row danger" role="menuitem" type="button" @click="deleteSession"><AppIcon name="trash" :size="14" />删除会话</button>
        </template>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.chat-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.header-session-menu { color: var(--text-muted); background: transparent; }.header-session-menu:hover { color: var(--text-primary); background: var(--surface-soft); }
.chat-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
.session-actions { position: fixed; z-index: 205; width: 208px; box-sizing: border-box; padding: 6px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-raised); box-shadow: 0 12px 34px rgba(0,0,0,.16); }.action-row { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; text-align: left; }.action-row:hover, .action-row:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }.action-row.danger { color: var(--danger); }.session-actions label { display: flex; flex-direction: column; gap: 6px; padding: 4px; color: var(--text-muted); font-size: 9px; }.session-actions input { width: 100%; height: 32px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font-size: 11px; }.session-actions input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.session-actions > div { display: flex; justify-content: flex-end; gap: 5px; margin-top: 7px; padding: 0 4px 3px; }.session-actions :deep(.quiet-button), .session-actions :deep(.solid-button) { min-height: 29px; padding-inline: 10px; font-size: 10px; }
.session-menu-enter-active, .session-menu-leave-active { transition: opacity 100ms ease, transform 120ms var(--ease-out); transform-origin: top right; }.session-menu-enter-from, .session-menu-leave-to { opacity: 0; transform: translateY(-3px) scale(.98); }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action, .session-menu-enter-active, .session-menu-leave-active { transition: none; } }
</style>
