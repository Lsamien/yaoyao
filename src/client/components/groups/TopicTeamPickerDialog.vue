<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GroupRoomSummary } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'

const props = withDefaults(defineProps<{
  open: boolean
  rooms: GroupRoomSummary[]
  currentRoomId?: string
}>(), { currentRoomId: '' })

const emit = defineEmits<{ close: []; select: [roomId: string] }>()
const expandedRoomId = ref('')

function close() { emit('close') }
function toggleDetails(roomId: string) {
  expandedRoomId.value = expandedRoomId.value === roomId ? '' : roomId
}
function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') close()
}

watch(() => props.open, open => { if (open) expandedRoomId.value = '' })
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="topic-team-picker-fade">
      <div v-if="open" class="topic-team-picker-layer" role="presentation" @mousedown.self="close">
        <section class="topic-team-picker" role="dialog" aria-modal="true" aria-labelledby="topic-team-picker-title">
          <header>
            <div><small>新建话题</small><h2 id="topic-team-picker-title">选择团队</h2></div>
            <button class="icon-button" type="button" aria-label="关闭" @click="close"><AppIcon name="close" :size="17" /></button>
          </header>
          <p class="topic-team-picker__hint">话题将创建在所选团队中。</p>
          <div class="topic-team-picker__list">
            <article v-for="room in rooms" :key="room.id" :class="{ current: room.id === currentRoomId, expanded: expandedRoomId === room.id }">
              <button class="topic-team-picker__choose" type="button" @click="emit('select', room.id)">
                <TeamAvatar :name="room.name" :avatar="room.avatar || ''" :members="room.avatarMembers?.map(member => ({ name: member.displayName })) || []" :fallback-key="room.id" :size="34" />
                <span class="topic-team-picker__copy"><strong>{{ room.name }}</strong><small>{{ room.agentCount }} 个机器人</small></span>
                <em v-if="room.id === currentRoomId">当前</em>
                <AppIcon class="topic-team-picker__next" name="chevron-left" :size="15" />
              </button>
              <button class="topic-team-picker__details-trigger" type="button" :aria-expanded="expandedRoomId === room.id" :aria-label="`${expandedRoomId === room.id ? '收起' : '查看'}${room.name}详情`" @click="toggleDetails(room.id)">
                详情<AppIcon name="chevron-down" :size="13" />
              </button>
              <section v-if="expandedRoomId === room.id" class="topic-team-picker__details" :aria-label="`${room.name}团队详情`">
                <p><strong>团队说明</strong><span>{{ room.instructions || '未填写团队说明' }}</span></p>
                <dl>
                  <div><dt>成员</dt><dd>{{ room.avatarMembers?.map(member => member.displayName).join('、') || `${room.agentCount} 个机器人` }}</dd></div>
                  <div><dt>协作方式</dt><dd>{{ room.orchestrationMode === 'host' ? '管理员协调' : '自由讨论' }}</dd></div>
                  <div><dt>最多回复</dt><dd>{{ room.maxReplyRounds }} 轮</dd></div>
                </dl>
              </section>
            </article>
          </div>
          <p v-if="!rooms.length" class="topic-team-picker__empty">当前没有可用团队，请先新建团队。</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.topic-team-picker-layer { position: fixed; z-index: 230; inset: 0; display: grid; place-items: center; padding: 16px; background: var(--scrim); backdrop-filter: blur(4px); }
.topic-team-picker { display: flex; width: min(420px, calc(100vw - 32px)); max-height: min(600px, calc(100dvh - 32px)); padding: 14px; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: var(--shadow-float); flex-direction: column; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 2px 2px 10px 7px; } header small { color: var(--text-muted); font-size: 10px; letter-spacing: .04em; } h2 { margin: 3px 0 0; color: var(--text-primary); font-size: 18px; font-weight: 680; letter-spacing: -.025em; }
.icon-button { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.icon-button:hover, .icon-button:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }
.topic-team-picker__hint { margin: 0 7px 10px; color: var(--text-muted); font-size: 11px; }
.topic-team-picker__list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.topic-team-picker__list article { display: grid; position: relative; grid-template-columns: minmax(0, 1fr) auto; border-radius: 10px; }.topic-team-picker__list article:hover, .topic-team-picker__list article:focus-within { background: var(--surface-soft); }.topic-team-picker__list article.current { background: color-mix(in srgb, var(--accent) 7%, transparent); }.topic-team-picker__list article.expanded { margin-bottom: 4px; background: var(--surface-soft); }
.topic-team-picker__choose { display: flex; min-width: 0; min-height: 52px; align-items: center; gap: 10px; padding: 7px 4px 7px 9px; border: 0; border-radius: 10px 0 0 10px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.topic-team-picker__choose:focus-visible, .topic-team-picker__details-trigger:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--line-strong); }
.topic-team-picker__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.topic-team-picker__copy strong, .topic-team-picker__copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.topic-team-picker__copy strong { font-size: 14px; font-weight: 620; }.topic-team-picker__copy small { color: var(--text-muted); font-size: 10px; font-weight: 400; }.topic-team-picker__choose em { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 9px; font-style: normal; font-weight: 620; }.topic-team-picker__list :deep(.app-icon) { flex: 0 0 auto; color: var(--text-muted); }
.topic-team-picker__details-trigger { display: flex; min-width: 54px; align-items: center; justify-content: center; gap: 3px; padding: 0 7px; border: 0; border-radius: 0 10px 10px 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; }.topic-team-picker__details-trigger :deep(.app-icon) { transition: transform 120ms ease; }.topic-team-picker__details-trigger[aria-expanded="true"] :deep(.app-icon) { transform: rotate(180deg); }
.topic-team-picker__details { grid-column: 1 / -1; margin: 0 9px 9px; padding: 10px; border-top: 1px solid var(--line); color: var(--text-secondary); }.topic-team-picker__details p { display: grid; gap: 4px; margin: 0 0 9px; }.topic-team-picker__details p strong { font-size: 10px; }.topic-team-picker__details p span { color: var(--text-muted); font-size: 10px; line-height: 1.5; }.topic-team-picker__details dl { display: grid; gap: 6px; margin: 0; }.topic-team-picker__details dl div { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 8px; font-size: 10px; }.topic-team-picker__details dt { color: var(--text-muted); }.topic-team-picker__details dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.topic-team-picker__next { transform: rotate(180deg); }
.topic-team-picker__empty { margin: 0; padding: 34px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
.topic-team-picker-fade-enter-active, .topic-team-picker-fade-leave-active { transition: opacity 130ms ease; }.topic-team-picker-fade-enter-active .topic-team-picker, .topic-team-picker-fade-leave-active .topic-team-picker { transition: transform 160ms var(--ease-out); }.topic-team-picker-fade-enter-from, .topic-team-picker-fade-leave-to { opacity: 0; }.topic-team-picker-fade-enter-from .topic-team-picker, .topic-team-picker-fade-leave-to .topic-team-picker { transform: translateY(7px) scale(.99); }
@media (max-width: 600px) { .topic-team-picker-layer { padding: 12px; }.topic-team-picker { width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); } }
@media (prefers-reduced-motion: reduce) { .topic-team-picker-fade-enter-active, .topic-team-picker-fade-leave-active, .topic-team-picker-fade-enter-active .topic-team-picker, .topic-team-picker-fade-leave-active .topic-team-picker { transition: none; } }
</style>
