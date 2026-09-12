<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import type { SidebarItem } from './types'

const SIDEBAR_SEARCH_EVENT = 'hermes-yaoyao:sidebar-search'
const SIDEBAR_SEARCH_CLOSE_EVENT = 'hermes-yaoyao:sidebar-search-close'

const props = withDefaults(defineProps<{
  items: SidebarItem[]
  activeId?: string
  loading?: boolean
  searchable?: boolean
  externalSearch?: boolean
  search?: string
  searchPlaceholder?: string
  emptyTitle?: string
  emptyDescription?: string
  singleLine?: boolean
  avatarSize?: number
  hasMore?: boolean
  loadingMore?: boolean
}>(), {
  activeId: '',
  loading: false,
  searchable: true,
  externalSearch: false,
  search: '',
  searchPlaceholder: '搜索',
  emptyTitle: '暂无内容',
  emptyDescription: '新建一项开始使用。',
  singleLine: false,
  avatarSize: 23,
  hasMore: false,
  loadingMore: false,
})

const emit = defineEmits<{
  select: [id: string]
  search: [value: string]
  more: [id: string, event: MouseEvent]
  contextMenu: [id: string, event: MouseEvent]
  toggle: [id: string]
  loadMore: []
}>()

const searchInput = ref<HTMLInputElement | null>(null)
const searchOpen = ref(Boolean(props.search))
const sectionCounts = computed(() => props.items.reduce<Record<string, number>>((counts, item) => {
  if (item.section && !item.nested) counts[item.section] = (counts[item.section] ?? 0) + 1
  return counts
}, {}))
const sidebarRows = computed(() => props.items.map((item, index) => ({
  item,
  section: item.section && item.section !== props.items[index - 1]?.section ? item.section : '',
  sectionLabel: item.section === '已置顶' ? `已置顶 ${sectionCounts.value[item.section] ?? 0}` : item.section || '',
})))

async function focusSearch() {
  if (!props.searchable) return
  searchOpen.value = true
  await nextTick()
  const input = searchInput.value
  if (!input || input.offsetParent === null) return
  input.focus()
  input.select()
}

function handleSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  emit('search', value)
  if (!value) searchOpen.value = false
}

function closeSearch(clear = false) {
  if (clear) emit('search', '')
  searchOpen.value = false
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
}

function handleSearchRequest() { if (!props.externalSearch) void focusSearch() }
function handleSearchCloseRequest() { searchOpen.value = false }
function handleListScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  if (props.hasMore && !props.loadingMore && element.scrollHeight - element.scrollTop - element.clientHeight < 96) {
    emit('loadMore')
  }
}

watch(() => props.search, value => {
  if (value) searchOpen.value = true
})

onMounted(() => {
  document.addEventListener(SIDEBAR_SEARCH_EVENT, handleSearchRequest)
  document.addEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSearchCloseRequest)
})
onBeforeUnmount(() => {
  document.removeEventListener(SIDEBAR_SEARCH_EVENT, handleSearchRequest)
  document.removeEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSearchCloseRequest)
})

defineExpose({ focusSearch })
</script>

<template>
  <div class="resource-sidebar">
    <Transition name="search-reveal">
      <label v-if="searchable && !externalSearch && searchOpen" class="sidebar-search">
        <AppIcon name="search" :size="15" />
        <input
          ref="searchInput"
          :value="search"
          type="search"
          :placeholder="searchPlaceholder"
          @input="handleSearchInput"
          @keydown.esc.prevent="closeSearch(true)"
          @blur="!search && closeSearch()"
        />
      </label>
    </Transition>
    <div class="sidebar-list" role="listbox" aria-label="资源列表" @scroll.passive="handleListScroll">
      <div v-if="loading && !items.length" class="sidebar-loading" aria-label="正在加载">
        <span v-for="n in 7" :key="n" class="sidebar-skeleton" :style="{ opacity: 1 - n * .08 }" />
      </div>
      <template v-else>
        <template v-for="row in sidebarRows" :key="row.item.id">
          <div v-if="row.section" class="sidebar-section-label" :class="{ 'sidebar-section-label--pinned': row.section === '已置顶' }" role="presentation"><span>{{ row.sectionLabel }}</span></div>
          <div
            class="sidebar-item"
            :class="{ active: row.item.id === activeId || row.item.active, 'sidebar-item--single-line': singleLine, 'sidebar-item--nested': row.item.nested, 'sidebar-item--topic': row.item.topic, 'sidebar-item--expandable': row.item.expandable }"
            role="option"
            tabindex="0"
            :aria-selected="row.item.id === activeId || row.item.active"
            :data-sidebar-id="row.item.id"
            @click="emit('select', row.item.id)"
            @contextmenu.prevent.stop="emit('contextMenu', row.item.id, $event)"
            @keydown.enter.prevent="emit('select', row.item.id)"
            @keydown.space.prevent="emit('select', row.item.id)"
          >
            <button
              v-if="row.item.expandable"
              class="sidebar-item__expand"
              :class="{ 'sidebar-item__expand--collapsed': !row.item.expanded }"
              type="button"
              :aria-label="`${row.item.expanded ? '收起' : '展开'} ${row.item.title} 的话题`"
              :aria-expanded="row.item.expanded"
              @click.stop="emit('toggle', row.item.id)"
            >
              <AppIcon name="chevron-down" :size="13" />
            </button>
            <span v-if="!singleLine" class="sidebar-item__icon" :class="{ 'sidebar-item__icon--avatar': !row.item.icon }">
              <AgentAvatar v-if="row.item.avatarKind === 'agent'" :name="row.item.title" :avatar="row.item.avatar" :state="row.item.avatarState" :activity-key="row.item.avatarActivityKey" :size="avatarSize" />
              <TeamAvatar v-else-if="row.item.avatar !== undefined || row.item.avatarMembers?.length" :name="row.item.title" :avatar="row.item.avatar || ''" :members="row.item.avatarMembers || []" :fallback-key="row.item.avatarFallbackKey || row.item.id" :size="avatarSize" />
              <AppIcon v-else-if="row.item.icon" :name="row.item.icon" :size="row.item.topic ? 14 : 15" />
              <template v-else>{{ row.item.title.slice(0, 1).toUpperCase() }}</template>
              <span v-if="row.item.status" class="presence" :class="`presence--${row.item.status}`" />
            </span>
            <span class="sidebar-item__copy">
              <span class="sidebar-item__row">
                <strong><AppIcon v-if="row.item.pinned" name="pin-filled" :size="12" />{{ row.item.title }}</strong>
                <small v-if="row.item.meta">{{ row.item.meta }}</small>
              </span>
              <span v-if="!singleLine && row.item.subtitle" class="sidebar-item__row sidebar-item__row--secondary">
                <span>{{ row.item.subtitle }}</span>
                <i v-if="row.item.unreadDot" class="sidebar-unread-dot" role="img" aria-label="未读" />
                <b v-else-if="row.item.unread">{{ row.item.unread > 99 ? '99+' : row.item.unread }}</b>
              </span>
            </span>
            <button v-if="row.item.showMore !== false" class="sidebar-item__more" type="button" aria-label="更多操作" @click.stop="emit('more', row.item.id, $event)">
              <AppIcon name="dots" :size="16" />
            </button>
          </div>
        </template>
      </template>
      <button v-if="hasMore" class="sidebar-load-more" type="button" :disabled="loadingMore" @click="emit('loadMore')">
        {{ loadingMore ? '正在加载更多…' : '继续加载会话' }}
      </button>
      <div v-if="!loading && !items.length" class="sidebar-empty">
        <span><AppIcon name="chat" :size="20" /></span>
        <strong>{{ emptyTitle }}</strong>
        <p>{{ emptyDescription }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resource-sidebar { display: flex; height: 100%; min-height: 0; flex-direction: column; }
.sidebar-search { display: flex; align-items: center; gap: 8px; min-height: 35px; margin: 0 11px 10px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; color: var(--text-muted); background: var(--surface-soft); }
.sidebar-search:focus-within { border-color: var(--line-strong); background: var(--surface-raised); box-shadow: 0 0 0 3px var(--focus-ring); }
.sidebar-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 13px; }
.sidebar-search input::placeholder { color: var(--text-muted); }
.search-reveal-enter-active, .search-reveal-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.search-reveal-enter-from, .search-reveal-leave-to { opacity: 0; transform: translateY(-3px); }
.sidebar-list { min-height: 0; flex: 1; overflow: auto; padding: 0 7px 14px; scrollbar-gutter: stable; }
.sidebar-section-label { display: flex; align-items: center; gap: 8px; min-height: 25px; padding: 7px 8px 3px; color: var(--text-muted); font-size: 10px; font-weight: 560; }
.sidebar-section-label::after { height: 1px; flex: 1; background: var(--line); content: ''; }
.sidebar-section-label--pinned { min-height: 28px; padding-top: 9px; color: var(--text-secondary); font-size: 11px; font-weight: 650; }
.sidebar-section-label--pinned::after { background: transparent; }
.sidebar-item { position: relative; display: flex; align-items: center; gap: 7px; width: 100%; min-height: 42px; padding: 4px 7px; border: 0; border-radius: 8px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; transition: background-color 120ms ease, color 120ms ease; }
.sidebar-item:hover { background: var(--surface-soft); }
.sidebar-item.active { background: var(--surface-hover); }
.sidebar-item--single-line { min-height: 31px; padding-block: 1px; }
.sidebar-item--single-line .sidebar-item__copy { display: block; }
.sidebar-item--single-line .sidebar-item__row { min-height: 27px; }
.sidebar-item--single-line .sidebar-item__row strong { font-size: 14px; font-weight: 400; }
.sidebar-item--single-line .sidebar-item__more { top: 1px; }
.sidebar-item--nested { min-height: 32px; margin-left: 17px; width: calc(100% - 17px); padding-block: 1px; }
.sidebar-item--nested .sidebar-item__icon { width: 19px; height: 19px; flex-basis: 19px; border-radius: 6px; color: var(--text-muted); }
.sidebar-item--nested .sidebar-item__row { min-height: 25px; }
.sidebar-item--nested .sidebar-item__row strong { font-size: 11.5px; font-weight: 500; }
.sidebar-item--nested .sidebar-item__row--secondary { display: none; }
.sidebar-item--nested .sidebar-item__more { display: none; }
.sidebar-item--topic .sidebar-item__row strong { font-size: 14px; font-weight: 450; }
.sidebar-item__expand { display: grid; width: 18px; height: 24px; flex: 0 0 18px; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; }.sidebar-item__expand:hover, .sidebar-item__expand:focus-visible { outline: 0; background: var(--surface-hover); color: var(--text-primary); }.sidebar-item__expand :deep(.app-icon) { transition: transform 120ms ease; }.sidebar-item__expand--collapsed :deep(.app-icon) { transform: rotate(-90deg); }
.sidebar-item__icon { position: relative; display: grid; place-items: center; width: 23px; height: 23px; flex: 0 0 23px; border: 0; border-radius: 7px; color: var(--text-muted); background: transparent; }
.sidebar-item.active .sidebar-item__icon, .sidebar-item:hover .sidebar-item__icon { color: var(--text-secondary); }
.sidebar-item__icon--avatar { background: transparent; color: var(--text-secondary); font-size: 10px; font-weight: 700; }
.presence { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border: 2px solid var(--surface); border-radius: 50%; background: var(--text-muted); }
.presence--online { background: var(--success); }.presence--working { background: var(--warning); }.presence--offline { background: var(--text-muted); }
.sidebar-item__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
.sidebar-item__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.sidebar-item__row strong, .sidebar-item__row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-item__row strong { display: flex; min-width: 0; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 570; }
.sidebar-item__row strong :deep(.app-icon) { color: var(--text-muted); }
.sidebar-item__row small { flex: 0 0 auto; color: var(--text-muted); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.sidebar-item__row--secondary { color: var(--text-muted); font-size: 10.5px; line-height: 13px; }
.sidebar-item__row b { display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--accent); color: var(--text-on-solid); font-size: 9px; }
.sidebar-unread-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--accent); }
.sidebar-item__more { display: none; position: absolute; right: 5px; top: 7px; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: var(--surface-raised); color: var(--text-secondary); cursor: pointer; box-shadow: 0 1px 5px rgba(0,0,0,.07); }
.sidebar-item:hover .sidebar-item__more, .sidebar-item:focus-within .sidebar-item__more { display: grid; }
.sidebar-load-more { display: block; width: calc(100% - 14px); min-height: 32px; margin: 8px 7px 2px; border: 0; border-radius: 8px; background: var(--surface-soft); color: var(--text-secondary); cursor: pointer; font: 11px var(--font-ui); }
.sidebar-load-more:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }.sidebar-load-more:disabled { cursor: progress; opacity: .7; }
.sidebar-loading { display: flex; flex-direction: column; gap: 4px; padding: 2px; }
.sidebar-skeleton { height: 38px; border-radius: 8px; background: linear-gradient(90deg, var(--surface-soft), var(--surface-hover), var(--surface-soft)); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
.sidebar-empty { display: grid; place-items: center; padding: 45px 22px; color: var(--text-muted); text-align: center; }
.sidebar-empty > span { display: grid; place-items: center; width: 38px; height: 38px; margin-bottom: 10px; border-radius: 12px; background: var(--surface-soft); }
.sidebar-empty strong { color: var(--text-secondary); font-size: 13px; }.sidebar-empty p { margin: 5px 0 0; font-size: 11px; line-height: 1.5; }
@media (prefers-reduced-motion: reduce) { .sidebar-item, .search-reveal-enter-active, .search-reveal-leave-active { transition: none; } }
</style>
