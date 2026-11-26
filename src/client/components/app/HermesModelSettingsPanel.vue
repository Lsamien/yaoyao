<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import ModelServicesPanel from './ModelServicesPanel.vue'
import { listModelCatalog, type ModelCatalogProvider } from '@/api/agentManagement'
import {
  cancelOAuth, deleteHermesCredential, disconnectOAuth, getAuxiliaryModels, listHermesCredentials, listOAuthProviders,
  pollOAuth, saveHermesCredential, setAuxiliaryModel, startOAuth, submitOAuthToken,
  type AuxiliaryModels, type AuxiliaryTask, type HermesCredential, type OAuthProvider, type OAuthSession,
} from '@/api/hermesAdmin'
import { notifyModelCatalogChanged } from '@/utils/modelCatalogEvents'

type Tab = 'models' | 'accounts' | 'keys' | 'auxiliary'
const props = defineProps<{ profiles?: Profile[] }>()
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'models', label: '供应商与模型' },
  { id: 'accounts', label: '账号登录' },
  { id: 'keys', label: '密钥与变量' },
  { id: 'auxiliary', label: '辅助模型' },
]
const tab = ref<Tab>('models')
const profile = ref('default')
const profileOptions = computed(() => {
  const names = new Set(['default', ...(props.profiles ?? []).map(item => item.name).filter(Boolean)])
  return [...names]
})
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function run(work: () => Promise<void>, success = '') {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await work(); if (success) notice.value = success }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { busy.value = false }
}

// ── 密钥与变量 ───────────────────────────────────────────────────────────────
const credentials = ref<HermesCredential[]>([])
const keyQuery = ref('')
const showAdvanced = ref(false)
const editingKey = ref('')
const editingValue = ref('')
const customKey = ref('')
const customValue = ref('')
const CATEGORY_LABELS: Record<string, string> = { provider: '模型供应商', tool: '工具', skill: '技能', setting: '设置', custom: '自定义' }
const CATEGORY_ORDER = ['provider', 'tool', 'skill', 'setting', 'custom']
const credentialGroups = computed(() => {
  const query = keyQuery.value.trim().toLocaleLowerCase()
  const rows = credentials.value.filter(row => (showAdvanced.value || !row.advanced || row.isSet || query)
    && (!query || `${row.key} ${row.description} ${row.providerLabel}`.toLocaleLowerCase().includes(query)))
  const groups = new Map<string, HermesCredential[]>()
  for (const row of rows) groups.set(row.category, [...(groups.get(row.category) ?? []), row])
  return [...groups.entries()]
    .sort(([a], [b]) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99))
    .map(([category, items]) => ({ category, label: CATEGORY_LABELS[category] ?? category, items: items.sort((a, b) => Number(b.isSet) - Number(a.isSet) || a.key.localeCompare(b.key)) }))
})
async function loadCredentials() { credentials.value = await listHermesCredentials(profile.value) }
function editCredential(row: HermesCredential) { editingKey.value = row.key; editingValue.value = '' }
function saveCredential(key: string, value: string) {
  return run(async () => {
    await saveHermesCredential(profile.value, key, value)
    editingKey.value = ''; editingValue.value = ''; customKey.value = ''; customValue.value = ''
    await loadCredentials(); notifyModelCatalogChanged(profile.value)
  }, `已保存 ${key}`)
}
function clearCredential(row: HermesCredential) {
  if (!window.confirm(`清除 ${row.key}？`)) return
  return run(async () => { await deleteHermesCredential(profile.value, row.key); await loadCredentials(); notifyModelCatalogChanged(profile.value) }, `已清除 ${row.key}`)
}

// ── 账号登录 ────────────────────────────────────────────────────────────────
const oauthProviders = ref<OAuthProvider[]>([])
const login = ref<{ provider: string; session: OAuthSession } | null>(null)
const tokenProvider = ref('')
const tokenValue = ref('')
let pollTimer: ReturnType<typeof setTimeout> | undefined
async function loadOAuth() { oauthProviders.value = await listOAuthProviders(profile.value) }
function loginFlow(provider: OAuthProvider): 'device' | 'token' | 'external' {
  const flow = provider.web_flow || provider.flow
  if (flow === 'paste_token') return 'token'
  if (flow === 'device_code' || flow === 'process') return 'device'
  return 'external'
}
function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined }
function schedulePoll() {
  stopPolling()
  pollTimer = setTimeout(async () => {
    const current = login.value
    if (!current) return
    try {
      const result = await pollOAuth(profile.value, current.provider, current.session.session_id)
      if (login.value?.session.session_id !== current.session.session_id) return
      login.value = { provider: current.provider, session: { ...current.session, ...result } }
      if (!result.status || result.status === 'pending') { schedulePoll(); return }
      if (result.status === 'approved') { notice.value = '登录成功'; login.value = null; await loadOAuth(); notifyModelCatalogChanged(profile.value) }
      else error.value = result.error_message || ({ denied: '登录被拒绝', expired: '登录已过期，请重新开始' } as Record<string, string>)[result.status] || '登录失败'
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '登录状态查询失败' }
  }, 3000)
}
function beginLogin(provider: OAuthProvider) {
  if (loginFlow(provider) === 'token') { tokenProvider.value = provider.id; tokenValue.value = ''; return }
  return run(async () => {
    const session = await startOAuth(profile.value, provider.id)
    login.value = { provider: provider.id, session }
    schedulePoll()
  })
}
function cancelLogin() {
  const current = login.value
  stopPolling(); login.value = null
  if (current) void cancelOAuth(profile.value, current.provider, current.session.session_id).catch(() => undefined)
}
function submitToken() {
  return run(async () => {
    await submitOAuthToken(profile.value, tokenProvider.value, tokenValue.value)
    tokenProvider.value = ''; tokenValue.value = ''
    await loadOAuth(); notifyModelCatalogChanged(profile.value)
  }, '凭据已保存')
}
function logout(provider: OAuthProvider) {
  if (!window.confirm(`退出 ${provider.name}？`)) return
  return run(async () => { await disconnectOAuth(profile.value, provider.id); await loadOAuth(); notifyModelCatalogChanged(profile.value) }, `已退出 ${provider.name}`)
}

// ── 辅助模型 ────────────────────────────────────────────────────────────────
const AUX_LABELS: Record<string, [string, string]> = {
  vision: ['视觉识别', '图片理解与截图分析'],
  compression: ['上下文压缩', '长对话接近上限时整理历史'],
  approval: ['审批判断', '自动审批模式下判断命令风险'],
  mcp: ['MCP 工具', 'MCP 工具的辅助调用'],
  title_generation: ['标题生成', '为会话生成标题'],
  review: ['复核', '回合结束后的记忆与技能复核'],
  voice_chat: ['语音对话', '语音模式下的快速回复'],
  triage_specifier: ['任务分诊', '拆解并细化任务说明'],
  kanban_decomposer: ['任务拆解', '把目标拆成可执行步骤'],
  profile_describer: ['Profile 描述', '生成 Profile 简介'],
  curator: ['技能整理', '后台整理与维护技能'],
  session_search: ['会话搜索', '总结检索到的历史会话'],
  web_extract: ['网页提取', '总结抓取的网页内容'],
}
const auxiliary = ref<AuxiliaryTask[]>([])
const auxMain = ref('')
const auxDrafts = ref<Record<string, { provider: string; model: string }>>({})
const catalog = ref<ModelCatalogProvider[]>([])
const allProviders = ref<Array<{ id: string; label: string }>>([])
/** Providers with a loaded model list first, then the rest of Hermes's providers. */
const auxProviders = computed(() => {
  const seen = new Set(catalog.value.map(item => item.slug))
  return [...catalog.value.map(item => ({ id: item.slug, label: item.name })), ...allProviders.value.filter(item => !seen.has(item.id))]
})
function auxLabel(task: AuxiliaryTask): [string, string] { return AUX_LABELS[task.task] ?? [task.label || task.task, task.hint || ''] }
function modelsFor(provider: string) { return catalog.value.find(item => item.slug === provider)?.models ?? [] }
function applyAuxiliary(value: AuxiliaryModels) {
  auxiliary.value = value.tasks ?? []
  if (value.providers?.length) allProviders.value = value.providers
  auxMain.value = value.main?.model ? `${value.main.provider || ''} / ${value.main.model}` : '未设置'
  auxDrafts.value = Object.fromEntries(auxiliary.value.map(task => [task.task, { provider: task.provider || 'auto', model: task.model || '' }]))
}
async function loadAuxiliary() {
  const [value, providers] = await Promise.all([getAuxiliaryModels(profile.value), listModelCatalog(profile.value).catch(() => [])])
  catalog.value = providers
  applyAuxiliary(value)
}
const auxDirty = computed(() => auxiliary.value.some(task => {
  const draft = auxDrafts.value[task.task]
  return draft && (draft.provider !== (task.provider || 'auto') || (draft.provider !== 'auto' && draft.model !== (task.model || '')))
}))
function saveAuxiliary(task: AuxiliaryTask) {
  const draft = auxDrafts.value[task.task]
  if (!draft) return
  if (draft.provider !== 'auto' && !draft.model.trim()) { error.value = '请填写模型名称'; return }
  return run(async () => applyAuxiliary(await setAuxiliaryModel(profile.value, task.task, draft.provider, draft.model.trim())), `已保存「${auxLabel(task)[0]}」`)
}
function resetAuxiliary() {
  if (!window.confirm('把全部辅助模型恢复为自动？')) return
  return run(async () => applyAuxiliary(await setAuxiliaryModel(profile.value, '__reset__', 'auto', '')), '已全部恢复为自动')
}

// ── 加载 ───────────────────────────────────────────────────────────────────
const modelsDirty = ref(false)
const dirty = computed(() => (tab.value === 'models' && modelsDirty.value) || (tab.value === 'auxiliary' && auxDirty.value) || !!editingKey.value || !!customValue.value || !!tokenValue.value)
watch(dirty, value => emit('dirty-change', value), { immediate: true })

async function load() {
  stopPolling(); login.value = null; editingKey.value = ''; tokenProvider.value = ''
  error.value = ''; notice.value = ''
  if (tab.value === 'models') return
  busy.value = true
  try {
    if (tab.value === 'keys') await loadCredentials()
    else if (tab.value === 'accounts') await loadOAuth()
    else await loadAuxiliary()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
  finally { busy.value = false }
}
function selectTab(next: Tab) {
  if (next === tab.value) return
  if (dirty.value && !window.confirm('放弃当前未保存的更改？')) return
  modelsDirty.value = false
  tab.value = next
}
watch([tab, profile], () => { void load() }, { immediate: true })
onBeforeUnmount(stopPolling)
</script>

<template>
  <section class="hermes-settings" aria-label="模型服务">
    <p class="intro">Hermes 已内置在夭夭服务中，这里替代原来的 Hermes Dashboard：配置模型供应商、账号登录、API Key 和辅助模型。Bot 使用所选 Profile 的这些配置。</p>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="模型服务分类">
        <button v-for="item in tabs" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="selectTab(item.id)">{{ item.label }}</button>
      </div>
      <label v-if="profileOptions.length > 1" class="profile-select">Profile
        <select v-model="profile" :disabled="busy || dirty"><option v-for="name in profileOptions" :key="name" :value="name">{{ name === 'default' ? 'default（系统）' : name }}</option></select>
      </label>
    </div>
    <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="panel-notice" role="status">{{ notice }}</p>

    <ModelServicesPanel v-if="tab === 'models'" :key="profile" :profile="profile" @dirty-change="modelsDirty = $event" />

    <template v-else-if="tab === 'accounts'">
      <p class="hint">适用于用订阅账号或设备码登录的供应商；普通 API Key 请在「密钥与变量」中填写。</p>
      <p v-if="busy && !oauthProviders.length" class="panel-empty">正在读取…</p>
      <ul class="rows">
        <li v-for="provider in oauthProviders" :key="provider.id">
          <div class="row-main">
            <strong>{{ provider.name }}</strong>
            <small :class="{ ok: provider.status?.logged_in }">{{ provider.status?.logged_in ? `已登录${provider.status.source_label ? ` · ${provider.status.source_label}` : ''}${provider.status.token_preview ? ` · …${provider.status.token_preview}` : ''}` : '未登录' }}</small>
            <small v-if="loginFlow(provider) === 'external' && !provider.status?.logged_in" class="muted">需要在服务器上运行 <code>{{ provider.cli_command }}</code> 登录。</small>
          </div>
          <div class="row-actions">
            <a v-if="provider.docs_url" :href="provider.docs_url" target="_blank" rel="noopener noreferrer" class="text-button">说明</a>
            <button v-if="provider.status?.logged_in && provider.disconnectable" type="button" class="text-button danger" :disabled="busy" @click="logout(provider)">退出</button>
            <button v-else-if="!provider.status?.logged_in && loginFlow(provider) !== 'external'" type="button" class="quiet-button" :disabled="busy || !!login" @click="beginLogin(provider)">登录</button>
          </div>
          <div v-if="login?.provider === provider.id" class="flow-box">
            <p>在浏览器打开 <a :href="login.session.verification_url" target="_blank" rel="noopener noreferrer">{{ login.session.verification_url }}</a>，输入代码：</p>
            <code class="user-code">{{ login.session.user_code }}</code>
            <p class="muted">完成后这里会自动更新。</p>
            <button type="button" class="text-button" @click="cancelLogin">取消</button>
          </div>
          <form v-if="tokenProvider === provider.id" class="flow-box" @submit.prevent="submitToken">
            <label>粘贴 API Key 或 setup-token<input v-model="tokenValue" type="password" autocomplete="off" required :disabled="busy"></label>
            <div class="row-actions"><button type="button" class="text-button" @click="tokenProvider = ''; tokenValue = ''">取消</button><button type="submit" class="primary-button" :disabled="busy || !tokenValue.trim()">保存</button></div>
          </form>
        </li>
      </ul>
    </template>

    <template v-else-if="tab === 'keys'">
      <div class="filter-row">
        <input v-model="keyQuery" type="search" placeholder="搜索变量名、说明或供应商" aria-label="搜索变量">
        <label class="check"><input v-model="showAdvanced" type="checkbox">显示高级项</label>
      </div>
      <p class="hint">值只保存在服务器的 Hermes 数据目录，保存后不会再回传到浏览器。</p>
      <p v-if="busy && !credentials.length" class="panel-empty">正在读取…</p>
      <p v-else-if="!credentialGroups.length" class="panel-empty">没有匹配的变量。</p>
      <section v-for="group in credentialGroups" :key="group.category" class="group">
        <h4>{{ group.label }}</h4>
        <ul class="rows">
          <li v-for="row in group.items" :key="row.key">
            <div class="row-main">
              <strong class="mono">{{ row.key }}</strong>
              <small v-if="row.description || row.providerLabel" class="muted">{{ row.providerLabel && !row.description.includes(row.providerLabel) ? `${row.providerLabel} · ` : '' }}{{ row.description }}<a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer"> 获取</a></small>
              <small :class="{ ok: row.isSet }">{{ row.isSet ? `已设置${row.preview ? ` · ${row.preview}` : ''}` : '未设置' }}</small>
            </div>
            <div class="row-actions">
              <span v-if="row.readonly" class="muted">由运行环境管理</span>
              <template v-else>
                <button v-if="row.isSet" type="button" class="text-button danger" :disabled="busy" @click="clearCredential(row)">清除</button>
                <button type="button" class="quiet-button" :disabled="busy" @click="editCredential(row)">{{ row.isSet ? '修改' : '设置' }}</button>
              </template>
            </div>
            <form v-if="editingKey === row.key" class="flow-box" @submit.prevent="saveCredential(row.key, editingValue)">
              <label>{{ row.key }}<input v-model="editingValue" :type="row.secret ? 'password' : 'text'" autocomplete="off" required :disabled="busy"></label>
              <div class="row-actions"><button type="button" class="text-button" @click="editingKey = ''; editingValue = ''">取消</button><button type="submit" class="primary-button" :disabled="busy || !editingValue.trim()">保存</button></div>
            </form>
          </li>
        </ul>
      </section>
      <form class="flow-box custom" @submit.prevent="saveCredential(customKey.trim(), customValue)">
        <strong>添加自定义变量</strong>
        <div class="form-grid">
          <label>变量名<input v-model="customKey" pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="MY_API_KEY" autocomplete="off" :disabled="busy"></label>
          <label>值<input v-model="customValue" type="password" autocomplete="off" :disabled="busy"></label>
        </div>
        <div class="row-actions"><button type="submit" class="primary-button" :disabled="busy || !customKey.trim() || !customValue.trim()">添加</button></div>
      </form>
    </template>

    <template v-else>
      <p class="hint">辅助模型负责压缩、视觉、标题等后台任务。选「自动」时使用主模型（当前：{{ auxMain }}）或 Hermes 自动选择的可用模型。</p>
      <p v-if="busy && !auxiliary.length" class="panel-empty">正在读取…</p>
      <ul class="rows">
        <li v-for="task in auxiliary" :key="task.task" class="aux-row">
          <div class="row-main"><strong>{{ auxLabel(task)[0] }}</strong><small class="muted">{{ auxLabel(task)[1] }}</small></div>
          <div v-if="auxDrafts[task.task]" class="aux-fields">
            <select v-model="auxDrafts[task.task].provider" :aria-label="`${auxLabel(task)[0]} Provider`" :disabled="busy">
              <option value="auto">自动</option>
              <option v-if="task.provider && task.provider !== 'auto' && !auxProviders.some(item => item.id === task.provider)" :value="task.provider">{{ task.provider }}</option>
              <option v-for="item in auxProviders" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
            <input v-if="auxDrafts[task.task].provider !== 'auto'" v-model="auxDrafts[task.task].model" :list="`aux-models-${task.task}`" placeholder="模型名称" :aria-label="`${auxLabel(task)[0]} 模型`" :disabled="busy">
            <datalist :id="`aux-models-${task.task}`"><option v-for="model in modelsFor(auxDrafts[task.task].provider)" :key="model" :value="model" /></datalist>
            <button type="button" class="quiet-button" :disabled="busy" @click="saveAuxiliary(task)">保存</button>
          </div>
        </li>
      </ul>
      <div v-if="auxiliary.length" class="row-actions"><button type="button" class="text-button" :disabled="busy" @click="resetAuxiliary">全部恢复为自动</button></div>
    </template>
  </section>
</template>

<style scoped>
.hermes-settings{display:grid;gap:16px}
.intro,.hint{margin:0;color:var(--text-muted);font-size:12px;line-height:1.6}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft)}
.tabs button{min-height:34px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px;font-weight:600}
.tabs button.active{background:var(--surface-raised);color:var(--text-primary);box-shadow:0 1px 2px rgb(0 0 0 / 8%)}
.profile-select{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:13px}
select,input:not([type=checkbox]){min-width:0;height:38px;box-sizing:border-box;padding:0 10px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:13px var(--font-ui)}
select:focus,input:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}
.rows{display:grid;margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}
.rows li{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:14px 4px;border-bottom:1px solid var(--line)}
.row-main{display:grid;min-width:0;flex:1;gap:4px}
.row-main strong{font-size:14px}
.row-main small{color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere}
.row-main small.ok{color:var(--success,#21845b)}
.muted{color:var(--text-muted)!important;font-size:12px}
.mono{font-family:var(--font-code);font-size:13px!important}
.row-actions{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:8px}
.flow-box{display:grid;flex-basis:100%;gap:10px;padding:14px;border:1px solid var(--line-strong);border-radius:11px;background:var(--surface-soft)}
.flow-box p{margin:0;font-size:13px}
.flow-box label{display:grid;gap:6px;color:var(--text-secondary);font-size:13px;font-weight:600}
.user-code{justify-self:start;padding:8px 14px;border-radius:8px;background:var(--surface-raised);font:600 20px var(--font-code);letter-spacing:.12em}
.custom{flex-basis:auto}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.group h4{margin:8px 0;color:var(--text-secondary);font-size:13px}
.filter-row{display:flex;align-items:center;gap:12px}
.filter-row input[type=search]{flex:1}
.check{display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:13px;white-space:nowrap}
.aux-fields{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.aux-fields select{width:170px}.aux-fields input{width:220px}
.primary-button,.quiet-button{display:inline-flex;min-height:36px;align-items:center;justify-content:center;padding:0 14px;border:0;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}
.primary-button{background:var(--accent);color:var(--text-on-solid)}
.quiet-button{border:1px solid var(--line);background:var(--surface-raised);color:var(--text-secondary)}
.text-button{min-height:32px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px;text-decoration:none;display:inline-flex;align-items:center}
.text-button:hover{background:var(--surface-soft)}.text-button.danger{color:var(--danger)}
button:disabled{cursor:wait;opacity:.5}
.panel-error,.panel-notice,.panel-empty{margin:0;padding:11px 12px;border-radius:9px;font-size:13px}
.panel-error{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}
.panel-notice{background:color-mix(in srgb,var(--success,#21845b) 9%,transparent);color:var(--success,#21845b)}
.panel-empty{color:var(--text-muted);background:var(--surface-soft)}
code{font-family:var(--font-code)}
@media(max-width:600px){.form-grid{grid-template-columns:1fr}.aux-fields,.aux-fields select,.aux-fields input{width:100%}.filter-row{flex-direction:column;align-items:stretch}.rows li{align-items:flex-start}.row-actions{width:100%}}
</style>
