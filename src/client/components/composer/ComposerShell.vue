<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { createId } from '@/utils/id'
import type { ComposerAttachment, ComposerOption, ComposerReference, ComposerSubmit } from './types'

const props = withDefaults(defineProps<{
  mode?: 'chat' | 'group'
  draftKey?: string
  placeholder?: string
  disabled?: boolean
  streaming?: boolean
  stopWhileRunning?: boolean
  sending?: boolean
  modelLabel?: string
  fastMode?: boolean
  fastModeDisabled?: boolean
  reasoningEffort?: string
  reasoningValue?: string
  reasoningOptions?: ComposerOption[]
  contextUsed?: number
  contextLimit?: number
  contextEstimated?: boolean
  queueMode?: boolean
  toolTraceVisible?: boolean
  reference?: ComposerReference | null
  mentionOptions?: ComposerOption[]
  slashCommands?: ComposerOption[]
  attachmentsEnabled?: boolean
  activityText?: string
}>(), {
  mode: 'chat',
  draftKey: '',
  placeholder: '输入消息，Enter 发送，Shift + Enter 换行',
  disabled: false,
  streaming: false,
  stopWhileRunning: false,
  sending: false,
  modelLabel: '选择模型',
  fastMode: false,
  fastModeDisabled: false,
  reasoningEffort: '默认',
  reasoningValue: '',
  reasoningOptions: () => [],
  contextUsed: 0,
  contextLimit: 0,
  contextEstimated: false,
  queueMode: false,
  toolTraceVisible: true,
  reference: null,
  mentionOptions: () => [],
  slashCommands: () => [],
  attachmentsEnabled: true,
  activityText: '',
})

const emit = defineEmits<{
  send: [payload: ComposerSubmit]
  stop: []
  modelClick: []
  fastModeToggle: [enabled: boolean]
  reasoningChange: [value: string]
  settingsClick: []
  queueToggle: []
  toolTraceToggle: []
  clearReference: []
  error: [message: string]
}>()

const MAX_FILE_SIZE = 25 * 1024 * 1024
const MAX_FILES = 8
const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const attachments = ref<ComposerAttachment[]>([])
const isComposing = ref(false)
const dragDepth = ref(0)
const dragOver = computed(() => dragDepth.value > 0)
const manualHeight = ref<number | null>(null)
const menuIndex = ref(0)
const menuKind = ref<'slash' | 'mention' | null>(null)
const menuQuery = ref('')
const chosenMentionIds = ref<string[]>([])
const reasoningOpen = ref(false)
const settingsOpen = ref(false)
const localError = ref('')
let errorTimer: number | undefined

const canSubmit = computed(() => !props.disabled && !props.sending && (text.value.trim().length > 0 || attachments.value.length > 0))
// A running group still accepts new room messages. Only an ordinary session
// turns its primary send affordance into an interrupt control.
const showStop = computed(() => props.streaming && !text.value.trim() && !attachments.value.length && (props.stopWhileRunning || props.mode === 'chat'))
const compactModel = computed(() => props.modelLabel.split('/').filter(Boolean).at(-1) || props.modelLabel)
const contextPercent = computed(() => props.contextLimit > 0 ? Math.min(100, Math.round(props.contextUsed / props.contextLimit * 100)) : 0)
const hasContext = computed(() => props.contextLimit > 0)
const remainingContextTokens = computed(() => Math.max(0, props.contextLimit - props.contextUsed))
const reasoningOptionIndex = computed(() => Math.max(0, props.reasoningOptions.findIndex(option => option.id === props.reasoningValue)))
const reasoningLabel = computed(() => props.reasoningOptions[reasoningOptionIndex.value]?.label || props.reasoningEffort)

const menuOptions = computed(() => {
  const source = menuKind.value === 'slash' ? props.slashCommands : props.mentionOptions
  const query = menuQuery.value.trim().toLocaleLowerCase()
  return source.filter(option => {
    if (!query) return true
    return option.label.toLocaleLowerCase().includes(query) || option.detail?.toLocaleLowerCase().includes(query)
  }).slice(0, 10)
})

function draftStorageKey(key = props.draftKey) {
  return key ? `hermes-yaoyao:composer:${props.mode}:${key}` : ''
}

function restoreDraft() {
  const key = draftStorageKey()
  text.value = key ? localStorage.getItem(key) || '' : ''
  nextTick(autoSize)
}

function persistDraft(value: string) {
  const key = draftStorageKey()
  if (!key) return
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

function showError(message: string) {
  localError.value = message
  emit('error', message)
  window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => { localError.value = '' }, 4500)
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isImage(type: string) { return type.startsWith('image/') }

function addFiles(files: File[]) {
  if (!props.attachmentsEnabled) {
    showError('当前上游不支持团队附件')
    return
  }
  const available = MAX_FILES - attachments.value.length
  if (available <= 0) return showError(`最多添加 ${MAX_FILES} 个文件`)
  const accepted: ComposerAttachment[] = []
  for (const file of files.slice(0, available)) {
    if (file.size > MAX_FILE_SIZE) {
      showError(`${file.name} 超过 25 MiB`)
      continue
    }
    accepted.push({
      id: `${file.name}:${file.size}:${file.lastModified}:${createId('attachment')}`,
      file,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      previewUrl: isImage(file.type) ? URL.createObjectURL(file) : undefined,
    })
  }
  attachments.value.push(...accepted)
  if (files.length > available) showError(`最多添加 ${MAX_FILES} 个文件`)
}

function removeAttachment(id: string) {
  const index = attachments.value.findIndex(item => item.id === id)
  if (index < 0) return
  const [removed] = attachments.value.splice(index, 1)
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
}

function clearAttachments() {
  attachments.value.forEach(item => item.previewUrl && URL.revokeObjectURL(item.previewUrl))
  attachments.value = []
  if (fileInput.value) fileInput.value.value = ''
}

function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length) addFiles(files)
}

function onDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent) {
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  dragDepth.value = 0
  addFiles(Array.from(event.dataTransfer?.files ?? []))
}

function autoSize() {
  const el = textarea.value
  if (!el || manualHeight.value !== null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(400, Math.max(30, el.scrollHeight))}px`
}

function resetHeight() {
  manualHeight.value = null
  if (textarea.value) textarea.value.style.height = 'auto'
  nextTick(autoSize)
}

function startResize(event: PointerEvent) {
  const el = textarea.value
  if (!el) return
  event.preventDefault()
  const startY = event.clientY
  const startHeight = el.clientHeight
  const pointerId = event.pointerId
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(pointerId)

  const move = (moveEvent: PointerEvent) => {
    manualHeight.value = Math.min(400, Math.max(30, startHeight - (moveEvent.clientY - startY)))
  }
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}

function updateMenu() {
  const el = textarea.value
  if (!el || isComposing.value) return
  const before = text.value.slice(0, el.selectionStart)
  if (before.startsWith('/') && !before.includes(' ') && !before.includes('\n') && props.slashCommands.length) {
    menuKind.value = 'slash'
    menuQuery.value = before.slice(1)
    menuIndex.value = 0
    return
  }
  if (props.mode === 'group' && props.mentionOptions.length) {
    const match = before.match(/(?<![A-Za-z0-9_.%+/@-])@([^\s@]*)$/u)
    if (match && !/https?:\/\/\S*$/u.test(before)) {
      menuKind.value = 'mention'
      menuQuery.value = match[1] ?? ''
      menuIndex.value = 0
      return
    }
  }
  menuKind.value = null
}

function selectOption(option: ComposerOption) {
  if (option.disabled) return
  const el = textarea.value
  if (!el) return
  const cursor = el.selectionStart
  const before = text.value.slice(0, cursor)
  const after = text.value.slice(cursor)
  if (menuKind.value === 'slash') {
    const replacement = option.insertText ?? `/${option.label} `
    text.value = replacement + after
    nextTick(() => el.setSelectionRange(replacement.length, replacement.length))
  } else {
    const match = before.match(/(?<![A-Za-z0-9_.%+/@-])@([^\s@]*)$/u)
    const start = match ? cursor - match[0].length : cursor
    const prefix = text.value.slice(0, start)
    const replacement = `@${option.label} `
    text.value = prefix + replacement + after
    if (option.id !== 'all' && !chosenMentionIds.value.includes(option.id)) chosenMentionIds.value.push(option.id)
    nextTick(() => {
      const pos = prefix.length + replacement.length
      el.setSelectionRange(pos, pos)
    })
  }
  menuKind.value = null
  nextTick(() => { el.focus(); autoSize() })
}

function handleKeydown(event: KeyboardEvent) {
  if (menuKind.value && menuOptions.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); menuIndex.value = (menuIndex.value + 1) % menuOptions.value.length; return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault(); menuIndex.value = (menuIndex.value - 1 + menuOptions.value.length) % menuOptions.value.length; return
    }
    if (event.key === 'Escape') { event.preventDefault(); menuKind.value = null; return }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      const option = menuOptions.value[menuIndex.value]
      if (option) selectOption(option)
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey) return
  if (isComposing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

function endComposition() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateMenu()
  })
}

function submit() {
  if (!canSubmit.value) return
  const payload: ComposerSubmit = {
    text: text.value.trim(),
    files: attachments.value.map(item => item.file),
    mentionIds: [...chosenMentionIds.value],
  }
  emit('send', payload)
  nextTick(() => textarea.value?.focus())
}

function clearAfterSend() {
  text.value = ''
  chosenMentionIds.value = []
  persistDraft('')
  clearAttachments()
  resetHeight()
  nextTick(() => textarea.value?.focus())
}

function onWrapperMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('button, input, textarea, [role="option"], .composer-resize')) return
  textarea.value?.focus()
}

function formatTokens(value: number) {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)}m`
  if (value >= 1024) return `${(value / 1024).toFixed(1)}k`
  return `${value}`
}

function selectReasoningByIndex(event: Event) {
  const index = Number((event.target as HTMLInputElement).value)
  const option = props.reasoningOptions[index]
  if (option) emit('reasoningChange', option.id)
}

function onDocumentPointer(event: PointerEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.composer-shell')) {
    menuKind.value = null
    reasoningOpen.value = false
    settingsOpen.value = false
  }
}

watch(text, value => { persistDraft(value); nextTick(autoSize) })
watch(() => props.draftKey, () => {
  restoreDraft()
  reasoningOpen.value = false
  settingsOpen.value = false
})

onMounted(() => {
  restoreDraft()
  document.addEventListener('pointerdown', onDocumentPointer)
})

onBeforeUnmount(() => {
  clearAttachments()
  window.clearTimeout(errorTimer)
  document.removeEventListener('pointerdown', onDocumentPointer)
})

defineExpose({
  attachFiles: addFiles,
  filesSnapshot: () => attachments.value.map(attachment => attachment.file),
  focus: () => textarea.value?.focus(),
  clearAfterSend,
})
</script>

<template>
  <div class="composer-area">
    <div v-if="attachments.length" class="composer-attachments" aria-label="附件">
      <div v-for="attachment in attachments" :key="attachment.id" class="composer-attachment" :class="{ image: isImage(attachment.type) }">
        <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
        <AppIcon v-else name="file" :size="19" />
        <span><strong>{{ attachment.name }}</strong><small>{{ formatSize(attachment.size) }}</small></span>
        <button type="button" :aria-label="`移除 ${attachment.name}`" @click="removeAttachment(attachment.id)"><AppIcon name="close" :size="12" /></button>
      </div>
    </div>

    <div v-if="reference" class="composer-reference">
      <AppIcon name="quote" :size="14" />
      <span><small>{{ reference.author ? `回复 ${reference.author}` : '回复消息' }}</small><strong>{{ reference.content.replace(/\s+/g, ' ').trim() }}</strong></span>
      <button type="button" aria-label="取消引用" @click="emit('clearReference')"><AppIcon name="close" :size="13" /></button>
    </div>

    <div v-if="mode === 'group'" class="composer-activity-slot">
      <Transition name="composer-activity">
        <div v-if="activityText" class="composer-activity" role="status" aria-label="机器人输入状态" aria-live="polite" aria-atomic="true">
          <span class="composer-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          <strong>{{ activityText }}</strong>
        </div>
      </Transition>
    </div>

    <div
      class="composer-shell"
      :class="{ 'composer-shell--drag': dragOver, 'composer-shell--disabled': disabled }"
      @mousedown="onWrapperMouseDown"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <input ref="fileInput" class="composer-file-input" type="file" multiple @change="onFiles" />
      <div class="composer-resize" title="拖动调整高度；双击复位" @pointerdown="startResize" @dblclick="resetHeight" />

      <div v-if="hasContext" class="composer-context" :class="{ warning: contextPercent > 80 }" :title="contextEstimated ? 'Hermes 未提供实时上下文用量；此数值按当前会话内容估算。' : undefined">
        <span>{{ contextEstimated ? '约 ' : '' }}{{ formatTokens(contextUsed) }} / {{ formatTokens(contextLimit) }} · 剩余 {{ formatTokens(remainingContextTokens) }}</span>
        <i><b :style="{ width: `${contextPercent}%` }" /></i>
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        class="composer-textarea"
        :style="manualHeight !== null ? { height: `${manualHeight}px` } : undefined"
        rows="1"
        :disabled="disabled"
        :placeholder="placeholder"
        @input="updateMenu"
        @click="updateMenu"
        @keydown="handleKeydown"
        @paste="onPaste"
        @compositionstart="isComposing = true"
        @compositionend="endComposition"
      />

      <div class="composer-toolbar">
        <div class="composer-tools">
          <button class="composer-tool composer-tool--icon" type="button" :disabled="disabled || !attachmentsEnabled" :title="attachmentsEnabled ? '添加附件' : '当前上游不支持附件'" aria-label="添加附件" @click="fileInput?.click()">
            <AppIcon name="paperclip" :size="16" />
          </button>
          <div v-if="mode === 'chat'" class="composer-popover-anchor">
            <button class="composer-tool" type="button" :class="{ active: reasoningOpen }" :disabled="disabled || !reasoningOptions.length" :title="`推理强度：${reasoningLabel}`" :aria-label="`推理强度：${reasoningLabel}`" :aria-expanded="reasoningOpen" @click="reasoningOpen = !reasoningOpen; settingsOpen = false">
              <AppIcon name="brain" :size="16" /><span>{{ reasoningLabel }}</span><AppIcon name="chevron-down" :size="11" />
            </button>
            <Transition name="composer-menu">
              <div v-if="reasoningOpen" class="composer-popover composer-popover--reasoning" role="dialog" aria-label="推理强度">
                <div class="composer-popover__heading"><span>推理强度</span><strong>{{ reasoningLabel }}</strong></div>
                <input class="reasoning-slider" type="range" :min="0" :max="Math.max(0, reasoningOptions.length - 1)" step="1" :value="reasoningOptionIndex" @input="selectReasoningByIndex" />
                <div class="composer-popover__range"><span>{{ reasoningOptions[0]?.label || '默认' }}</span><span>{{ reasoningOptions.at(-1)?.label || '最大' }}</span></div>
              </div>
            </Transition>
          </div>
          <div v-if="mode === 'chat'" class="composer-popover-anchor">
            <button class="composer-tool" type="button" :class="{ active: settingsOpen }" :disabled="disabled" title="设置" aria-label="设置" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen; reasoningOpen = false">
              <AppIcon name="settings" :size="16" /><span>设置</span><AppIcon name="chevron-down" :size="11" />
            </button>
            <Transition name="composer-menu">
              <div v-if="settingsOpen" class="composer-popover composer-popover--settings" role="dialog" aria-label="输入设置">
                <button class="composer-setting-row" type="button" role="switch" :aria-checked="toolTraceVisible" @click="emit('settingsClick')">
                  <span><AppIcon name="brain" :size="15" />显示思考</span>
                  <AppIcon v-if="toolTraceVisible" name="check" :size="16" />
                </button>
                <button class="composer-setting-row" type="button" title="首版暂未启用语音输入" @click="showError('语音输入尚未启用')">
                  <span>语音输入设置</span>
                </button>
              </div>
            </Transition>
          </div>
          <button v-else class="composer-tool" type="button" :class="{ active: toolTraceVisible }" :disabled="disabled" title="显示思考" @click="emit('toolTraceToggle')">
            <AppIcon name="brain" :size="16" /><span>思考</span>
          </button>
          <button v-if="mode === 'chat'" class="composer-tool composer-tool--model" type="button" :disabled="disabled" :title="modelLabel" @click="emit('modelClick')">
            <AppIcon name="model" :size="15" /><span>{{ compactModel }}</span><AppIcon name="chevron-down" :size="11" />
          </button>
          <button
            v-if="mode === 'chat'"
            class="composer-tool composer-tool--icon composer-fast-mode"
            :class="{ active: fastMode }"
            type="button"
            :disabled="disabled || fastModeDisabled"
            :aria-pressed="fastMode"
            :aria-label="`快速模式：${fastMode ? '已开启' : '已关闭'}`"
            title="快速模式：响应更快，消耗更多额度"
            @click="emit('fastModeToggle', !fastMode)"
          >
            <AppIcon name="bolt" :size="15" />
          </button>
          <span v-else-if="mentionOptions.length" class="composer-mention-hint"><b>@</b><span>提及成员</span></span>
        </div>
        <div class="composer-actions">
          <button v-if="mode === 'chat' && streaming && canSubmit" class="queue-toggle" :class="{ active: queueMode }" type="button" :title="queueMode ? '消息将排队发送' : '消息将 Steer 当前会话'" @click="emit('queueToggle')">
            {{ queueMode ? '排队' : 'Steer' }}
          </button>
          <span v-if="sending" class="composer-sending" role="status" aria-live="polite"><i />正在发送</span>
          <span class="composer-send-hitbox">
            <button
              class="composer-send"
              :class="{ 'composer-send--stop': showStop }"
              type="button"
              :disabled="showStop ? false : !canSubmit"
              :aria-label="showStop ? '停止生成' : '发送消息'"
              @click="showStop ? emit('stop') : submit()"
            >
              <AppIcon :name="showStop ? 'stop' : 'arrow-up'" :size="showStop ? 17 : 17" />
            </button>
          </span>
        </div>
      </div>

      <Transition name="composer-menu">
        <div v-if="menuKind && menuOptions.length" class="composer-menu" role="listbox">
          <div class="composer-menu__label">{{ menuKind === 'mention' ? '提及机器人' : '命令' }}</div>
          <button
            v-for="(option, index) in menuOptions"
            :key="option.id"
            type="button"
            role="option"
            :aria-selected="index === menuIndex"
            :disabled="option.disabled"
            :class="{ active: index === menuIndex }"
            @mousedown.prevent="selectOption(option)"
            @mouseenter="menuIndex = index"
          >
            <span class="composer-menu__avatar">{{ menuKind === 'mention' ? option.label.slice(0, 1).toUpperCase() : '/' }}</span>
            <span><strong>{{ menuKind === 'mention' ? `@${option.label}` : `/${option.label}` }}</strong><small v-if="option.detail">{{ option.detail }}</small></span>
            <em v-if="option.disabled">不可用</em>
          </button>
        </div>
      </Transition>

      <div v-if="dragOver" class="composer-drop-hint"><AppIcon name="paperclip" :size="20" />松开以添加附件</div>
    </div>
    <Transition name="composer-menu"><p v-if="localError" class="composer-error" role="alert">{{ localError }}</p></Transition>
  </div>
</template>

<style scoped>
.composer-area { position: relative; z-index: 12; flex: 0 0 auto; padding: 12px max(24px, calc((100% - 760px) / 2)) max(18px, env(safe-area-inset-bottom)); background: var(--conversation-canvas); }
.composer-activity-slot { display: flex; width: 100%; max-width: 760px; min-height: 20px; margin: 0 auto 3px; align-items: center; }
.composer-activity { display: inline-flex; min-width: 0; align-items: center; gap: 7px; color: var(--text-muted); font-size: 10px; }
.composer-activity strong { overflow: hidden; color: var(--text-secondary); font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.composer-typing-dots { display: inline-flex; align-items: center; gap: 2px; }.composer-typing-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: composer-typing 1.05s ease-in-out infinite; }.composer-typing-dots i:nth-child(2) { animation-delay: 140ms; }.composer-typing-dots i:nth-child(3) { animation-delay: 280ms; }
@keyframes composer-typing { 0%, 65%, 100% { opacity: .3; transform: translateY(0); } 32% { opacity: 1; transform: translateY(-2px); } }
.composer-activity-enter-active, .composer-activity-leave-active { transition: opacity 120ms ease, transform 120ms var(--ease-out); }.composer-activity-enter-from, .composer-activity-leave-to { opacity: 0; transform: translateY(3px); }
.composer-shell { position: relative; display: flex; width: 100%; min-height: 72px; max-width: 760px; margin-inline: auto; flex-direction: column; align-items: stretch; gap: 8px; padding: 13px 14px 9px; border: 1px solid var(--input-border-color); border-radius: 18px; background: var(--chat-composer-bg); box-shadow: 0 8px 24px rgba(41,36,39,.06); cursor: text; transition: border-color 140ms ease, box-shadow 150ms ease, background-color 140ms ease; }
.dark .composer-shell { box-shadow: 0 8px 28px rgba(0,0,0,.32); }
.composer-shell:hover:not(:focus-within) { border-color: var(--input-border-hover-color); }
.composer-shell:focus-within { border-color: var(--input-border-focus-color); box-shadow: 0 10px 32px rgba(0,0,0,.11); }
.dark .composer-shell:focus-within { box-shadow: 0 12px 34px rgba(0,0,0,.4); }
.composer-shell--drag { border-color: var(--text-primary) !important; background: color-mix(in srgb, var(--chat-composer-bg) 90%, var(--text-primary)); }
.composer-shell--disabled { opacity: .68; }
.composer-file-input { display: none; }
.composer-resize { position: absolute; z-index: 4; top: -5px; left: 9px; right: 9px; height: 10px; border-radius: 999px; cursor: row-resize; touch-action: none; }
.composer-resize:hover::after { content: ''; position: absolute; top: 4px; left: 38%; right: 38%; height: 2px; border-radius: 2px; background: var(--line-strong); }
.composer-textarea { display: block; width: 100%; min-height: 30px; max-height: 400px; flex: 1 1 auto; padding: 0; border: 0; outline: 0; resize: none; overflow-y: auto; background: none; color: var(--text-primary); font-family: var(--font-ui); font-size: 14px; line-height: 1.5; }
.composer-textarea::placeholder { overflow: hidden; color: var(--input-placeholder-color); opacity: 1; text-overflow: ellipsis; white-space: nowrap; }
.composer-textarea:disabled { cursor: not-allowed; }
.composer-context { position: absolute; z-index: 1; top: 8px; right: 14px; display: flex; align-items: center; gap: 6px; max-width: calc(100% - 28px); color: var(--text-muted); font-size: 10px; pointer-events: none; }
.composer-context span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-context.warning { color: var(--warning); }
.composer-context i { display: block; width: 60px; height: 4px; flex: 0 0 60px; overflow: hidden; border-radius: 3px; background: var(--surface-hover); }
.composer-context b { display: block; height: 100%; border-radius: inherit; background: currentColor; transition: width 220ms ease; }
.composer-context + .composer-textarea { padding-top: 9px; }
.composer-toolbar { display: flex; min-height: 32px; margin-top: auto; align-items: center; justify-content: space-between; gap: 12px; }
.composer-tools, .composer-actions { display: flex; min-width: 0; align-items: center; gap: 5px; }
.composer-tools { flex: 1; }
.composer-actions { flex: 0 0 auto; gap: 7px; }
.composer-popover-anchor { position: relative; display: flex; flex: 0 0 auto; }
.composer-tool { display: inline-flex; min-width: 28px; height: 28px; max-width: 175px; align-items: center; justify-content: center; gap: 4px; padding: 0 6px; border: 0; border-radius: 999px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; white-space: nowrap; }
.composer-tool:hover, .composer-tool.active { background: var(--surface-hover); color: var(--text-primary); }
.composer-tool:disabled { cursor: not-allowed; opacity: .36; }
.composer-tool span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.composer-tool--icon { width: 28px; padding: 0; }
.composer-tool--model { min-width: 0; }
.composer-fast-mode.active { background: color-mix(in srgb, #1677ff 12%, transparent); color: #1677ff; }
.composer-fast-mode.active:hover { background: color-mix(in srgb, #1677ff 18%, transparent); color: #1677ff; }
.dark .composer-fast-mode.active { color: #4c9aff; }
.composer-mention-hint { display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); font-size: 11px; }
.composer-mention-hint b { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 7px; background: var(--surface-soft); color: var(--text-secondary); font-size: 12px; }
.composer-popover { position: absolute; z-index: 30; bottom: calc(100% + 10px); left: 0; width: min(320px, calc(100vw - 48px)); padding: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
.composer-popover--reasoning { --reasoning-accent: #e8a735; }
.composer-popover__heading, .composer-popover__range { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.composer-popover__heading { margin-bottom: 12px; color: var(--text-secondary); font-size: 12px; }
.composer-popover__heading strong { color: var(--reasoning-accent); font-weight: 650; }
.composer-popover__range { margin-top: 8px; color: var(--text-muted); font-size: 9px; }
.reasoning-slider { display: block; width: 100%; height: 10px; margin: 0; appearance: none; -webkit-appearance: none; border-radius: 99px; background: linear-gradient(90deg, #38bdf8 0%, #22d3ee 20%, #34d399 40%, #facc15 62%, #fb923c 82%, #ef4444 100%); cursor: pointer; }
.reasoning-slider::-webkit-slider-thumb { width: 22px; height: 22px; appearance: none; -webkit-appearance: none; border: 2px solid #fff; border-radius: 50%; background: #f8fafc; box-shadow: 0 2px 8px rgba(24,18,44,.28); }
.reasoning-slider::-moz-range-thumb { width: 18px; height: 18px; border: 2px solid #fff; border-radius: 50%; background: #f8fafc; box-shadow: 0 2px 8px rgba(24,18,44,.28); }
.composer-popover--settings { width: 220px; padding: 6px; }
.composer-setting-row { display: flex; width: 100%; min-height: 38px; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; }
.composer-setting-row:hover { background: var(--surface-hover); color: var(--text-primary); }
.composer-setting-row > span { display: inline-flex; align-items: center; gap: 7px; }
.queue-toggle { height: 26px; padding: 0 7px; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; }
.queue-toggle:hover, .queue-toggle.active { background: var(--surface-hover); color: var(--text-primary); }
.composer-send-hitbox { display: grid; place-items: center; width: 34px; height: 34px; }
.composer-send { display: grid; place-items: center; width: 34px; min-width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; background: var(--accent); color: var(--text-on-solid); cursor: pointer; box-shadow: 0 4px 12px rgba(41,36,39,.18); transition: transform 150ms ease, box-shadow 150ms ease; }
.composer-send:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 7px 16px rgba(41,36,39,.22); }
.composer-send:disabled { cursor: not-allowed; background: #9f9f9f; color: #fff; }
.composer-send--stop { background: var(--accent); }
.composer-sending { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 9px; white-space: nowrap; }.composer-sending i { width: 5px; height: 5px; border-radius: 50%; background: var(--warning); animation: composer-pulse 1s ease-in-out infinite; }
@keyframes composer-pulse { 50% { opacity: .25; transform: scale(.7); } }
.composer-attachments { display: flex; width: 100%; max-width: 760px; margin: 0 auto 9px; flex-wrap: wrap; gap: 7px; }
.composer-attachment { position: relative; display: flex; max-width: 210px; min-height: 48px; align-items: center; gap: 8px; padding: 6px 28px 6px 9px; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-raised); color: var(--text-secondary); }
.composer-attachment.image { width: 64px; height: 64px; padding: 0; }
.composer-attachment img { width: 100%; height: 100%; object-fit: cover; }
.composer-attachment > span { display: flex; min-width: 0; flex-direction: column; }
.composer-attachment strong, .composer-attachment small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-attachment strong { color: var(--text-primary); font-size: 10px; font-weight: 560; }.composer-attachment small { margin-top: 3px; color: var(--text-muted); font-size: 9px; }
.composer-attachment > button { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: rgba(0,0,0,.52); color: #fff; cursor: pointer; }
.composer-reference { display: flex; width: calc(100% - 16px); max-width: 744px; min-height: 36px; margin: 0 auto 8px; align-items: center; gap: 9px; padding: 5px 7px 5px 10px; border-left: 2px solid var(--text-muted); border-radius: 7px; background: var(--surface-soft); color: var(--text-muted); }
.composer-reference > span { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.composer-reference small { font-size: 9px; }.composer-reference strong { overflow: hidden; color: var(--text-secondary); font-size: 10px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.composer-reference button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
.composer-reference button:hover { background: var(--surface-hover); color: var(--text-primary); }
.composer-menu { position: absolute; z-index: 20; left: 12px; right: 12px; bottom: calc(100% + 8px); max-height: 280px; padding: 5px; overflow-y: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
.composer-menu__label { padding: 5px 8px 7px; color: var(--text-muted); font-size: 9px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.composer-menu button { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.composer-menu button.active, .composer-menu button:hover { background: var(--surface-hover); }
.composer-menu button:disabled { cursor: not-allowed; opacity: .48; }
.composer-menu__avatar { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 11px; }
.composer-menu button > span:nth-child(2) { display: flex; min-width: 0; flex: 1; flex-direction: column; }.composer-menu strong { font-size: 11px; }.composer-menu small { overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.composer-menu em { color: var(--text-muted); font-size: 9px; font-style: normal; }
.composer-drop-hint { position: absolute; z-index: 25; inset: 6px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 1px dashed var(--line-strong); border-radius: 13px; background: color-mix(in srgb, var(--chat-composer-bg) 90%, transparent); color: var(--text-secondary); font-size: 12px; backdrop-filter: blur(5px); pointer-events: none; }
.composer-error { position: absolute; right: max(24px, calc((100% - 760px) / 2)); bottom: calc(100% - 8px); max-width: min(420px, calc(100% - 32px)); margin: 0; padding: 7px 10px; border-radius: 8px; background: var(--danger); color: #fff; box-shadow: var(--shadow-float); font-size: 10px; }
.composer-menu-enter-active, .composer-menu-leave-active { transition: opacity 120ms ease, transform 120ms var(--ease-out); }.composer-menu-enter-from, .composer-menu-leave-to { opacity: 0; transform: translateY(4px); }

@media (max-width: 768px) {
  .composer-area { padding: 8px 12px max(12px, env(safe-area-inset-bottom)); }
  .composer-shell { min-height: 118px; }
  .composer-textarea { font-size: 16px; }
  .composer-textarea::placeholder { font-size: 13px; line-height: 1.35; }
  .composer-tool span, .composer-tool > :deep(svg:last-child), .composer-mention-hint span { display: none; }
  .composer-tool { width: 30px; min-width: 30px; padding: 0; }
  .composer-tools { gap: 3px; }
  .composer-toolbar { align-items: flex-end; gap: 7px; }
  .composer-send-hitbox { width: 44px; height: 44px; margin: -5px; }
  .composer-send { width: 34px; min-width: 34px; height: 34px; }
  .composer-menu { left: 6px; right: 6px; }
  .composer-context { font-size: 8px; }
  .composer-context i { display: none; }
  .composer-popover { width: min(220px, calc(100vw - 96px)); }
  .composer-error { right: 12px; }
}

@media (max-width: 360px) {
  .queue-toggle { display: none; }
  .composer-toolbar { gap: 3px; }
}
</style>
