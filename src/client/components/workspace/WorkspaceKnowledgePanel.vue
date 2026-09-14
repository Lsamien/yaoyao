<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
import { createUuid } from '@/utils/id'
import type { WorkspaceAgent, WorkspaceConversation } from '@shared/workspace'
import type { MemoryScope, WorkspaceMemory, WorkspaceMemoryJob, WorkspaceMemoryRevision, WorkspacePeerMessage, WorkspaceProject } from '@shared/workspaceKnowledge'

const props = defineProps<{ agents: WorkspaceAgent[]; conversations: WorkspaceConversation[]; conversationId?: string; revision?: number }>()
const emit = defineEmits<{ changed: [] }>()
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
  await nextTick(); dialog.value?.showModal(); await load()
  clearInterval(timer); timer = setInterval(() => { if (!busy.value && !draft.value && !projectDraft.value) void load(true) }, 5000)
}
function close() { opened.value = false; generation++; clearInterval(timer); dialog.value?.close() }
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
watch(() => props.revision, () => { if (opened.value && !busy.value && !draft.value && !projectDraft.value) void load(true) })
defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="knowledge-dialog" aria-labelledby="knowledge-title" @cancel.prevent="close" @close="opened = false">
    <header><div><h2 id="knowledge-title">Bot 记忆与协作</h2><p>管理长期事实、项目和同伴请求</p></div><button type="button" @click="close" aria-label="关闭记忆与协作">关闭</button></header>
    <nav aria-label="记忆与项目分类"><button v-for="item in [['agent','Bot 记忆'],['user','用户记忆'],['projects','项目'],['project','项目记忆'],['collaboration','协作']]" :key="item[0]" :aria-pressed="tab === item[0]" @click="switchTab(item[0]!)">{{ item[1] }}</button></nav>
    <div class="knowledge-body" :aria-busy="busy">
      <p v-if="error" role="alert" class="knowledge-error">{{ error }}</p>
      <template v-if="tab === 'projects'">
        <button v-if="!projectDraft" @click="editProject()">新建项目</button>
        <form v-if="projectDraft" class="knowledge-editor" @submit.prevent="saveProject">
          <h3>{{ projectDraft.id ? '编辑项目' : '新建项目' }}</h3>
          <label>名称<input v-model="projectDraft.name" required maxlength="100" /></label>
          <label>说明<textarea v-model="projectDraft.description" rows="3" maxlength="16000" /></label>
          <fieldset><legend>项目成员</legend><label v-for="agent in available" :key="agent.id" class="check"><input v-model="projectDraft.memberIds" type="checkbox" :value="agent.id" />{{ agent.name }}</label></fieldset>
          <fieldset><legend>关联群聊</legend><p>群内所有 Bot 需要先加入此项目。</p><label v-for="group in conversations.filter(c => c.kind === 'group' && !c.archived)" :key="group.id" class="check"><input v-model="projectDraft.groupIds" type="checkbox" :value="group.id" :disabled="group.memberIds.some(id => !projectDraft!.memberIds.includes(id)) || !!group.projectId && group.projectId !== projectDraft.id" />{{ group.name }}</label></fieldset>
          <label v-if="projectDraft.id" class="check"><input v-model="projectDraft.archived" type="checkbox" />归档项目</label>
          <div class="actions"><button type="submit" :disabled="busy">保存项目</button><button type="button" @click="projectDraft = undefined">取消</button></div>
        </form>
        <article v-for="project in projects" :key="project.id"><h3>{{ project.name }}{{ project.archived ? ' · 已归档' : '' }}</h3><p>{{ project.description || '暂无说明' }}</p><small>{{ project.memberIds.map(id => name(id)).join('、') || '尚无成员' }} · {{ project.groupIds.length }} 个群</small><div class="actions"><button @click="editProject(project)">编辑</button><button @click="projectId = project.id; switchTab('project')">查看记忆</button></div></article>
        <p v-if="!projects.length && !projectDraft" class="empty">创建项目后，多个群可以共享该项目的决策和约定。</p>
      </template>
      <template v-else-if="tab === 'collaboration'">
        <label>当前 Bot<select v-model="agentId" @change="load()"><option v-for="agent in available" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
        <label v-if="currentAgent" class="check"><input type="checkbox" :checked="currentAgent.canCollaborate !== false" :disabled="busy" @change="setAgent('canCollaborate', ($event.target as HTMLInputElement).checked)" />允许 Bot 协作</label>
        <article v-for="peer in peers" :key="peer.id"><details><summary>{{ name(peer.fromAgentId) }} → {{ peer.toAgentId ? name(peer.toAgentId) : conversations.find(c => c.id === peer.targetGroupId)?.name }} · {{ stateNames[peer.status] }}</summary><p class="pre-wrap">{{ peer.content }}</p><small>{{ new Date(peer.createdAt).toLocaleString() }}{{ peer.replyTo ? ' · 回复同伴' : '' }}</small><p v-if="peer.error" class="knowledge-error">{{ peer.error }}</p></details><button v-if="['queued','running','waiting'].includes(peer.status)" :disabled="busy" @click="perform(async () => { await apiRequest(`/api/app/workspace/collaboration/${peer.id}/stop`, { method: 'POST' }) })">停止此次协作</button></article>
        <p v-if="!peers.length" class="empty">暂无同伴请求。你可以在聊天中让 Bot 联系另一位同伴。</p>
      </template>
      <template v-else>
        <div class="filters">
          <label v-if="tab === 'agent'">Bot<select v-model="agentId" @change="draft = undefined; load()"><option v-for="agent in available" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
          <label v-if="tab === 'project'">项目<select v-model="projectId" @change="draft = undefined; load()"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
          <form @submit.prevent="load()"><label>搜索记忆<input v-model="search" type="search" placeholder="搜索事实、偏好或决策" /></label><button type="submit">搜索</button></form>
        </div>
        <p class="scope-note">{{ tab === 'agent' ? '仅此 Bot 使用，可跨单聊和群聊延续。' : tab === 'user' ? '同一账号的 Bot 共享，按贡献者保存。' : `仅「${currentProject?.name ?? '当前项目'}」成员读取。` }}</p>
        <template v-if="tab === 'agent' && currentAgent"><label class="check"><input type="checkbox" :checked="currentAgent.memoryEnabled !== false" :disabled="busy" @change="setAgent('memoryEnabled', ($event.target as HTMLInputElement).checked)" />自动记录长期事实</label><p v-if="currentAgent.memoryStatus === 'upgrade_required'" role="status">执行节点需要升级后才能启用隔离记忆；已保存的文件仍可管理。</p></template>
        <div v-if="tab !== 'project' || projectId" class="actions"><button @click="newMemory()" :disabled="!available.length">添加记忆</button><a :href="`/api/app/workspace/memory-export?${query()}`" download="bot-memory.md">导出 Markdown</a></div>
        <form v-if="draft" class="knowledge-editor" @submit.prevent="saveMemory"><h3>{{ draft.id ? '编辑记忆' : '添加记忆' }}</h3><label v-if="!draft.id && tab !== 'agent'">贡献 Bot<select v-model="draft.agentId"><option v-for="agent in available.filter(a => tab !== 'project' || currentProject?.memberIds.includes(a.id))" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label><label>事实<textarea v-model="draft.content" required rows="4" maxlength="2000" /></label><label>类别<select v-model="draft.tier"><option value="profile">长期事实</option><option value="log">历史记录</option><option value="note">补充笔记</option></select></label><div class="actions"><button type="submit" :disabled="busy">保存</button><button type="button" @click="draft = undefined">取消</button></div></form>
        <article v-for="memory in memories" :key="`${memory.scope}:${memory.agentId}:${memory.id}`"><p class="pre-wrap">{{ memory.content }}</p><p v-if="memory.conflict" role="status">同主题有不同贡献，请核对来源。</p><small>{{ name(memory.agentId) }} · {{ memory.origin === 'manual' ? '用户维护' : memory.origin === 'explicit' ? '明确保存' : '自动提炼' }} · {{ new Date(memory.updatedAt).toLocaleString() }} · 版本 {{ memory.revision }}</small><details v-if="memory.sources.length"><summary>查看来源</summary><p v-for="source in memory.sources" :key="source.messageId"><a :href="`/conversations/${source.conversationId}${source.taskId ? `?taskId=${source.taskId}` : ''}`">{{ source.quote || '查看原话题' }}</a></p></details><div class="actions"><button @click="newMemory(memory)">编辑</button><button @click="history(memory)" :disabled="busy">修订记录</button><button @click="forget(memory)" :disabled="busy">遗忘</button></div></article>
        <p v-if="!memories.length && !draft" class="empty">暂无记忆。可手动添加，也可在对话中说明需要长期记住的事实。</p>
        <section v-if="revisions.length" class="knowledge-editor"><h3>修订记录</h3><article v-for="revision in revisions" :key="revision.id"><small>版本 {{ revision.revision }} · {{ revision.operation === 'forget' ? '遗忘' : '保存' }} · {{ new Date(revision.at).toLocaleString() }}</small><p>{{ revision.after?.content ?? revision.before?.content }}</p></article><button @click="revisions = []">收起</button></section>
        <details v-if="tab === 'agent' && jobs.length"><summary>后台提炼记录</summary><article v-for="job in jobs" :key="job.id"><small>{{ new Date(job.createdAt).toLocaleString() }} · {{ stateNames[job.status] }}</small><p v-if="job.error">{{ job.error }}</p><button v-if="job.status === 'failed'" :disabled="busy" @click="perform(async () => { await apiRequest(`/api/app/workspace/memory-jobs/${job.id}/retry`, { method: 'POST' }) })">重试</button></article></details>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.knowledge-dialog{width:min(820px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line);border-radius:18px;background:var(--surface);color:var(--text-primary)}
.knowledge-dialog::backdrop{background:rgb(0 0 0 / .5)}header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px;border-bottom:1px solid var(--line)}h2,h3,p{margin:0}header p,.scope-note,.empty,small{color:var(--text-secondary)}header p{margin-top:5px;font-size:13px}nav{display:flex;flex-wrap:wrap;gap:4px;padding:10px 20px;border-bottom:1px solid var(--line)}button,a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:var(--surface);color:var(--text-primary);font:inherit;font-size:14px;cursor:pointer;text-decoration:none}button:hover,a:hover{background:var(--surface-hover)}button[aria-pressed=true]{background:var(--surface-hover);border-color:var(--accent);color:var(--accent)}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.knowledge-body{display:grid;gap:16px;padding:20px 24px;max-height:calc(100dvh - 210px);overflow:auto;overscroll-behavior:contain}label{display:grid;gap:6px;font-size:14px}input:not([type=checkbox]),textarea,select{min-height:44px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;box-sizing:border-box;width:100%}textarea{resize:vertical}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.filters>label{min-width:160px}.filters form{display:flex;align-items:end;gap:8px;flex:1}.filters form label{flex:1}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}article{padding:16px;border:1px solid var(--line);border-radius:12px;display:grid;gap:9px}.knowledge-editor{display:grid;gap:12px;padding:16px;border:1px solid var(--accent);border-radius:12px}fieldset{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px;max-height:240px;overflow:auto}.check{display:flex;align-items:center;min-height:44px;gap:9px}.check input{width:18px;height:18px;accent-color:var(--accent)}small,.scope-note{font-size:13px;line-height:1.5}.pre-wrap{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.knowledge-error{color:var(--danger,#c0392b);white-space:pre-wrap}.empty{padding:24px 8px;text-align:center;line-height:1.6}summary{cursor:pointer;min-height:36px;line-height:1.6}details p{margin-top:8px}
@media(max-width:520px){header{padding:16px}h2{font-size:19px}nav{padding:8px}nav button{flex:1;white-space:nowrap}.knowledge-body{padding:16px;max-height:calc(100dvh - 250px)}.filters{display:grid}.filters form{min-width:0}}
</style>
