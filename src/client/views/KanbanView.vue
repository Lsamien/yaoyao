<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CreateKanbanBoardInput, CreateKanbanTaskInput, KanbanTask, UpdateKanbanTaskInput } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import KanbanBoardDialog from '@/components/kanban/KanbanBoardDialog.vue'
import KanbanColumn from '@/components/kanban/KanbanColumn.vue'
import KanbanTaskDialog from '@/components/kanban/KanbanTaskDialog.vue'
import KanbanTaskDrawer from '@/components/kanban/KanbanTaskDrawer.vue'
import { formatKanbanTime, statusMeta } from '@/components/kanban/presentation'
import { useKanbanStore } from '@/stores/kanban'
import { useAuthStore } from '@/stores/auth'

const kanban = useKanbanStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const boardDialogOpen = ref(false)
const taskDialogOpen = ref(false)
const taskTargetStatus = ref('ready')
const dialogError = ref('')

const columnNames = computed(() => kanban.snapshot?.columns.map(column => column.name) ?? [])
const visibleTaskCount = computed(() => kanban.filteredColumns.reduce((total, column) => total + column.tasks.length, 0))
const lastUpdated = computed(() => kanban.lastUpdatedAt ? new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(kanban.lastUpdatedAt) : '')

async function chooseBoard(slug: string): Promise<void> {
  await kanban.selectBoard(slug)
  await router.push(`/kanban/${encodeURIComponent(slug)}`)
}

async function reconcileBoardRoute(value: unknown = route.params.boardSlug): Promise<void> {
  if (kanban.availability !== 'available') return
  const requested = typeof value === 'string' ? value : ''
  if (requested && kanban.boards.some(board => board.slug === requested)) {
    if (requested !== kanban.selectedBoardSlug) await kanban.selectBoard(requested)
    return
  }
  if (kanban.selectedBoardSlug) {
    await router.replace(`/kanban/${encodeURIComponent(kanban.selectedBoardSlug)}`)
  }
}

function openTaskCreate(status = 'ready'): void {
  taskTargetStatus.value = status
  dialogError.value = ''
  taskDialogOpen.value = true
}

async function createTask(input: CreateKanbanTaskInput, status: string): Promise<void> {
  dialogError.value = ''
  try {
    const task = await kanban.createTask(input, status)
    taskDialogOpen.value = false
    if (task) await kanban.selectTask(task.id)
  } catch (cause) {
    dialogError.value = cause instanceof Error ? cause.message : '创建任务失败'
  }
}

async function createBoard(input: CreateKanbanBoardInput): Promise<void> {
  dialogError.value = ''
  try {
    const board = await kanban.createBoard(input)
    boardDialogOpen.value = false
    await router.replace(`/kanban/${encodeURIComponent(board.slug)}`)
  } catch (cause) {
    dialogError.value = cause instanceof Error ? cause.message : '创建看板失败'
  }
}

async function openTask(task: KanbanTask): Promise<void> {
  await kanban.selectTask(task.id)
}

async function moveTask(task: KanbanTask, status: string): Promise<void> {
  try { await kanban.moveTask(task, status) } catch { /* store exposes the error */ }
}

async function dropTask(id: string, status: string): Promise<void> {
  const task = kanban.allTasks.find(item => item.id === id)
  if (task) await moveTask(task, status)
}

async function saveTask(input: UpdateKanbanTaskInput): Promise<void> {
  try { await kanban.updateTask(input) } catch { /* task drawer keeps the authoritative detail */ }
}

async function addComment(body: string): Promise<void> {
  try { await kanban.comment(body) } catch { /* store exposes the error */ }
}

async function deleteTask(): Promise<void> {
  if (!window.confirm('确定删除这个任务吗？此操作无法恢复。')) return
  try { await kanban.deleteTask() } catch { /* store exposes the error */ }
}

async function dispatchNow(): Promise<void> {
  if (!window.confirm('立即运行一次看板调度？就绪任务可能马上启动机器人。')) return
  try { await kanban.dispatch() } catch { /* store exposes the error */ }
}

onMounted(async () => {
  await kanban.initialize()
  await reconcileBoardRoute()
})

watch(() => route.params.boardSlug, reconcileBoardRoute)

watch(
  () => `${auth.isAuthenticated ? 'authenticated' : 'anonymous'}:${auth.user?.id || ''}`,
  async (identity, previous) => {
    if (identity === previous) return
    kanban.reset()
    if (auth.isAuthenticated) {
      await kanban.initialize()
      await reconcileBoardRoute()
    }
  },
)

onBeforeUnmount(() => kanban.reset())
</script>

<template>
  <WorkspaceView
    sidebar-title="看板"
    :sidebar-subtitle="`${kanban.boards.length} 个看板`"
    :inspector-open="Boolean(kanban.selectedTaskId)"
    inspector-close-label="关闭任务详情"
    @close-inspector="kanban.closeTask"
  >
    <template #sidebar-action>
      <button v-if="kanban.canEdit" type="button" @click="dialogError = ''; boardDialogOpen = true">
        <YaoYaoSidebarIcon name="add" /><span>新建看板</span>
      </button>
    </template>
    <template #sidebar>
      <div class="kanban-board-list" role="listbox" aria-label="选择看板">
        <button
          v-for="board in kanban.boards"
          :key="board.slug"
          type="button"
          role="option"
          :aria-selected="board.slug === kanban.selectedBoardSlug"
          :class="{ active: board.slug === kanban.selectedBoardSlug }"
          @click="chooseBoard(board.slug)"
        >
          <span class="kanban-board-list__icon"><AppIcon name="board" :size="16" /></span>
          <span><strong>{{ board.name || board.slug }}</strong><small>{{ board.description || board.slug }}</small></span>
          <em>{{ board.total ?? 0 }}</em>
        </button>
        <p v-if="!kanban.boards.length && kanban.availability === 'available'">还没有看板。</p>
      </div>
    </template>

    <section class="kanban-workspace">
      <div v-if="kanban.availability === 'checking'" class="kanban-page-state">正在连接 9119 看板…</div>
      <EmptyState
        v-else-if="kanban.availability !== 'available'"
        icon="alert"
        :title="kanban.availability === 'unsupported' ? 'Kanban 插件未启用' : '看板服务暂不可用'"
        :description="kanban.error || '请确认 9119 已安装并启用 Kanban 插件。'"
        action-label="重新检查"
        @action="kanban.initialize"
      />
      <template v-else>
        <header class="kanban-header">
          <div class="kanban-header__title">
            <span><AppIcon name="board" :size="16" /></span>
            <div><h1>{{ kanban.selectedBoard?.name || kanban.selectedBoardSlug || '看板' }}</h1><p>{{ kanban.selectedBoard?.description || `${kanban.snapshot?.columns.length ?? 0} 个状态 · ${kanban.pluginVersion ? `Kanban ${kanban.pluginVersion}` : '9119'}` }}</p></div>
          </div>
          <div class="kanban-header__actions">
            <span v-if="lastUpdated">{{ lastUpdated }} 已同步</span>
            <button type="button" title="刷新看板" aria-label="刷新看板" :disabled="kanban.isLoading" @click="kanban.refreshBoard()"><AppIcon name="refresh" :size="15" /></button>
            <button v-if="kanban.canEdit" type="button" class="quiet-action" :disabled="kanban.isMutating" @click="dispatchNow"><AppIcon name="bolt" :size="14" />立即调度</button>
            <button v-if="kanban.canEdit" type="button" class="primary-action" @click="openTaskCreate('ready')"><AppIcon name="plus" :size="14" />新建任务</button>
          </div>
        </header>

        <div v-if="!kanban.canEdit" class="kanban-readonly-banner"><AppIcon name="alert" :size="14" /><span>当前账号可查看完整看板；移动、创建、编辑、评论和调度仅限管理员。</span></div>
        <div v-if="kanban.error" class="kanban-error-banner" role="alert"><AppIcon name="alert" :size="14" /><span>{{ kanban.error }}</span></div>

        <div class="kanban-filters">
          <label class="kanban-search"><AppIcon name="search" :size="14" /><input v-model="kanban.search" type="search" placeholder="搜索标题、描述或任务 ID" /></label>
          <label><span>机器人</span><select v-model="kanban.assignee"><option value="">全部</option><option v-for="value in kanban.snapshot?.assignees || []" :key="value" :value="value">{{ value }}</option></select></label>
          <label><span>租户</span><select v-model="kanban.tenant"><option value="">全部</option><option v-for="value in kanban.snapshot?.tenants || []" :key="value" :value="value">{{ value }}</option></select></label>
          <label class="kanban-archived-toggle"><input :checked="kanban.includeArchived" type="checkbox" @change="kanban.setIncludeArchived(($event.target as HTMLInputElement).checked)" /><span>显示归档</span></label>
          <span class="kanban-filter-count">{{ visibleTaskCount }} 项</span>
        </div>

        <div v-if="kanban.isLoading && !kanban.snapshot" class="kanban-page-state">正在读取看板…</div>
        <div v-else-if="kanban.snapshot" class="kanban-columns" aria-label="任务看板">
          <KanbanColumn
            v-for="column in kanban.filteredColumns"
            :key="column.name"
            :column="column"
            :columns="columnNames"
            :can-edit="kanban.canEdit"
            @add="openTaskCreate"
            @open="openTask"
            @move="moveTask"
            @drop-task="dropTask"
          />
        </div>
      </template>
    </section>

    <template #inspector>
      <KanbanTaskDrawer
        :detail="kanban.selectedTask"
        :profiles="kanban.profiles"
        :columns="columnNames"
        :can-edit="kanban.canEdit"
        :busy="kanban.isMutating"
        :loading="kanban.isTaskLoading"
        :error="kanban.taskError || kanban.error"
        @save="saveTask"
        @comment="addComment"
        @delete="deleteTask"
      />
    </template>
  </WorkspaceView>

  <KanbanTaskDialog
    :open="taskDialogOpen"
    :target-status="taskTargetStatus"
    :columns="columnNames"
    :profiles="kanban.profiles"
    :busy="kanban.isMutating"
    :error="dialogError"
    @close="taskDialogOpen = false"
    @create="createTask"
  />
  <KanbanBoardDialog
    :open="boardDialogOpen"
    :busy="kanban.isMutating"
    :error="dialogError"
    @close="boardDialogOpen = false"
    @create="createBoard"
  />
</template>

<style scoped>
.kanban-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; background: var(--canvas); }.kanban-page-state { display: grid; min-height: 260px; flex: 1; place-items: center; color: var(--text-muted); font-size: 11px; }
.kanban-board-list { display: flex; min-height: 0; height: 100%; padding: 2px 10px 12px; flex-direction: column; gap: 2px; overflow-y: auto; }.kanban-board-list > button { display: flex; width: 100%; min-height: 48px; align-items: center; gap: 8px; padding: 6px 8px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.kanban-board-list > button:hover, .kanban-board-list > button.active { background: var(--surface-soft); }.kanban-board-list__icon { display: grid; width: 28px; height: 28px; flex: 0 0 28px; place-items: center; border-radius: 8px; background: var(--surface-raised); color: var(--text-secondary); }.kanban-board-list > button > span:nth-child(2) { display: flex; min-width: 0; flex: 1; flex-direction: column; }.kanban-board-list strong, .kanban-board-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.kanban-board-list strong { font-size: 12px; font-weight: 620; }.kanban-board-list small { margin-top: 2px; color: var(--text-muted); font-size: 9px; }.kanban-board-list em { color: var(--text-muted); font-size: 9px; font-style: normal; font-variant-numeric: tabular-nums; }.kanban-board-list > p { padding: 20px 10px; color: var(--text-muted); font-size: 10px; text-align: center; }
.kanban-header { display: flex; min-height: 62px; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 14px; padding: 9px 16px 9px 18px; border-bottom: 1px solid var(--line); background: var(--surface); }.kanban-header__title { display: flex; min-width: 0; align-items: center; gap: 9px; }.kanban-header__title > span { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border-radius: 9px; background: var(--surface-soft); color: var(--text-secondary); }.kanban-header__title > div { min-width: 0; }.kanban-header h1 { margin: 0; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }.kanban-header p { margin: 3px 0 0; overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.kanban-header__actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }.kanban-header__actions > span { margin-right: 3px; color: var(--text-muted); font-size: 8px; }.kanban-header__actions button { display: flex; min-height: 34px; align-items: center; justify-content: center; gap: 5px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 10px; font-weight: 650; }.kanban-header__actions button[aria-label="刷新看板"] { width: 34px; padding: 0; }.kanban-header__actions button:hover { background: var(--surface-soft); }.kanban-header__actions .primary-action { border-color: var(--accent); background: var(--accent); color: white; }.kanban-header__actions button:disabled { cursor: not-allowed; opacity: .5; }
.kanban-readonly-banner, .kanban-error-banner { display: flex; min-height: 34px; flex: 0 0 auto; align-items: center; gap: 7px; padding: 6px 18px; border-bottom: 1px solid var(--line); background: var(--surface-soft); color: var(--text-secondary); font-size: 9.5px; }.kanban-error-banner { background: color-mix(in srgb, var(--danger) 8%, var(--surface)); color: var(--danger); }
.kanban-filters { display: flex; min-height: 48px; flex: 0 0 auto; align-items: center; gap: 7px; padding: 7px 16px 7px 18px; border-bottom: 1px solid var(--line); background: var(--surface); overflow-x: auto; }.kanban-filters > label:not(.kanban-search):not(.kanban-archived-toggle) { display: flex; align-items: center; gap: 5px; }.kanban-filters label > span { color: var(--text-muted); font-size: 8.5px; white-space: nowrap; }.kanban-filters select { min-height: 31px; max-width: 130px; padding: 0 25px 0 8px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--surface-raised); color: var(--text-secondary); font: inherit; font-size: 9.5px; }.kanban-search { display: flex; width: min(280px, 32vw); min-height: 32px; flex: 0 0 auto; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-muted); }.kanban-search:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.kanban-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; font-size: 10px; }.kanban-archived-toggle { display: flex; align-items: center; gap: 5px; white-space: nowrap; }.kanban-archived-toggle input { accent-color: var(--accent); }.kanban-filter-count { margin-left: auto; color: var(--text-muted); font-size: 9px; white-space: nowrap; }
.kanban-columns { display: flex; min-width: 0; min-height: 0; flex: 1; gap: 9px; padding: 10px 12px 12px; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; scrollbar-gutter: stable; }
@media (max-width: 900px) { .kanban-header { padding-inline: 13px; }.kanban-header__actions > span { display: none; }.kanban-filters { padding-inline: 13px; }.kanban-search { width: min(230px, 52vw); }.kanban-columns { padding-inline: 8px; } }
@media (max-width: 600px) { .kanban-header { min-height: 56px; padding: 7px 10px; }.kanban-header__title > span, .kanban-header p { display: none; }.kanban-header h1 { max-width: 36vw; font-size: 14px; }.kanban-header__actions button { min-height: 38px; }.kanban-header__actions .quiet-action, .kanban-header__actions .primary-action { width: 38px; padding: 0; font-size: 0; }.kanban-readonly-banner, .kanban-error-banner { padding-inline: 11px; font-size: 9px; }.kanban-filters { min-height: 50px; padding: 7px 8px; }.kanban-search { width: 62vw; min-height: 36px; }.kanban-search input { font-size: 16px; }.kanban-filters select { min-height: 36px; font-size: 12px; }.kanban-filter-count { display: none; }.kanban-columns { gap: 8px; padding: 8px; scroll-snap-type: x mandatory; } }
</style>
