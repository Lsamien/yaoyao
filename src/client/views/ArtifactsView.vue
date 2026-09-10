<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ArtifactKind } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import LibraryGrid from '@/components/library/LibraryGrid.vue'
import LibrarySidebar from '@/components/library/LibrarySidebar.vue'
import PreviewModal from '@/components/library/PreviewModal.vue'
import type { LibraryFilterOption, UiLibraryItem } from '@/components/library/types'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { queueLibraryItemForComposer } from '@/components/workspace/pendingComposer'
import { artifactToUi } from '@/components/workspace/viewModels'
import { useArtifactsStore } from '@/stores/artifacts'
import { useAuthStore } from '@/stores/auth'

const artifacts = useArtifactsStore()
const auth = useAuthStore()
const router = useRouter()
const selected = ref<UiLibraryItem | null>(null)
let searchTimer: number | undefined

const items = computed(() => artifacts.filteredArtifacts.map(artifactToUi))
const options = computed<LibraryFilterOption[]>(() => {
  const count = (kind: string) => artifacts.artifacts.filter(item => item.kind === kind).length
  return [
    { id: 'all', label: '全部产物', count: artifacts.artifacts.length, icon: 'artifacts' },
    { id: 'image', label: '图片', count: count('image'), icon: 'image' },
    { id: 'file', label: '文件', count: count('file'), icon: 'file' },
    { id: 'link', label: '链接', count: count('link'), icon: 'link' },
  ]
})
const progress = computed(() => artifacts.isLoading
  ? `正在读取会话 ${artifacts.loadedSessionCount}/${artifacts.totalSessionCount || '…'}`
  : artifacts.failedSessionCount ? `${artifacts.failedSessionCount} 个会话暂不可读` : artifacts.artifacts.length ? '已完成增量索引' : '')

function updateSearch(value: string) {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => { artifacts.searchQuery = value }, 120)
}

function updateFilter(value: string) { artifacts.kindFilter = value as ArtifactKind | 'all' }

async function addToComposer(item: UiLibraryItem) {
  if (!queueLibraryItemForComposer(item)) return
  await router.push('/chat')
}

async function openSource(item: UiLibraryItem) {
  if (!item.sourceSessionId) return
  if (item.sourceProfile && auth.profiles.some(profile => profile.name === item.sourceProfile)) {
    auth.selectProfile(item.sourceProfile)
  }
  await router.push({
    path: `/chat/${encodeURIComponent(item.sourceSessionId)}`,
    query: {
      ...(item.sourceMessageId ? { message: item.sourceMessageId } : {}),
      ...(item.sourceProfile ? { profile: item.sourceProfile } : {}),
    },
  })
}

onMounted(() => artifacts.load())
onBeforeUnmount(() => window.clearTimeout(searchTimer))
</script>

<template>
  <WorkspaceView sidebar-title="产物" :sidebar-subtitle="`${artifacts.artifacts.length} 项内容`">
    <template #sidebar>
      <LibrarySidebar
        :search="artifacts.searchQuery"
        :filter="artifacts.kindFilter"
        :options="options"
        :loading="artifacts.isLoading"
        :error="artifacts.error"
        :progress="progress"
        @search="updateSearch"
        @filter="updateFilter"
        @refresh="artifacts.refresh"
      />
    </template>
    <section class="library-workspace">
      <header class="library-header"><div><h2>产物</h2><p>从普通会话的机器人与工具消息中提取</p></div><button class="quiet-button" type="button" :disabled="artifacts.isLoading" @click="artifacts.refresh"><AppIcon name="refresh" :size="14" />刷新索引</button></header>
      <LibraryGrid
        kind="artifacts"
        :items="items"
        :selected-id="selected?.id"
        :loading="artifacts.isLoading"
        empty-title="还没有产物"
        empty-description="机器人生成的图片、文件和链接会自动整理到这里。"
        @select="selected = $event"
        @add-to-composer="addToComposer"
        @source="openSource"
      />
    </section>
  </WorkspaceView>
  <PreviewModal v-if="selected" :item="selected" @close="selected = null" @add-to-composer="addToComposer" @source="openSource" />
</template>

<style scoped>
.library-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.library-header { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--line); }.library-header h2 { margin: 0; font-size: 14px; letter-spacing: -.02em; }.library-header p { margin: 3px 0 0; color: var(--text-muted); font-size: 9px; }.library-header .quiet-button { display: flex; gap: 6px; font-size: 10px; }
@media (max-width: 600px) { .library-header { min-height: 54px; padding: 8px 13px; }.library-header .quiet-button { width: 34px; min-width: 34px; padding: 0; font-size: 0; } }
</style>
