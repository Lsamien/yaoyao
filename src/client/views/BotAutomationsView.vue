<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiRequest } from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import WorkspaceRoutinesPanel from '@/components/workspace/WorkspaceRoutinesPanel.vue'
import type { WorkspaceAgent } from '@shared/workspace'
import type { WorkspaceRoutine, WorkspaceRoutineRun } from '@shared/workspacePanels'

type Bot = Pick<WorkspaceAgent, 'id' | 'name' | 'avatar'>
const router = useRouter(), route = useRoute()
const agents = ref<Bot[]>([]), routines = ref<WorkspaceRoutine[]>([]), runs = ref<WorkspaceRoutineRun[]>([])
const loading = ref(true), error = ref(''), botFilter = ref('all'), botQuery = ref(''), query = ref(''), stateFilter = ref('all')
const section = ref<'schedule' | 'logs'>('schedule'), view = ref<'calendar' | 'list'>('calendar'), routineFilter = ref(''), newMenu = ref(false)
const editorAgent = ref(''), editor = ref<InstanceType<typeof WorkspaceRoutinesPanel>>()
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const anchor = ref(dateKey(new Date()))
function anchorDate() { const date = new Date(anchor.value + 'T00:00:00'); return Number.isFinite(date.getTime()) ? date : new Date() }
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const status: Record<string, string> = { queued: '排队中', running: '执行中', waiting: '等待处理', complete: '已完成', failed: '失败', interrupted: '已停止', uncertain: '状态待确认', skipped: '已跳过' }
const backPath = computed(() => typeof route.query.from === 'string' && /^\/conversations(?:\/[a-f0-9-]{36})?(?:\?taskId=[a-f0-9-]{36})?$/i.test(route.query.from) ? route.query.from : '/conversations')
const sidebarBots = computed(() => agents.value.filter(a => a.name.toLowerCase().includes(botQuery.value.trim().toLowerCase())))
const visibleRoutines = computed(() => routines.value.filter(r => (botFilter.value === 'all' || r.agentId === botFilter.value) && `${r.name} ${r.prompt}`.toLowerCase().includes(query.value.trim().toLowerCase())).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity)))
const visibleRuns = computed(() => runs.value.filter(r => (botFilter.value === 'all' || r.agentId === botFilter.value) && (!routineFilter.value || r.routineId === routineFilter.value) && (stateFilter.value === 'all' || r.status === stateFilter.value) && `${routines.value.find(t => t.id === r.routineId)?.name ?? ''} ${r.error ?? ''}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const running = computed(() => runs.value.filter(r => ['queued', 'running', 'waiting', 'uncertain'].includes(r.status)).length)
const days = computed(() => {
  const first = anchorDate()
  first.setDate(first.getDate() - (first.getDay() + 6) % 7)
  return weekdays.map((weekday, offset) => { const date = new Date(first); date.setDate(date.getDate() + offset); return { date, key: dateKey(date), weekday } })
})
const rangeLabel = computed(() => `${days.value[0]!.date.toLocaleDateString('zh-CN')} — ${days.value[6]!.date.toLocaleDateString('zh-CN')}`)
const scheduled = (key: string) => visibleRoutines.value.filter(r => r.enabled && r.nextAt && dateKey(new Date(r.nextAt)) === key)
const agent = (id: string) => agents.value.find(a => a.id === id)
const date = (at?: number) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—'
const time = (at?: number) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''
const schedule = (r: WorkspaceRoutine) => r.schedule.kind === 'interval' ? `每 ${r.schedule.everyMinutes} 分钟` : r.schedule.kind === 'once' ? '仅一次' : `${r.schedule.kind === 'weekly' ? '每周 ' + (r.schedule.weekdays ?? []).map(i => '日一二三四五六'[i]).join('、') : '每天'} ${r.schedule.time}`
function moveWeek(direction: number) { const date = anchorDate(); date.setDate(date.getDate() + direction * 7); anchor.value = dateKey(date) }
function closeNewMenu(event: PointerEvent) { if (event.target instanceof Element && !event.target.closest('.new-automation')) newMenu.value = false }
function showLogs(id = '') { section.value = 'logs'; routineFilter.value = id; query.value = ''; stateFilter.value = 'all' }
async function openEditor(botId: string, routine?: WorkspaceRoutine) {
  newMenu.value = false; editorAgent.value = botId
  await nextTick(); editor.value?.edit(routine)
}
function create() {
  const target = botFilter.value !== 'all' ? botFilter.value : agents.value.length === 1 ? agents.value[0]!.id : undefined
  if (target) void openEditor(target)
  else newMenu.value = !newMenu.value
}
let generation = 0, closed = false, timer: ReturnType<typeof setTimeout> | undefined
async function load() {
  const current = ++generation
  try {
    const result = await apiRequest<{ agents: Bot[]; routines: WorkspaceRoutine[]; runs: WorkspaceRoutineRun[] }>('/api/app/bot-tools/automations')
    if (closed || current !== generation) return
    agents.value = result.agents; routines.value = result.routines; runs.value = result.runs; error.value = ''
    if (botFilter.value !== 'all' && !agents.value.some(a => a.id === botFilter.value)) botFilter.value = 'all'
  } catch (e) { if (!closed && current === generation) error.value = e instanceof Error ? e.message : '无法读取自动化任务' }
  finally { if (!closed && current === generation) loading.value = false }
}
async function poll() { if (!document.hidden) await load(); if (!closed) timer = setTimeout(poll, 5000) }
onMounted(poll)
onBeforeUnmount(() => { closed = true; generation++; clearTimeout(timer) })
</script>

<template>
  <main class="automations-page" aria-label="自动化工作区" @pointerdown="closeNewMenu" @keydown.esc="newMenu = false">
    <header class="automations-header">
      <button class="icon-button" type="button" aria-label="返回聊天" @click="router.push(backPath)"><AppIcon name="chevron-left" :size="20" /></button>
      <AppIcon name="calendar" :size="23" /><h1>自动化</h1>
      <div class="segmented" role="tablist" aria-label="自动化页面"><button role="tab" :aria-selected="section === 'schedule'" @click="section = 'schedule'">日程</button><button role="tab" :aria-selected="section === 'logs'" @click="showLogs()">运行日志</button></div>
      <span v-if="running" class="running-count">{{ running }} 项执行中</span>
      <div class="new-automation"><button class="primary" type="button" :disabled="!agents.length" :aria-expanded="newMenu" @click="create"><AppIcon name="plus" :size="17" />新建自动化</button><div v-if="newMenu" class="new-menu" role="group" aria-label="选择执行 Bot" @keydown.esc.stop="newMenu = false"><p>选择执行 Bot</p><button v-for="bot in agents" :key="bot.id" type="button" @click="openEditor(bot.id)"><AgentAvatar :name="bot.name" :avatar="bot.avatar" :size="24" />{{ bot.name }}</button></div></div>
    </header>
    <div class="automations-body">
      <aside class="automation-sidebar" aria-label="自动化筛选">
        <label class="date-filter">查看日期<input v-model="anchor" type="date" /></label>
        <h2>我的 Bot <span>{{ agents.length }}</span></h2><input v-model="botQuery" type="search" aria-label="搜索 Bot" placeholder="搜索 Bot" />
        <nav aria-label="按 Bot 筛选"><button :aria-current="botFilter === 'all' ? 'true' : undefined" @click="botFilter = 'all'"><AppIcon name="users" :size="22" />全部 Bot<span>{{ routines.length }}</span></button><button v-for="bot in sidebarBots" :key="bot.id" :aria-current="botFilter === bot.id ? 'true' : undefined" @click="botFilter = bot.id"><AgentAvatar :name="bot.name" :avatar="bot.avatar" :size="26" /><strong>{{ bot.name }}</strong><span>{{ routines.filter(r => r.agentId === bot.id).length }}</span></button></nav>
        <p v-if="!agents.length">创建 Bot 后，即可安排自动执行的任务。</p>
      </aside>
      <section class="automation-content">
        <div class="automation-toolbar">
          <div v-if="section === 'schedule'" class="segmented" role="tablist" aria-label="日程视图"><button role="tab" :aria-selected="view === 'calendar'" @click="view = 'calendar'">日历</button><button role="tab" :aria-selected="view === 'list'" @click="view = 'list'">任务列表</button></div>
          <template v-if="section === 'schedule' && view === 'calendar'"><div class="date-actions"><button aria-label="上一周" @click="moveWeek(-1)"><AppIcon name="chevron-left" :size="16" /></button><button @click="anchor = dateKey(new Date())">今天</button><button aria-label="下一周" @click="moveWeek(1)"><AppIcon name="chevron-left" class="next-icon" :size="16" /></button></div><span class="range-label">{{ rangeLabel }}</span></template>
          <input v-model="query" class="task-search" type="search" :aria-label="section === 'logs' ? '搜索运行日志' : '搜索自动化任务'" placeholder="搜索任务" />
          <select v-model="botFilter" class="mobile-bot-filter" aria-label="筛选执行 Bot"><option value="all">全部 Bot</option><option v-for="bot in agents" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select>
          <select v-if="section === 'logs'" v-model="stateFilter" aria-label="筛选执行状态"><option value="all">全部状态</option><option v-for="(label, key) in status" :key="key" :value="key">{{ label }}</option></select>
          <button class="icon-button" aria-label="刷新自动化" @click="load"><AppIcon name="refresh" :size="17" /></button>
        </div>
        <p v-if="error" class="page-error" role="alert">{{ error }}</p><p v-if="loading" class="loading" role="status">正在读取自动化任务…</p>
        <template v-else-if="section === 'schedule' && view === 'calendar'">
          <p class="calendar-note">显示每项任务的下次执行时间，按本地时区展示。</p>
          <div class="schedule-week" aria-label="本周自动化日程"><section v-for="day in days" :key="day.key" class="schedule-day" :class="{ today: day.key === dateKey(new Date()) }" :aria-label="day.key"><header><span>周{{ day.weekday }}</span><h2>{{ day.date.getDate() }}</h2></header><button v-for="routine in scheduled(day.key)" :key="routine.id" class="schedule-event" @click="openEditor(routine.agentId, routine)"><time>{{ time(routine.nextAt) }}</time><strong>{{ routine.name }}</strong><span>{{ agent(routine.agentId)?.name }}</span></button><p v-if="!scheduled(day.key).length" class="no-events">暂无任务</p></section></div>
        </template>
        <div v-else-if="section === 'schedule'" class="automation-list">
          <p v-if="!visibleRoutines.length" class="empty">{{ query ? '没有匹配的任务。' : '还没有自动化任务。点击“新建自动化”安排工作。' }}</p>
          <article v-for="routine in visibleRoutines" :key="routine.id" class="automation-card"><AgentAvatar :name="agent(routine.agentId)?.name ?? 'Bot'" :avatar="agent(routine.agentId)?.avatar ?? ''" :size="32" /><button class="routine-description" @click="openEditor(routine.agentId, routine)"><h2>{{ routine.name }}</h2><p>{{ agent(routine.agentId)?.name }} · {{ schedule(routine) }} · {{ routine.schedule.timezone }}</p><small>{{ routine.enabled ? '下次执行：' + date(routine.nextAt) : '已暂停' }}</small></button><span class="status-pill" :class="{ enabled: routine.enabled }">{{ routine.enabled ? '已启用' : '已暂停' }}</span><button class="quiet" @click="showLogs(routine.id)">查看日志</button></article>
        </div>
        <div v-else class="automation-logs">
          <p v-if="routineFilter" class="log-scope">当前任务：{{ routines.find(r => r.id === routineFilter)?.name ?? '自动化任务' }} <button @click="routineFilter = ''">显示全部</button></p>
          <p v-if="!visibleRuns.length" class="empty">还没有符合条件的运行记录。</p>
          <details v-for="run in visibleRuns" :key="run.id" class="run-card"><summary><div><strong>{{ routines.find(r => r.id === run.routineId)?.name ?? '自动化任务' }}</strong><p>{{ agent(run.agentId)?.name }} · {{ date(run.startedAt) }} · {{ run.scheduledAt === 0 ? '手动执行' : '定时执行' }}</p></div><span :class="{ failure: run.status === 'failed', success: run.status === 'complete' }">{{ status[run.status] }}</span></summary><p v-if="run.error" class="failure">{{ run.error }}</p><p v-else>{{ run.status === 'complete' ? '结果已发送到 Bot 聊天。' : '执行进度会自动更新。' }}</p><RouterLink v-if="run.conversationId" :to="'/conversations/' + run.conversationId">查看聊天结果 ↗</RouterLink></details>
        </div>
      </section>
    </div>
    <WorkspaceRoutinesPanel v-if="editorAgent" :key="editorAgent" ref="editor" :agent-id="editorAgent" editor-only @changed="load" @executed="showLogs" />
  </main>
</template>

<style scoped>
.automations-page{height:100dvh;display:flex;flex-direction:column;background:var(--canvas);color:var(--text-primary);min-width:0}.automations-header{display:flex;align-items:center;gap:12px;min-height:72px;box-sizing:border-box;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--surface)}h1{font-size:20px;margin:0 20px 0 0;letter-spacing:-.02em}.automations-page button,.automations-page input,.automations-page select{font:inherit;font-size:13px;color:inherit;border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:8px 11px;min-height:40px;box-sizing:border-box}.automations-page button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}.automations-page button:hover{background:var(--surface-hover)}.automations-page button:disabled{opacity:.45;cursor:not-allowed}.automations-page :is(button,input,select,a,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}.automations-page .icon-button{padding:8px;width:40px;flex-shrink:0}.automations-page .primary{background:var(--accent);border-color:var(--accent);color:var(--text-on-solid);font-weight:600}.segmented{display:flex;gap:3px;border:1px solid var(--line);border-radius:10px;padding:3px;background:var(--surface)}.segmented button{min-height:32px;border:0;background:transparent;white-space:nowrap}.segmented button[aria-selected=true]{background:var(--surface-soft);font-weight:600}.new-automation{margin-left:auto;position:relative}.new-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:10;width:250px;max-height:340px;overflow:auto;padding:8px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-float)}.new-menu p{font-size:12px;color:var(--text-muted);margin:5px 8px}.new-menu button{width:100%;justify-content:flex-start;border:0}.running-count{font-size:12px;color:var(--accent)}.automations-body{display:flex;flex:1;min-height:0}.automation-sidebar{width:224px;flex-shrink:0;box-sizing:border-box;padding:24px 16px;border-right:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;gap:12px;overflow:auto}.date-filter{display:grid;gap:8px;font-size:12px;color:var(--text-secondary);padding-bottom:20px;border-bottom:1px solid var(--line)}.automation-sidebar h2{display:flex;justify-content:space-between;font-size:13px;margin:8px 2px 0}.automation-sidebar h2 span{color:var(--text-muted);font-weight:400}.automation-sidebar input{width:100%;min-width:0}.automation-sidebar nav{display:grid;gap:4px}.automation-sidebar nav button{width:100%;justify-content:flex-start;border:0;text-align:left;min-width:0}.automation-sidebar nav button[aria-current]{background:var(--surface-soft)}.automation-sidebar nav strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.automation-sidebar nav span{margin-left:auto;font-size:12px;color:var(--text-muted)}.automation-sidebar>p{font-size:12px;color:var(--text-secondary);line-height:1.7}.automation-content{flex:1;min-width:0;overflow:auto;padding:20px 24px}.automation-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px}.date-actions{display:flex;gap:3px}.date-actions button{border:0;background:transparent}.next-icon{transform:rotate(180deg)}.range-label{font-size:13px;font-weight:550}.task-search{margin-left:auto;width:170px;min-width:100px}.mobile-bot-filter{display:none}.calendar-note{font-size:12px;color:var(--text-muted);margin:0 0 14px}.schedule-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));min-height:450px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface)}.schedule-day{min-width:0;border-right:1px solid var(--line);padding:10px 7px}.schedule-day:last-child{border-right:0}.schedule-day>header{display:grid;justify-items:center;gap:6px;padding:8px 0 16px}.schedule-day>header span{font-size:12px;color:var(--text-muted)}.schedule-day h2{font-size:22px;margin:0;font-weight:500}.schedule-day.today{background:color-mix(in srgb,var(--accent) 4%,var(--surface))}.schedule-day.today h2{color:var(--accent);font-weight:650}.automations-page .schedule-event{display:grid;justify-content:stretch;gap:7px;width:100%;text-align:left;align-items:start;margin-bottom:8px;padding:10px 9px;background:color-mix(in srgb,var(--accent) 7%,var(--surface));border-color:color-mix(in srgb,var(--accent) 25%,var(--line));overflow-wrap:anywhere}.schedule-event time{font-size:11px;color:var(--accent)}.schedule-event strong{font-size:12px;line-height:1.5}.schedule-event span{font-size:11px;color:var(--text-secondary)}.no-events{font-size:11px;color:var(--text-muted);text-align:center;padding:24px 0}.automation-list,.automation-logs{display:grid;gap:12px}.automation-card{display:flex;align-items:center;gap:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface);min-width:0}.automations-page .routine-description{display:block;flex:1;min-width:0;padding:0;text-align:left;background:transparent;border:0}.routine-description h2{margin:0 0 7px;font-size:15px;font-weight:600}.routine-description p{margin:0 0 6px;font-size:12px;color:var(--text-secondary);line-height:1.6}.routine-description small{font-size:12px;color:var(--text-muted)}.status-pill{font-size:11px;color:var(--text-muted);white-space:nowrap;padding:5px 8px;border-radius:99px;background:var(--surface-soft)}.status-pill.enabled{color:var(--accent)}.automations-page .quiet{border:0;background:transparent;white-space:nowrap}.run-card{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-size:13px;line-height:1.7}.run-card summary{display:flex;justify-content:space-between;gap:16px;cursor:pointer;list-style:none;min-height:44px}.run-card summary::-webkit-details-marker{display:none}.run-card p{font-size:12px;color:var(--text-secondary);margin:5px 0}.run-card a{color:var(--accent)}.run-card summary>span{white-space:nowrap}.failure,.page-error{color:var(--danger)!important}.success{color:var(--accent)}.page-error{padding:12px;border-radius:9px;background:var(--surface);font-size:13px}.empty,.loading{padding:50px 20px;text-align:center;color:var(--text-secondary);font-size:13px;line-height:1.8}.log-scope{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary)}@media(max-width:1000px){.automations-header{padding:12px 16px;flex-wrap:wrap;gap:8px}h1{margin-right:8px}.automation-sidebar{width:190px}.automation-content{padding:18px 16px}.range-label{order:3;width:100%}.schedule-week{grid-template-columns:repeat(7,minmax(0,1fr))}.schedule-day{padding:8px 4px}}@media(max-width:760px){.automation-sidebar{display:none}.mobile-bot-filter{display:block;max-width:160px}.automations-page button{min-height:44px}.automations-header{padding:10px 12px}.automations-header .segmented{order:3}.running-count{display:none}.automations-body{display:block;overflow:hidden}.automation-content{height:100%;box-sizing:border-box;padding:16px 12px}.schedule-week{grid-template-columns:1fr;min-height:0;border:0;border-radius:0;background:transparent;gap:10px}.schedule-day{display:grid;grid-template-columns:56px minmax(0,1fr);align-items:start;padding:12px;border:1px solid var(--line)!important;border-radius:12px;background:var(--surface)}.schedule-day>header{grid-row:1 / span 50;padding:2px 8px 0 0}.schedule-event{grid-column:2}.no-events{text-align:left;padding:10px;margin:0}.task-search{flex:1;width:130px}.range-label{font-size:12px}.automation-card{flex-wrap:wrap;padding:14px;gap:10px}.automation-card>.routine-description{flex-basis:calc(100% - 48px)}.automation-card>.status-pill{margin-left:42px}.automation-card>.quiet{margin-left:auto}.automation-toolbar{gap:8px}}
</style>
