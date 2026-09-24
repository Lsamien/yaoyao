<script setup lang="ts">
import { useChatAppearance } from '@/stores/chatAppearance'
import { bubbleVariables } from '@/utils/chatAppearance'
import '@/styles/chat-bubbles.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ServiceWarnings from './ServiceWarnings.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MessageFailureNotice from '@/components/messages/MessageFailureNotice.vue'
import { messageFailure } from '@/utils/messageFailure'
import TaskResultNotice from '@/components/workspace/TaskResultNotice.vue'
import MessageSystemEvent from '@/components/messages/MessageSystemEvent.vue'
import { systemMessageNotice } from '@/utils/systemMessageNotice'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import TypingIndicator from '@/components/common/TypingIndicator.vue'
import InteractionCard from './InteractionCard.vue'
import MarkdownContent from './MarkdownContent.vue'
import ToolTrace from './ToolTrace.vue'
import TurnTrace from './TurnTrace.vue'
import type { UiInteraction, UiLocalFileLink, UiMessage } from './types'
import { buildMessageTimelineRows } from '@/utils/turnTrace'
import { copyTextToClipboard } from '@/utils/clipboard'
import { displayContentForMessage } from '@/utils/messageDisplay'
import { formatMessageTime } from '@/utils/messageTime'

const { appearance } = useChatAppearance()

const props = withDefaults(defineProps<{
  messages: UiMessage[]
  title?: string
  subtitle?: string
  emptyTitle?: string
  emptyDescription?: string
  emptyLogo?: boolean
  transparentHeader?: boolean
  forkSourceTitle?: string
  loading?: boolean
  loadingOlder?: boolean
  hasOlder?: boolean
  connected?: boolean
  synced?: boolean
  showTools?: boolean
  showAssistantIdentity?: boolean
  interaction?: UiInteraction | null
  mentionNames?: string[]
  agentAvatars?: Record<string, string>
  agentStates?: Record<string, 'idle' | 'working' | 'waiting' | 'loading' | 'success' | 'failure' | 'notifying'>
  thinking?: boolean
  allowBranch?: boolean
  readOnly?: boolean
}>(), {
  title: '',
  subtitle: '',
  emptyTitle: '开始一段新对话',
  emptyDescription: '从下方输入框发送消息，或选择左侧的历史会话。',
  emptyLogo: false,
  transparentHeader: false,
  forkSourceTitle: '',
  loading: false,
  loadingOlder: false,
  hasOlder: false,
  connected: false,
  synced: false,
  showTools: true,
  showAssistantIdentity: true,
  interaction: null,
  mentionNames: () => [],
  agentAvatars: () => ({}),
  agentStates: () => ({}),
  thinking: false,
  allowBranch: true,
  readOnly: false,
})

const emit = defineEmits<{
  loadOlder: []
  quote: [message: UiMessage]
  branch: [message: UiMessage]
  preview: [attachment: NonNullable<UiMessage['attachments']>[number]]
  previewFile: [file: UiLocalFileLink]
  approve: [approved: boolean]
  clarify: [text: string]
}>()

const scroller = ref<HTMLElement | null>(null)
const pinnedToBottom = ref(true)
const showJump = ref(false)
const copiedMessageId = ref('')
const copyFailedMessageId = ref('')
const timelineRows = computed(() => buildMessageTimelineRows(props.messages))
const showThinkingIndicator = computed(() => props.thinking)
const thinkingAgent = computed(() =>
  [...props.messages].reverse().find(message => message.role === 'assistant' && message.status === 'streaming')
    ?? [...props.messages].reverse().find(message => message.role === 'assistant'),
)
const thinkingAvatarName = computed(() => thinkingAgent.value?.author || thinkingAgent.value?.profile || '夭')
const thinkingAvatar = computed(() => {
  const profile = thinkingAgent.value?.profile
  return profile ? props.agentAvatars[profile] || '' : ''
})
let copyResetTimer: number | undefined

const formatTime = formatMessageTime

function avatarState(message: UiMessage): 'idle' | 'working' | 'waiting' | 'loading' | 'success' | 'failure' | 'notifying' {
  if (message.status === 'streaming') return (message.profile && props.agentStates[message.profile]) || 'working'
  if (message.status === 'pending' || message.status === 'unknown-receipt') return 'waiting'
  if (message.status === 'failed') return 'failure'
  const outcome = message.profile ? props.agentStates[message.profile] : undefined
  if ((outcome === 'success' || outcome === 'failure') && [...props.messages].reverse().find(m => m.profile === message.profile && m.role === 'assistant')?.id === message.id) return outcome
  return 'idle'
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  pinnedToBottom.value = distance < 100
  showJump.value = distance > 240
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  const el = scroller.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior })
}

function onMarkdownRendered() {
  if (pinnedToBottom.value) scrollToBottom('auto')
}

function scrollToMessage(id: string): boolean {
  const root = scroller.value
  if (!root) return false
  const message = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  if (!message) return false
  message.scrollIntoView({ block: 'center', behavior: 'smooth' })
  message.classList.remove('message--revealed')
  requestAnimationFrame(() => message.classList.add('message--revealed'))
  window.setTimeout(() => message.classList.remove('message--revealed'), 1800)
  return true
}

function scrollToAnchor(messageId: string, anchorId: string): boolean {
  const root = scroller.value
  if (!root) return false
  const message = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  if (!message) return false
  const target = anchorId ? message.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`) : null
  ;(target || message).scrollIntoView({ block: target ? 'start' : 'center', behavior: 'smooth' })
  message.classList.remove('message--revealed')
  requestAnimationFrame(() => message.classList.add('message--revealed'))
  window.setTimeout(() => message.classList.remove('message--revealed'), 1800)
  return true
}

async function copyMessage(message: UiMessage) {
  const text = displayContentForMessage(message.role, message.content)
  const copied = await copyTextToClipboard(text)
  copiedMessageId.value = copied ? message.id : ''
  copyFailedMessageId.value = copied ? '' : message.id
  if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer)
  copyResetTimer = window.setTimeout(() => {
    copiedMessageId.value = ''
    copyFailedMessageId.value = ''
    copyResetTimer = undefined
  }, 1400)
}

function hasConversationActions(message: UiMessage): boolean {
  return message.role === 'user' || (message.role === 'assistant' && Boolean(message.content.trim()))
}

function deliveryLabel(status?: UiMessage['status']): string {
  return ({
    preparing: '正在准备附件',
    attached: '附件已就绪',
    pending: '正在发送',
    accepted: '已发送',
    failed: '发送失败',
    'unknown-receipt': '回执未知，请检查后重试',
  } as Partial<Record<NonNullable<UiMessage['status']>, string>>)[status || 'settled'] || ''
}

watch(() => props.messages.length, async () => {
  if (!pinnedToBottom.value) return
  await nextTick()
  scrollToBottom('auto')
})

watch(() => props.messages.at(-1)?.content, async () => {
  if (!pinnedToBottom.value) return
  await nextTick()
  scrollToBottom('auto')
})

onMounted(() => nextTick(() => scrollToBottom('auto')))
onBeforeUnmount(() => {
  if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer)
})

defineExpose({ scrollToMessage, scrollToAnchor, scrollToBottom, isFollowingBottom: () => pinnedToBottom.value })
</script>

<template>
  <section class="timeline-frame" :class="{ 'timeline-frame--transparent': transparentHeader }">
    <header v-if="title || transparentHeader" class="timeline-header" :class="{ 'timeline-header--transparent': transparentHeader }">
      <slot name="header-leading" />
      <div v-if="!transparentHeader"><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
      <div v-if="!transparentHeader" class="timeline-state" :title="connected ? (synced ? '实时连接与历史均已同步' : '实时连接已就绪，历史同步中') : '实时连接未就绪'">
        <span class="status-dot" :class="connected ? (synced ? 'status-dot--online' : 'status-dot--working') : ''" />
        {{ connected ? (synced ? '已同步' : '同步中') : '离线' }}
      </div>
      <slot name="header-actions" />
    </header>

    <div ref="scroller" class="timeline" @scroll.passive="onScroll">
      <div v-if="loading && !messages.length" class="message-skeletons" aria-label="正在加载消息">
        <div v-for="n in 4" :key="n" :class="{ user: n % 2 === 0 }"><i /><span /></div>
      </div>
      <div v-else-if="!messages.length && emptyLogo" class="new-chat-empty">
        <img class="new-chat-empty__logo" src="/brand/AppIcon-1024.png" width="1024" height="1024" alt="" aria-hidden="true" />
        <p>聊点什么</p>
      </div>
      <EmptyState v-else-if="!messages.length" icon="chat" :title="emptyTitle" :description="emptyDescription" />
      <div v-else class="message-stack" :class="{ 'message-stack--interaction': interaction }">
        <div v-if="forkSourceTitle" class="fork-divider" role="separator">
          <span><AppIcon name="branch" :size="13" />FORK 来源 <strong>{{ forkSourceTitle }}</strong></span>
        </div>
        <button v-if="hasOlder" class="load-older" type="button" :disabled="loadingOlder" @click="emit('loadOlder')">
          {{ loadingOlder ? '正在加载…' : '加载更早消息' }}
        </button>

        <template v-for="row in timelineRows" :key="row.id">
        <TurnTrace v-if="row.kind === 'trace' && showTools" :group="row" />
        <template v-else-if="row.kind === 'message'">
        <article
          v-for="message in [row.message]"
          :key="message.id"
          :data-message-id="message.id"
          class="message"
          :class="[`message--${message.role}`, {
            'message--failed': message.status === 'failed',
            'message--failure-notice': messageFailure(message)?.replacesContent && !message.attachments?.length,
            'message--has-failure': !!messageFailure(message),
            'message--notice': !!systemMessageNotice(message),
            'message--tool-only': message.role === 'assistant' && !message.content && !message.reasoning && Boolean(message.tools?.length),
            'message--assistant-internal': message.role === 'assistant' && !message.content.trim(),
            'message--assistant-anonymous': message.role === 'assistant' && !showAssistantIdentity,
          }]"
        >
          <AgentAvatar v-if="message.role !== 'user' && (message.role !== 'assistant' || showAssistantIdentity)" class="message__avatar" :name="message.author || message.profile || (message.role === 'assistant' ? '夭' : '系')" :avatar="message.profile ? agentAvatars[message.profile] || '' : ''" :size="27" :state="avatarState(message)" />
          <div class="message__body">
            <MessageFailureNotice v-if="messageFailure(message)?.replacesContent && !message.attachments?.length" :failure="messageFailure(message)!" />
            <TaskResultNotice v-else-if="message.role === 'system' && message.taskReference" :content="message.content" :task-reference="message.taskReference" />
            <MessageSystemEvent v-else-if="systemMessageNotice(message)" :message="message" />
            <template v-else>
            <div v-if="message.role !== 'assistant' || showAssistantIdentity" class="message__meta">
              <strong><AppIcon v-if="message.isRemoteAgent" class="message__remote-agent" name="globe" :size="12" />{{ message.role === 'user' ? '你' : message.author || message.profile || (message.role === 'assistant' ? '机器人' : '系统') }}</strong>
              <span v-if="message.metadata" class="message__execution">{{ message.metadata }}</span>
              <time>{{ formatTime(message.createdAt) }}</time>
              <span v-if="message.status && !['settled', 'streaming'].includes(message.status)">{{ { preparing: '准备中', attached: '附件已就绪', pending: '等待回执', accepted: '已接收', streaming: '生成中', settled: '已完成', failed: message.role === 'user' ? '发送失败' : '回复中断', 'unknown-receipt': '回执未知' }[message.status] }}</span>
            </div>

            <details v-if="message.reasoning" class="message__reasoning">
              <summary><AppIcon name="brain" :size="13" />思考过程 · {{ message.reasoning.length }} 字</summary>
              <MarkdownContent process-content :content="message.reasoning" :streaming="message.status === 'streaming'" @rendered="onMarkdownRendered" />
            </details>

            <div v-if="!messageFailure(message)?.replacesContent" class="message__content"  :style="(message.role === 'user' || message.role === 'assistant') ? bubbleVariables(appearance[message.role], message.role) : undefined">
              <MarkdownContent
                :separate-media="message.role === 'user' || message.role === 'assistant' || !!message.communication"
                :bubble="(message.role === 'user' || message.role === 'assistant') && !!message.content.trim()"
                :attachments="message.attachments"
                :content-parts="message.contentParts"
                @preview="item => item.id && message.attachments?.some(a => a.id === item.id) ? emit('preview', item) : emit('previewFile', { name: item.name, url: item.url! })"
                :file-profile="message.profile"
                :content="displayContentForMessage(message.role, message.content)"
                :streaming="message.status === 'streaming'"
                :legacy-media="message.role === 'assistant'"
                :plain="message.role === 'user'"
                :mention-names="mentionNames"
                :outline-prefix="message.role === 'assistant' ? `outline-${message.id}` : ''"
                :file-cards="message.role === 'user' || message.role === 'assistant'"
                :process-content="message.role !== 'user' && message.role !== 'assistant'"
                @rendered="onMarkdownRendered"
                @file-link="(name, url) => emit('previewFile', { name, url })"
              />
            </div>

            <div
              v-if="message.role === 'user' && deliveryLabel(message.status)"
              class="message__delivery"
              :class="`message__delivery--${message.status}`"
              role="status"
              aria-live="polite"
            >
              <AppIcon :name="message.status === 'accepted' ? 'check' : message.status === 'failed' || message.status === 'unknown-receipt' ? 'alert' : 'dots'" :size="11" />
              {{ deliveryLabel(message.status) }}
            </div>

            <div v-if="showTools && message.tools?.length" class="message__tools">
              <ToolTrace v-for="tool in message.tools" :key="tool.id" :tool="tool" />
            </div>


            <div v-if="hasConversationActions(message)" class="message__actions">
              <time v-if="message.role === 'assistant' && !showAssistantIdentity && message.createdAt" class="message__action-time">{{ formatTime(message.createdAt) }}</time>
              <button
                type="button"
                :class="{
                  'message-action--copied': copiedMessageId === message.id,
                  'message-action--copy-failed': copyFailedMessageId === message.id,
                }"
                :title="copiedMessageId === message.id ? '已复制' : copyFailedMessageId === message.id ? '复制失败' : '复制'"
                :aria-label="copiedMessageId === message.id ? '已复制' : copyFailedMessageId === message.id ? '复制失败' : '复制消息'"
                @click="copyMessage(message)"
              ><AppIcon :name="copiedMessageId === message.id ? 'check' : copyFailedMessageId === message.id ? 'alert' : 'copy'" :size="13" /></button>
              <button v-if="!readOnly" type="button" title="引用" aria-label="引用消息" @click="emit('quote', message)"><AppIcon name="quote" :size="13" /></button>
              <button v-if="!readOnly && allowBranch && message.role === 'assistant'" type="button" title="从这里分支" aria-label="从这里分支" @click="emit('branch', message)"><AppIcon name="branch" :size="13" /></button>
            </div>
            </template>
            <ServiceWarnings v-if="message.serviceWarnings?.length" :warnings="message.serviceWarnings"/>
          </div>
          <MessageFailureNotice v-if="messageFailure(message) && (!messageFailure(message)?.replacesContent || !!message.attachments?.length)" :failure="messageFailure(message)!" />
        </article>
        </template>
        </template>

        <TypingIndicator
          v-if="showThinkingIndicator"
          :avatar-name="thinkingAvatarName"
          :avatar="thinkingAvatar"
        />

        <InteractionCard
          v-if="interaction"
          :interaction="interaction"
          @approve="emit('approve', $event)"
          @clarify="emit('clarify', $event)"
        />
      </div>
    </div>

    <Transition name="view-fade">
      <button v-if="showJump" class="jump-bottom" type="button" @click="scrollToBottom()">
        <AppIcon name="chevron-down" :size="15" />回到底部
      </button>
    </Transition>
  </section>
</template>

<style scoped>
.message--has-failure { flex-wrap: wrap; }
.message--has-failure > .failure-notice { flex: 0 0 100%; }
.message.message--notice, .message.message--failure-notice { justify-content: center; }
.message--notice .message__avatar, .message--failure-notice .message__avatar { display: none; }
.message.message--notice .message__body, .message.message--failure-notice .message__body { width: 100%; max-width: 100%; margin: 0; padding: 0; border: 0; background: transparent; }

.timeline-frame { position: relative; display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.timeline-header { display: flex; z-index: 6; min-height: 62px; align-items: center; gap: 13px; padding: 10px 18px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--canvas) 92%, transparent); backdrop-filter: blur(16px); }
.timeline-header--transparent { position: absolute; top: 0; right: 0; left: 0; min-height: 0; justify-content: flex-end; padding: 11px 14px; border: 0; background: transparent; backdrop-filter: none; pointer-events: none; }
.timeline-header--transparent > * { pointer-events: auto; }
.timeline-header > div:first-child { min-width: 0; flex: 1; }.timeline-header h2 { overflow: hidden; margin: 0; font-size: 14px; font-weight: 630; letter-spacing: -.02em; text-overflow: ellipsis; white-space: nowrap; }.timeline-header p { overflow: hidden; margin: 3px 0 0; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.timeline-state { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 9px; }
.timeline { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; background: var(--conversation-canvas); }
.message-stack { width: min(780px, 100%); min-height: 100%; margin: 0 auto; padding: 24px 24px 36px; }
.message-stack--interaction { padding-bottom: 10px; }
.timeline-frame--transparent .message-stack { padding-top: 58px; }
.load-older { display: block; margin: 0 auto 18px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; }.load-older:hover { background: var(--surface-soft); color: var(--text-secondary); }
.message { position: relative; display: flex; max-width: 100%; gap: 10px; margin: 0 0 21px; }
.message__avatar { display: grid; place-items: center; width: 27px; height: 27px; flex: 0 0 27px; background: transparent; color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.message__body { position: relative; min-width: 0; max-width: min(680px, calc(100% - 37px)); }
.message__meta { display: flex; min-height: 20px; align-items: center; gap: 7px; color: var(--text-muted); font-size: 10px; }.message__meta strong { display: inline-flex; align-items: center; color: var(--text-primary); font-size: 12px; font-weight: 600; }.message__remote-agent { margin-right: 4px; color: var(--accent); }.message__meta span { color: var(--warning); }.message__meta .message__execution { overflow: hidden; max-width: 230px; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.message__content { color: var(--text-primary); }
.message__content :deep(.plain-text), .message__content :deep(.markdown) { font-size: 15px; }
.message__content :deep(.code-lang), .message__content :deep(.code-copy) { font-size: 10px; }
.message__content :deep(.code-block code) { font-size: 12px; }
.message__content :deep(.file-link-card)::after { font-size: 10px; }
.message--user { justify-content: flex-end; margin-top: 27px; }
.message--user .message__body { max-width: min(610px, 76%); padding: 0; background: transparent; }

.message--user :deep(.message-parts) { align-items: flex-end; }
.message--user .message__meta { display: none; }
.message__delivery { display: flex; min-height: 18px; align-items: center; justify-content: flex-end; gap: 4px; margin: 5px 1px -4px; color: var(--text-muted); font-size: 10px; }.message__delivery--accepted { color: var(--success); }.message__delivery--failed, .message__delivery--unknown-receipt { color: var(--danger); }
.message--tool-only { margin-block: 4px; }.message--tool-only .message__avatar, .message--tool-only .message__meta, .message--tool-only .message__actions { display: none; }.message--tool-only .message__body { max-width: 100%; }
.message--assistant-internal { margin-bottom: 6px; }.message--assistant-internal .message__reasoning { margin-bottom: 4px; padding-bottom: 4px; }.message--assistant-internal .message__tools { margin-top: 4px; }
.message--assistant-anonymous .message__body { max-width: min(680px, 100%); }
.message__reasoning { max-width: 420px; margin: 3px 0 10px; padding: 0 0 8px; border: 0; border-bottom: 1px dashed var(--line-strong); color: var(--text-secondary); font-size: 12px; }.message__reasoning summary { display: flex; align-items: center; gap: 5px; list-style: none; color: var(--text-muted); cursor: pointer; font-size: 10px; }.message__reasoning summary::-webkit-details-marker { display: none; }.message__reasoning summary::before { content: '›'; color: var(--text-muted); font-size: 14px; line-height: 1; transition: transform 120ms ease; }.message__reasoning[open] summary::before { transform: rotate(90deg); }.message__reasoning :deep(.markdown) { margin-top: 8px; }
.fork-divider { display: flex; align-items: center; gap: 12px; margin: 8px 0 28px; color: var(--text-muted); font-size: 11px; }.fork-divider::before, .fork-divider::after { height: 1px; flex: 1; background: var(--line); content: ''; }.fork-divider > span { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-raised); white-space: nowrap; }.fork-divider strong { max-width: 180px; overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; }
.message__tools { margin-top: 9px; }
.message__actions { display: flex; position: absolute; left: -3px; top: 100%; gap: 2px; padding-top: 2px; opacity: 0; transition: opacity 120ms ease; }.message:hover .message__actions, .message:focus-within .message__actions { opacity: 1; }.message--user .message__actions { right: 0; left: auto; }.message__actions button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }.message__actions button:hover { background: var(--surface-soft); color: var(--text-primary); }.message__actions .message-action--copied { color: var(--success); }.message__actions .message-action--copy-failed { color: var(--danger); }
.message--assistant-anonymous .message__actions { align-items: center; }.message__action-time { min-width: 36px; padding: 0 4px 0 3px; color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.message--failed .message__body { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
.message--revealed .message__body { animation: reveal-message 1.8s ease; }
@keyframes reveal-message { 0%, 28% { box-shadow: 0 0 0 5px var(--focus-ring); } 100% { box-shadow: 0 0 0 0 transparent; } }
.jump-bottom { display: flex; position: absolute; z-index: 8; bottom: 8px; left: 50%; align-items: center; gap: 5px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-raised); color: var(--text-secondary); cursor: pointer; font-size: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.1); transform: translateX(-50%); }
.new-chat-empty { display: flex; min-height: 100%; align-items: center; justify-content: center; gap: 18px; padding: 12vh 24px; box-sizing: border-box; flex-direction: column; color: var(--text-muted); text-align: center; }
.new-chat-empty__logo { display: block; width: min(180px, 34vw); height: auto; aspect-ratio: 1; opacity: .18; filter: grayscale(1); }
.new-chat-empty p { margin: 0; color: var(--text-secondary); font-size: 17px; font-weight: 520; letter-spacing: .02em; }
.message-skeletons { width: min(760px, 100%); margin: 0 auto; padding: 35px 24px; }.message-skeletons div { display: flex; gap: 10px; margin: 0 0 25px; }.message-skeletons div.user { justify-content: flex-end; }.message-skeletons i { width: 27px; height: 27px; border-radius: 9px; background: var(--surface-hover); }.message-skeletons span { width: min(480px, 70%); height: 64px; border-radius: 12px; background: linear-gradient(90deg, var(--surface-soft), var(--surface-hover), var(--surface-soft)); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; }.message-skeletons .user i { display: none; }.message-skeletons .user span { width: 44%; height: 46px; }
@keyframes shimmer { to { background-position: -200% 0; } }


@media (max-width: 768px) {
  .timeline-header { min-height: 54px; padding: 8px 12px; }.timeline-state { font-size: 0; }.timeline-state .status-dot { width: 7px; height: 7px; }
  .new-chat-empty { gap: 15px; padding-block: 9vh; }.new-chat-empty__logo { width: min(150px, 42vw); }.new-chat-empty p { font-size: 16px; }
  .message-stack { padding: 18px 14px 30px; }.message-stack--interaction { padding-bottom: 8px; }.message { margin-bottom: 18px; }.message__body { max-width: calc(100% - 37px); }.message--user .message__body { max-width: 88%; }
  .message__actions { opacity: .65; }.message__meta time { display: none; }
}
</style>
