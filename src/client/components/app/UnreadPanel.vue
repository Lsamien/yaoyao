<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUnreadStore } from '@/stores/unread'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UnreadConversation, UnreadMode } from '@shared/unread'

const props = defineProps<{ anchor: { left: number; top: number } }>()
const emit = defineEmits<{ close: [] }>()
const unread = useUnreadStore(), auth = useAuthStore(), router = useRouter()
const filter = ref<UnreadMode | 'all'>('all'), busy = ref(false), error = ref('')
const panel = ref<HTMLElement>()
const rows = computed(() => unread.snapshot.conversations.filter(row => filter.value === 'all' || row.mode === filter.value))
const count = computed(() => rows.value.reduce((total, row) => total + row.count, 0))
const filters = computed(() => [
  { key: 'all' as const, label: '全部', count: unread.total },
  { key: 'bot' as const, label: 'Bot', count: unread.snapshot.bot },
  { key: 'chat' as const, label: '聊天', count: unread.snapshot.chat },
])
const position = computed(() => ({ '--unread-left': `${props.anchor.left}px`, '--unread-top': `${props.anchor.top}px` }))

onMounted(() => { panel.value?.focus(); void unread.refresh() })

function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !panel.value) return
  const nodes = [...panel.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const first = nodes[0], last = nodes.at(-1)
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus()
  }
}

async function clear() {
  if (busy.value || !rows.value.length) return
  const snapshot: UnreadConversation[] = JSON.parse(JSON.stringify(rows.value))
  busy.value = true; error.value = ''
  try { await unread.read(snapshot) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '同步失败，请重试' }
  finally { busy.value = false }
}

async function open(row: UnreadConversation) {
  const first = row.messages[0]
  if (!first || busy.value) return
  error.value = ''
  try {
    if (row.mode === 'chat' && row.profile) await auth.selectProfile(row.profile)
    await router.push({
      path: row.mode === 'bot' ? `/conversations/${encodeURIComponent(row.id)}` : `/chat/${encodeURIComponent(row.id)}`,
      query: { ...(row.profile ? { profile: row.profile } : {}), ...(first.taskId ? { taskId: first.taskId } : {}), unread: first.id },
    })
    emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法打开会话，请重试' }
}
</script>

<template>
  <Teleport to="body">
    <div class="unread-overlay" :style="position" @click.self="emit('close')" @keydown.esc.prevent.stop="emit('close')">
      <section id="unread-center" ref="panel" class="unread-panel" role="dialog" aria-modal="true" aria-labelledby="unread-center-title" tabindex="-1" @keydown="trap">
        <header class="unread-header">
          <div>
            <h2 id="unread-center-title">未读消息</h2>
            <p>{{ count }} 条未读 · {{ rows.length }} 个会话</p>
          </div>
          <button class="unread-close" type="button" aria-label="关闭未读消息" @click="emit('close')"><AppIcon name="close" :size="20" /></button>
        </header>
        <div class="unread-controls">
          <div class="unread-filters" role="group" aria-label="消息模式">
            <button v-for="item in filters" :key="item.key" type="button" :aria-pressed="filter === item.key" :disabled="busy" @click="filter = item.key">
              {{ item.label }}<span v-if="item.count" class="unread-filter-count">{{ item.count > 99 ? '99+' : item.count }}</span>
            </button>
          </div>
          <button class="unread-clear" type="button" :disabled="busy || !rows.length" :aria-busy="busy" aria-label="将当前筛选的消息全部标为已读" @click="clear">
            <AppIcon name="check" :size="16" />{{ busy ? '正在同步…' : '全部标已读' }}
          </button>
        </div>
        <p v-if="error || unread.error" class="unread-error" role="alert">{{ error || unread.error }}</p>
        <div class="unread-rows">
          <button v-for="row in rows" :key="`${row.mode}:${row.profile}:${row.id}`" type="button" class="unread-row" :disabled="busy" @click="open(row)">
            <span class="unread-row__icon"><AppIcon :name="row.mode === 'bot' ? 'users' : 'chat'" :size="20" /></span>
            <span class="unread-row__copy">
              <strong :title="row.name">{{ row.name }}</strong>
              <span class="unread-row__meta">{{ row.mode === 'bot' ? 'Bot' : '聊天' }}<template v-if="row.profile"> · {{ row.profile }}</template></span>
              <span class="unread-row__preview">{{ row.preview }}</span>
            </span>
            <b class="unread-row__count" :aria-label="`${row.count} 条未读`">{{ row.count > 99 ? '99+' : row.count }}</b>
          </button>
          <div v-if="!rows.length" class="unread-empty">
            <span class="unread-empty__icon"><AppIcon name="check" :size="24" /></span>
            <strong>暂无未读消息</strong>
            <p>新的回复会显示在这里</p>
          </div>
        </div>
        <footer>打开会话并查看消息后，会自动标为已读。</footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.unread-overlay {
  --unread-panel-top: clamp(16px, var(--unread-top), max(16px, calc(100dvh - 360px)));
  position: fixed;
  inset: 0;
  z-index: 5000;
  background: color-mix(in srgb, var(--scrim) 45%, transparent);
}
.unread-panel {
  position: absolute;
  top: var(--unread-panel-top);
  left: clamp(16px, var(--unread-left), max(16px, calc(100vw - 496px)));
  display: flex;
  width: min(480px, calc(100vw - 32px));
  max-height: min(680px, calc(100dvh - var(--unread-panel-top) - 16px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface-raised);
  color: var(--text-primary);
  box-shadow: var(--shadow-float);
  outline: none;
}
.unread-panel button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.unread-panel button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.unread-panel button:disabled { opacity: .45; cursor: default; }
.unread-header { display: flex; flex-shrink: 0; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 22px 18px; }
.unread-header h2 { margin: 0; font-size: 18px; font-weight: 650; line-height: 1.4; }
.unread-header p { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.unread-close { display: grid; width: 36px; height: 36px; flex: 0 0 36px; place-items: center; border-radius: 9px; }
.unread-close:hover { background: var(--surface-hover); }
.unread-controls { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px 16px; border-bottom: 1px solid var(--line); }
.unread-filters { display: flex; min-width: 0; gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface-soft); }
.unread-filters button { display: flex; min-height: 32px; align-items: center; justify-content: center; gap: 5px; padding: 5px 10px; border-radius: 7px; color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
.unread-filters button:hover:not(:disabled) { color: var(--text-primary); }
.unread-filters button[aria-pressed="true"] { background: var(--surface-raised); color: var(--text-primary); box-shadow: 0 1px 4px color-mix(in srgb, var(--accent) 10%, transparent); }
.unread-filter-count { font-size: 11px; font-variant-numeric: tabular-nums; }
.unread-panel .unread-clear { display: inline-flex; min-height: 36px; flex-shrink: 0; align-items: center; gap: 5px; padding: 6px 7px; border-radius: 8px; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.unread-clear:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
.unread-error { margin: 0; padding: 12px 22px; color: var(--danger); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.unread-rows { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px; }
.unread-panel .unread-row { display: flex; width: 100%; align-items: flex-start; gap: 12px; padding: 14px; border-radius: 10px; text-align: left; }
.unread-row:hover:not(:disabled) { background: var(--surface-hover); }
.unread-row__icon { display: grid; width: 40px; height: 40px; flex: 0 0 40px; place-items: center; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); color: var(--text-secondary); }
.unread-row__copy { min-width: 0; flex: 1; }
.unread-row strong { display: block; overflow: hidden; font-size: 14px; line-height: 1.5; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.unread-row__meta { display: block; margin-top: 3px; color: var(--text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.unread-row__preview { display: -webkit-box; margin-top: 6px; overflow: hidden; color: var(--text-secondary); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.unread-row__count { min-width: 24px; flex-shrink: 0; margin-top: 2px; padding: 3px 7px; border-radius: 20px; background: var(--accent); color: var(--text-on-solid); font-size: 12px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.unread-empty { display: flex; min-height: 240px; flex-direction: column; align-items: center; justify-content: center; padding: 32px; text-align: center; }
.unread-empty__icon { display: grid; width: 52px; height: 52px; place-items: center; margin-bottom: 16px; border-radius: 50%; background: var(--surface-soft); color: var(--text-secondary); }
.unread-empty strong { font-size: 14px; font-weight: 500; }
.unread-empty p { margin: 8px 0 0; color: var(--text-secondary); font-size: 13px; }
.unread-panel footer { flex-shrink: 0; padding: 14px 22px; border-top: 1px solid var(--line); color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
@media (max-width: 900px) {
  .unread-panel { top: 50%; left: 50%; max-height: calc(100dvh - 32px); transform: translate(-50%, -50%); }
}
@media (max-width: 480px) {
  .unread-controls { flex-wrap: wrap; }
  .unread-close { width: 44px; height: 44px; flex-basis: 44px; }
  .unread-filters button, .unread-panel .unread-clear { min-height: 44px; }
}
</style>
