<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
import { createUuid } from '@/utils/id'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { ChevronForwardOutline } from '@vicons/ionicons5'
import type { WorkspaceAgent, WorkspaceConversation } from '@shared/workspace'
import type { MemoryScope, MemorySkipReason, WorkspaceMemory, WorkspaceMemoryJob, WorkspaceMemoryRevision, WorkspacePeerMessage, WorkspaceProject } from '@shared/workspaceKnowledge'

const props = defineProps<{ agents: WorkspaceAgent[]; conversations: WorkspaceConversation[]; conversationId?: string; revision?: number; embedded?: boolean; initialTab?: 'projects' | 'user' | 'agent'; selectedAgentId?: string; hideAgentControls?: boolean }>()
const emit = defineEmits<{ changed: []; 'dirty-change': [dirty: boolean] }>()
const dialog = ref<HTMLDialogElement>(), opened = ref(false), busy = ref(false), error = ref(''), tab = ref('agent'), agentId = ref(''), projectId = ref(''), search = ref('')
const projects = ref<WorkspaceProject[]>([]), memories = ref<WorkspaceMemory[]>([]), peers = ref<WorkspacePeerMessage[]>([]), jobs = ref<WorkspaceMemoryJob[]>([]), revisions = ref<WorkspaceMemoryRevision[]>([])
const draft = ref<{ id?: string; expectedRevision?: number; agentId: string; content: string; tier: WorkspaceMemory['tier'] }>()
const projectDraft = ref<WorkspaceProject>()
let generation = 0, timer: ReturnType<typeof setInterval> | undefined
const available = computed(() => props.agents.filter(a => !a.archived && !a.temporaryGoalId))
const currentAgent = computed(() => props.agents.find(a => a.id === agentId.value))
const currentProject = computed(() => projects.value.find(p => p.id === projectId.value))
const scope = computed(() => (['agent', 'user', 'project'].includes(tab.value) ? tab.value : 'agent') as MemoryScope)
const name = (id?: string) => props.agents.find(a => a.id === id)?.name ?? '原贡献者'
const query = () => new URLSearchParams({ scope: scope.value, ...(tab.value === 'agent' && agentId.value ? { agentId: agentId.value } : {}), ...(tab.value === 'project' && projectId.value ? { projectId: projectId.value } : {}), ...(search.value ? { search: search.value } : {}) }).toString()
const stateNames: Record<string, string> = { queued: '已排队', pending: '待提炼', running: '处理中', waiting: '等待同伴', complete: '已完成', failed: '失败', stopped: '已停止', skipped: '已跳过' }
const skipReasonNames: Record<MemorySkipReason, string> = {
  source_missing: '找不到对应的来源消息', quote_mismatch: '引用与原文不一致', sensitive_content: '包含凭据等敏感内容',
  project_unbound: '项目记忆缺少关联项目', user_not_explicit: '缺少用户明确表达的长期信息', forgotten: '已遗忘的内容或来源不再保存',
}
function jobSummary(job: WorkspaceMemoryJob): string {
  if (job.status !== 'complete') return stateNames[job.status] ?? job.status
  const result = job.result
  if (!result) return '已结束（旧记录未统计保存结果）'
  if (!result.extractedCount) return '本轮没有可记录内容'
  if (result.writtenCount) return `已保存 ${result.writtenCount} 条记忆`
  if (result.replayedCount) return `重试已确认 ${result.replayedCount} 条记录`
  if (result.duplicateCount) return '未新增记忆，已有相同内容'
  return '候选记忆均未保存'
}
function skippedReasons(job: WorkspaceMemoryJob): string[] {
  return Object.entries(job.result?.skippedReasons ?? {}).filter(([, count]) => count > 0)
    .map(([reason, count]) => `${skipReasonNames[reason as MemorySkipReason] ?? '其他原因'}：${count} 条`)
}
async function load(silent = false) {
  const epoch = ++generation
  if (!silent) error.value = ''
  try {
    const projectResult = await apiRequest<{ projects: WorkspaceProject[] }>('/api/app/workspace/projects')
    if (epoch !== generation || !opened.value) return
    projects.value = projectResult.projects
    if (!projectId.value) projectId.value = projects.value.find(p => !p.archived)?.id ?? ''
    if (tab.value === 'collaboration') {
      const result = await apiRequest<{ messages: WorkspacePeerMessage[] }>(`/api/app/workspace/collaboration${props.conversationId ? `?conversationId=${encodeURIComponent(props.conversationId)}` : ''}`)
      if (epoch === generation) peers.value = result.messages
    } else if (tab.value !== 'projects' && (tab.value !== 'project' || projectId.value)) {
      const result = await apiRequest<{ memories: WorkspaceMemory[] }>(`/api/app/workspace/memories?${query()}`)
      if (epoch === generation) memories.value = result.memories
    } else memories.value = []
    if (agentId.value) {
      const result = await apiRequest<{ jobs: WorkspaceMemoryJob[] }>(`/api/app/workspace/memory-jobs?agentId=${agentId.value}`)
      if (epoch === generation) jobs.value = result.jobs
    }
  } catch (cause) { if (epoch === generation) error.value = String(cause) }
}
async function open(initial = 'agent', selectedAgent?: string, selectedProject?: string) {
  tab.value = initial; agentId.value = selectedAgent ?? available.value[0]?.id ?? ''; projectId.value = selectedProject ?? ''
  opened.value = true; draft.value = undefined; projectDraft.value = undefined; revisions.value = []; search.value = ''
  await nextTick(); if (!props.embedded) dialog.value?.showModal(); await load()
  clearInterval(timer); timer = setInterval(() => { if (!busy.value && !draft.value && !projectDraft.value) void load(true) }, 5000)
}
function close() { opened.value = false; generation++; clearInterval(timer); if (!props.embedded) dialog.value?.close() }
function switchTab(value: string) { tab.value = value; draft.value = undefined; projectDraft.value = undefined; revisions.value = []; void load() }
async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action(); emit('changed'); await load() } catch (cause) { error.value = String(cause) } finally { busy.value = false }
}
function newMemory(memory?: WorkspaceMemory) {
  revisions.value = []
  draft.value = memory ? { id: memory.id, expectedRevision: memory.revision, agentId: memory.agentId, content: memory.content, tier: memory.tier } : { agentId: agentId.value || available.value[0]?.id || '', content: '', tier: 'log' }
}
async function saveMemory() {
  const value = draft.value
  if (!value?.content.trim()) { error.value = '请输入需要记住的事实'; return }
  await perform(async () => {
    await apiRequest('/api/app/workspace/memories', { method: 'POST', body: { requestId: createUuid(), scope: scope.value, ...(scope.value === 'project' ? { projectId: projectId.value } : {}), ...value } })
    draft.value = undefined
  })
}
async function forget(memory: WorkspaceMemory) {
  await perform(async () => { await apiRequest('/api/app/workspace/memories/forget', { method: 'POST', body: { requestId: createUuid(), scope: memory.scope, agentId: memory.agentId, ...(memory.projectId ? { projectId: memory.projectId } : {}), id: memory.id, expectedRevision: memory.revision } }) })
}
async function history(memory: WorkspaceMemory) {
  const query = new URLSearchParams({ scope: memory.scope, agentId: memory.agentId, ...(memory.projectId ? { projectId: memory.projectId } : {}) })
  await perform(async () => { revisions.value = (await apiRequest<{ revisions: WorkspaceMemoryRevision[] }>(`/api/app/workspace/memories/${memory.id}/revisions?${query}`)).revisions })
}
function editProject(project?: WorkspaceProject) {
  projectDraft.value = project ? { ...project, memberIds: [...project.memberIds], groupIds: [...project.groupIds] } : { id: '', name: '', description: '', memberIds: [], groupIds: [], revision: 0, archived: false, createdAt: 0, updatedAt: 0 }
}
async function saveProject() {
  const value = projectDraft.value
  if (!value?.name.trim()) { error.value = '请输入项目名称'; return }
  await perform(async () => {
    const result = await apiRequest<{ project: WorkspaceProject }>('/api/app/workspace/projects', { method: 'POST', body: { requestId: createUuid(), ...(value.id ? { id: value.id, expectedRevision: value.revision } : {}), name: value.name, description: value.description, memberIds: value.memberIds, groupIds: value.groupIds, archived: value.archived } })
    projectId.value = result.project.id; projectDraft.value = undefined
  })
}
async function setAgent(field: 'canCollaborate' | 'memoryEnabled', enabled: boolean) {
  await perform(async () => { await apiRequest(`/api/app/agents/${agentId.value}`, { method: 'PATCH', body: { [field]: enabled } }) })
}
onBeforeUnmount(() => { generation++; clearInterval(timer) })
onMounted(() => { if (props.embedded) void open(props.initialTab ?? 'projects', props.selectedAgentId) })
watch(() => props.initialTab, value => { if (props.embedded && value) switchTab(value) })
watch(() => props.revision, () => { if (opened.value && !busy.value && !draft.value && !projectDraft.value) void load(true) })
watch(() => !!draft.value || !!projectDraft.value, value => emit('dirty-change', value))
defineExpose({ open, close })
</script>

<template>
  <component :is="embedded ? 'section' : 'dialog'" ref="dialog" class="knowledge-dialog" :class="{ 'knowledge-dialog--embedded': embedded }" :aria-labelledby="embedded ? undefined : 'knowledge-title'" @cancel.prevent="close" @close="opened = false">
    <header v-if="!embedded"><div><h2 id="knowledge-title">Bot 记忆与协作</h2><p>管理长期事实、项目和同伴请求</p></div><button type="button" @click="close" aria-label="关闭记忆与协作">关闭</button></header>
    <nav v-if="!embedded" aria-label="记忆与项目分类"><button v-for="item in [['agent','Bot 记忆'],['user','用户记忆'],['projects','项目'],['project','项目记忆'],['collaboration','协作']]" :key="item[0]" :aria-pressed="tab === item[0]" @click="switchTab(item[0]!)">{{ item[1] }}</button></nav>
    <div class="knowledge-body" :aria-busy="busy">
      <div v-if="embedded && tab === 'project'" class="actions"><button type="button" @click="switchTab('projects')">返回项目</button><h3>项目记忆</h3></div>
      <p v-if="error" role="alert" class="knowledge-error">{{ error }}</p>
      <template v-if="tab === 'projects'">
        <div v-if="embedded" class="project-heading"><div><h3>项目</h3><p>让同一项目的 Bot 共享决策与约定。</p></div><button v-if="!projectDraft" type="button" class="project-primary" @click="editProject()">新建项目</button></div>
        <button v-else-if="!projectDraft" @click="editProject()">新建项目</button>
        <form v-if="projectDraft" class="knowledge-editor" @submit.prevent="saveProject">
          <h3>{{ projectDraft.id ? '编辑项目' : '新建项目' }}</h3>
          <label>名称<input v-model="projectDraft.name" required maxlength="100" /></label>
          <label>说明<textarea v-model="projectDraft.description" rows="3" maxlength="16000" /></label>
          <fieldset><legend>项目成员</legend><label v-for="agent in available" :key="agent.id" class="check"><input v-model="projectDraft.memberIds" type="checkbox" :value="agent.id" />{{ agent.name }}</label></fieldset>
          <fieldset><legend>关联群聊</legend><p>群内所有 Bot 需要先加入此项目。</p><label v-for="group in conversations.filter(c => c.kind === 'group' && !c.archived)" :key="group.id" class="check"><input v-model="projectDraft.groupIds" type="checkbox" :value="group.id" :disabled="group.memberIds.some(id => !projectDraft!.memberIds.includes(id)) || !!group.projectId && group.projectId !== projectDraft.id" />{{ group.name }}</label></fieldset>
          <label v-if="projectDraft.id" class="check"><input v-model="projectDraft.archived" type="checkbox" />归档项目</label>
          <div class="actions"><button type="submit" :disabled="busy">保存项目</button><button type="button" @click="projectDraft = undefined">取消</button></div>
        </form>
        <template v-if="embedded && !projectDraft">
          <div v-if="projects.length" class="project-list" aria-label="项目列表"><button v-for="project in projects" :key="project.id" type="button" :aria-pressed="projectId === project.id" @click="projectId = project.id"><AppIcon name="files" :size="21"/><span><strong>{{project.name}}{{project.archived ? ' · 已归档' : ''}}</strong><small>{{project.memberIds.length}} 位 Bot · {{project.groupIds.length}} 个群聊</small></span><ChevronForwardOutline class="project-chevron" aria-hidden="true"/></button></div>
          <section v-if="currentProject" class="project-details" aria-label="当前项目详情">
            <h3>{{currentProject.name}}</h3><p v-if="currentProject.description" class="project-description">{{currentProject.description}}</p>
            <div class="project-detail-row"><span>项目成员</span><div class="project-members"><span v-for="id in currentProject.memberIds" :key="id"><AgentAvatar :name="name(id)" :avatar="agents.find(a => a.id === id)?.avatar || ''" :size="24"/>{{name(id)}}</span><small v-if="!currentProject.memberIds.length">尚无成员</small></div></div>
            <div class="project-detail-row"><span>关联群聊</span><div>{{currentProject.groupIds.map(id => conversations.find(c => c.id === id)?.name ?? '原群聊').join('、') || '尚未关联群聊'}}</div></div>
            <div class="project-detail-row"><span>项目记忆</span><div><button type="button" @click="switchTab('project')">查看记忆</button></div></div>
            <div class="project-detail-actions"><button type="button" class="project-primary" @click="editProject(currentProject)">编辑项目</button></div>
          </section>
        </template>
        <template v-else-if="!embedded"><article v-for="project in projects" :key="project.id"><h3>{{ project.name }}{{ project.archived ? ' · 已归档' : '' }}</h3><p>{{ project.description || '暂无说明' }}</p><small>{{ project.memberIds.map(id => name(id)).join('、') || '尚无成员' }} · {{ project.groupIds.length }} 个群</small><div class="actions"><button @click="editProject(project)">编辑</button><button @click="projectId = project.id; switchTab('project')">查看记忆</button></div></article></template>
        <p v-if="!projects.length && !projectDraft" class="empty">创建项目后，多个群可以共享该项目的决策和约定。</p>
      </template>
      <template v-else-if="tab === 'collaboration'">
        <label>当前 Bot<select v-model="agentId" @change="load()"><option v-for="agent in available" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
        <article v-for="peer in peers" :key="peer.id"><details><summary>{{ name(peer.fromAgentId) }} → {{ peer.toAgentId ? name(peer.toAgentId) : conversations.find(c => c.id === peer.targetGroupId)?.name }} · {{ stateNames[peer.status] }}</summary><p class="pre-wrap">{{ peer.content }}</p><small>{{ new Date(peer.createdAt).toLocaleString() }}{{ peer.replyTo ? ' · 回复同伴' : '' }}</small><p v-if="peer.error" class="knowledge-error">{{ peer.error }}</p></details><button v-if="['queued','running','waiting'].includes(peer.status)" :disabled="busy" @click="perform(async () => { await apiRequest(`/api/app/workspace/collaboration/${peer.id}/stop`, { method: 'POST' }) })">停止此次协作</button></article>
        <p v-if="!peers.length" class="empty">暂无同伴请求。你可以在聊天中让 Bot 联系另一位同伴。</p>
      </template>
      <template v-else>
        <div class="filters">
          <label v-if="tab === 'agent' && !selectedAgentId">Bot<select v-model="agentId" @change="draft = undefined; load()"><option v-for="agent in available" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
          <label v-if="tab === 'project'">项目<select v-model="projectId" @change="draft = undefined; load()"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
          <form @submit.prevent="load()"><label>搜索记忆<input v-model="search" type="search" placeholder="搜索事实、偏好或决策" /></label><button type="submit">搜索</button></form>
        </div>
        <p class="scope-note">{{ tab === 'agent' ? '仅此 Bot 使用，可跨单聊和群聊延续。' : tab === 'user' ? '同一账号的 Bot 共享，按贡献者保存。' : `仅「${currentProject?.name ?? '当前项目'}」成员读取。` }}</p>
        <template v-if="tab === 'agent' && currentAgent"><label v-if="!hideAgentControls" class="check"><input type="checkbox" :checked="currentAgent.memoryEnabled !== false" :disabled="busy" @change="setAgent('memoryEnabled', ($event.target as HTMLInputElement).checked)" />自动记录长期事实</label><p v-if="currentAgent.memoryStatus === 'upgrade_required'" role="status">执行节点需要升级后才能启用隔离记忆；已保存的文件仍可管理。</p></template>
        <div v-if="tab !== 'project' || projectId" class="actions"><button @click="newMemory()" :disabled="!available.length">添加记忆</button><a :href="`/api/app/workspace/memory-export?${query()}`" download="bot-memory.md">导出 Markdown</a></div>
        <form v-if="draft" class="knowledge-editor" @submit.prevent="saveMemory"><h3>{{ draft.id ? '编辑记忆' : '添加记忆' }}</h3><label v-if="!draft.id && tab !== 'agent'">贡献 Bot<select v-model="draft.agentId"><option v-for="agent in available.filter(a => tab !== 'project' || currentProject?.memberIds.includes(a.id))" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label><label>事实<textarea v-model="draft.content" required rows="4" maxlength="2000" /></label><label>类别<select v-model="draft.tier"><option value="profile">长期事实</option><option value="log">历史记录</option><option value="note">补充笔记</option></select></label><div class="actions"><button type="submit" :disabled="busy">保存</button><button type="button" @click="draft = undefined">取消</button></div></form>
        <article v-for="memory in memories" :key="`${memory.scope}:${memory.agentId}:${memory.id}`"><p class="pre-wrap">{{ memory.content }}</p><p v-if="memory.conflict" role="status">同主题有不同贡献，请核对来源。</p><small>{{ name(memory.agentId) }} · {{ memory.origin === 'manual' ? '用户维护' : memory.origin === 'explicit' ? '明确保存' : '自动提炼' }} · {{ new Date(memory.updatedAt).toLocaleString() }} · 版本 {{ memory.revision }}</small><details v-if="memory.sources.length"><summary>查看来源</summary><p v-for="source in memory.sources" :key="source.messageId"><a :href="`/conversations/${source.conversationId}${source.taskId ? `?taskId=${source.taskId}` : ''}`">{{ source.quote || '查看原话题' }}</a></p></details><div class="actions"><button @click="newMemory(memory)">编辑</button><button @click="history(memory)" :disabled="busy">修订记录</button><button @click="forget(memory)" :disabled="busy">遗忘</button></div></article>
        <p v-if="!memories.length && !draft" class="empty">暂无记忆。可手动添加，也可在对话中说明需要长期记住的事实。</p>
        <section v-if="revisions.length" class="knowledge-editor"><h3>修订记录</h3><article v-for="revision in revisions" :key="revision.id"><small>版本 {{ revision.revision }} · {{ revision.operation === 'forget' ? '遗忘' : '保存' }} · {{ new Date(revision.at).toLocaleString() }}</small><p>{{ revision.after?.content ?? revision.before?.content }}</p></article><button @click="revisions = []">收起</button></section>
        <details v-if="tab === 'agent' && jobs.length">
          <summary>后台提炼记录</summary>
          <article v-for="job in jobs" :key="job.id">
            <small>{{ new Date(job.createdAt).toLocaleString() }} · {{ jobSummary(job) }}</small>
            <p v-if="job.result">本次提炼 {{ job.result.extractedCount }} 条 · 新增保存 {{ job.result.writtenCount }} 条 · 重复 {{ job.result.duplicateCount }} 条 · 重试确认 {{ job.result.replayedCount }} 条</p>
            <p v-for="reason in skippedReasons(job)" :key="reason">{{ reason }}</p>
            <p v-if="job.error">{{ job.error }}</p>
            <button v-if="job.status === 'failed'" :disabled="busy" @click="perform(async () => { await apiRequest(`/api/app/workspace/memory-jobs/${job.id}/retry`, { method: 'POST' }) })">重试</button>
          </article>
        </details>
      </template>
    </div>
  </component>
</template>

<style scoped>
.knowledge-dialog{width:min(820px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line);border-radius:18px;background:var(--surface);color:var(--text-primary)}
.knowledge-dialog::backdrop{background:rgb(0 0 0 / .5)}header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px;border-bottom:1px solid var(--line)}h2,h3,p{margin:0}header p,.scope-note,.empty,small{color:var(--text-secondary)}header p{margin-top:5px;font-size:13px}nav{display:flex;flex-wrap:wrap;gap:4px;padding:10px 20px;border-bottom:1px solid var(--line)}button,a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:var(--surface);color:var(--text-primary);font:inherit;font-size:14px;cursor:pointer;text-decoration:none}button:hover,a:hover{background:var(--surface-hover)}button[aria-pressed=true]{background:var(--surface-hover);border-color:var(--accent);color:var(--accent)}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.knowledge-body{display:grid;gap:16px;padding:20px 24px;max-height:calc(100dvh - 210px);overflow:auto;overscroll-behavior:contain}label{display:grid;gap:6px;font-size:14px}input:not([type=checkbox]),textarea,select{min-height:44px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;box-sizing:border-box;width:100%}textarea{resize:vertical}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.filters>label{min-width:160px}.filters form{display:flex;align-items:end;gap:8px;flex:1}.filters form label{flex:1}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}article{padding:16px;border:1px solid var(--line);border-radius:12px;display:grid;gap:9px}.knowledge-editor{display:grid;gap:12px;padding:16px;border:1px solid var(--accent);border-radius:12px}fieldset{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px;max-height:240px;overflow:auto}.check{display:flex;align-items:center;min-height:44px;gap:9px}.check input{width:18px;height:18px;accent-color:var(--accent)}small,.scope-note{font-size:13px;line-height:1.5}.pre-wrap{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.knowledge-error{color:var(--danger,#c0392b);white-space:pre-wrap}.empty{padding:24px 8px;text-align:center;line-height:1.6}summary{cursor:pointer;min-height:36px;line-height:1.6}details p{margin-top:8px}
@media(max-width:520px){header{padding:16px}h2{font-size:19px}nav{padding:8px}nav button{flex:1;white-space:nowrap}.knowledge-body{padding:16px;max-height:calc(100dvh - 250px)}.filters{display:grid}.filters form{min-width:0}}
.knowledge-dialog--embedded{width:100%;max-height:none;border:0;border-radius:0;background:transparent;min-width:0}.knowledge-dialog--embedded .knowledge-body{padding:0;max-height:none;overflow:visible}.knowledge-dialog--embedded .actions{align-items:center}
.project-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:8px}.project-heading h3{font-size:18px;font-weight:650}.project-heading p{font-size:13px;color:var(--text-secondary);margin-top:6px;line-height:1.6}.knowledge-dialog--embedded .project-primary{flex-shrink:0;padding:8px 16px;background:var(--accent);color:var(--text-on-solid);border-color:var(--accent);font-size:13px}.project-list{border:1px solid var(--line);border-radius:11px;overflow:hidden}.project-list button{display:flex;gap:20px;width:100%;padding:18px 22px;border:0;border-radius:0;text-align:left;justify-content:flex-start;min-height:76px}.project-list button+button{border-top:1px solid var(--line)}.project-list button[aria-pressed=true]{background:var(--settings-selected);color:var(--text-primary)}.project-list button>span{flex:1;min-width:0;display:grid;gap:4px}.project-list strong{font-size:15px;font-weight:600;overflow-wrap:anywhere}.project-list small{font-size:12px}.project-list .app-icon{color:var(--text-muted)}.project-details{background:var(--settings-panel);padding:20px;border-radius:12px}.project-details h3{font-size:17px;font-weight:650;margin-bottom:12px}.project-description{font-size:13px;color:var(--text-secondary);line-height:1.6;padding-bottom:12px;white-space:pre-wrap;overflow-wrap:anywhere}.project-detail-row{display:grid;grid-template-columns:104px minmax(0,1fr);align-items:center;gap:16px;min-height:48px;border-top:1px solid var(--line);font-size:14px}.project-detail-row>span{color:var(--text-secondary)}.project-detail-row>div{overflow-wrap:anywhere}.project-detail-row button{min-height:36px;background:var(--settings-selected);border:0;font-size:12px}.project-members{display:flex;gap:10px;flex-wrap:wrap;padding-block:10px}.project-members>span{display:inline-flex;align-items:center;gap:7px}.project-detail-actions{display:flex;justify-content:flex-end;margin-top:8px}.project-detail-actions .project-primary{min-height:36px}.knowledge-dialog--embedded article{border:0;background:var(--settings-panel)}@media(max-width:520px){.project-heading{gap:10px}.project-heading p{max-width:210px}.project-list button{padding:16px;gap:12px}.project-details{padding:16px}.project-detail-row{grid-template-columns:76px minmax(0,1fr);gap:10px}}
</style>
<style scoped>.project-chevron{width:17px;height:17px;flex-shrink:0;color:var(--text-muted)}</style>
