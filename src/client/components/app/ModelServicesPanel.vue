<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  activateModelService,
  deleteModelService,
  listLegacyModelServices,
  listModelCatalog,
  listModelServices,
  saveLegacyModelService,
  saveModelService,
  saveProfileDefaultModel,
  validateModelService,
  type CustomModelService,
  type CustomModelServiceInput,
  type LegacyModelService,
  type ModelCatalogProvider,
} from '@/api/agentManagement'
import { notifyModelCatalogChanged } from '@/utils/modelCatalogEvents'

const props = defineProps<{ profile: string }>()
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

interface Draft {
  source: 'managed' | 'legacy'
  id: string
  name: string
  baseUrl: string
  apiKey: string
  apiKeyTouched: boolean
  clearApiKey: boolean
  model: string
  modelsText: string
  contextLength: string
  discoverModels: boolean
  makeDefault: boolean
  hasApiKey: boolean
  canEditApiKey: boolean
}

const services = ref<CustomModelService[]>([])
const legacyServices = ref<LegacyModelService[]>([])
const catalog = ref<ModelCatalogProvider[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const draft = ref<Draft | null>(null)
const draftBaseline = ref('')
const query = ref('')
const defaultModelKey = ref('')
const defaultModelBaseline = ref('')

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function modelSelection(key: string): { provider: string; model: string } | undefined {
  try {
    const value = JSON.parse(key)
    if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string' && item.trim())) {
      return { provider: value[0], model: value[1] }
    }
  } catch { /* Invalid selections are rejected before saving. */ }
  return undefined
}

function emptyDraft(): Draft {
  return { source: 'managed', id: '', name: '', baseUrl: '', apiKey: '', apiKeyTouched: false, clearApiKey: false, model: '', modelsText: '', contextLength: '', discoverModels: true, makeDefault: false, hasApiKey: false, canEditApiKey: true }
}

function draftSnapshot(value: Draft): string {
  return JSON.stringify(value)
}

const draftDirty = computed(() => Boolean(draft.value) && draftSnapshot(draft.value!) !== draftBaseline.value)
const defaultModelDirty = computed(() => Boolean(defaultModelKey.value) && defaultModelKey.value !== defaultModelBaseline.value)
const panelDirty = computed(() => draftDirty.value || defaultModelDirty.value)

function replaceDraft(next: Draft): boolean {
  if (draftDirty.value && !window.confirm('放弃当前模型服务未保存的更改？')) return false
  draft.value = next
  draftBaseline.value = draftSnapshot(next)
  return true
}

function beginCreate() {
  replaceDraft(emptyDraft())
}

function closeEditor() {
  if (draftDirty.value && !window.confirm('放弃当前模型服务未保存的更改？')) return
  draft.value = null
  draftBaseline.value = ''
}

function edit(service: CustomModelService | LegacyModelService) {
  const next: Draft = {
    source: service.source === 'legacy' ? 'legacy' : 'managed',
    id: service.id,
    name: service.name,
    baseUrl: service.base_url,
    apiKey: '',
    apiKeyTouched: false,
    clearApiKey: false,
    model: service.model,
    modelsText: service.models.join('\n'),
    contextLength: service.context_length ? String(service.context_length) : '',
    discoverModels: service.discover_models,
    makeDefault: service.is_current,
    hasApiKey: service.has_api_key,
    canEditApiKey: !('can_edit_api_key' in service) || service.can_edit_api_key,
  }
  if (!replaceDraft(next)) return
  error.value = ''
  notice.value = ''
}

async function load(preserveDefaultDraft = false) {
  const selectedDefault = defaultModelKey.value
  const preserveSelection = preserveDefaultDraft && defaultModelDirty.value
  loading.value = true
  error.value = ''
  try {
    const [managed, legacy, available] = await Promise.all([
      listModelServices(props.profile),
      listLegacyModelServices(props.profile),
      listModelCatalog(props.profile),
    ])
    services.value = managed.endpoints || []
    legacyServices.value = legacy
    catalog.value = available
    const current = available.find(provider => provider.isCurrent && provider.currentModel)
    const key = current?.currentModel ? modelKey(current.slug, current.currentModel) : ''
    defaultModelBaseline.value = key
    defaultModelKey.value = preserveSelection ? selectedDefault : key
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '模型服务加载失败'
  } finally {
    loading.value = false
  }
}

async function saveDefaultModel() {
  const selection = modelSelection(defaultModelKey.value)
  if (!selection) { error.value = '请选择默认 Provider 与模型'; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await saveProfileDefaultModel(props.profile, selection.provider, selection.model)
    await load()
    notifyModelCatalogChanged(props.profile)
    notice.value = `默认全局模型已更新为 ${selection.provider} / ${selection.model}，仅影响新会话`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '默认全局模型保存失败'
  } finally {
    busy.value = false
  }
}

const providerGroups = computed(() => {
  const editable = new Map<string, CustomModelService | LegacyModelService>()
  for (const service of [...services.value, ...legacyServices.value]) editable.set(service.id.toLocaleLowerCase(), service)
  const groups = catalog.value.map(provider => {
    const service = editable.get(provider.slug.toLocaleLowerCase())
    if (service) editable.delete(provider.slug.toLocaleLowerCase())
    return { provider, service, models: provider.models.length ? provider.models : service?.models || [] }
  })
  for (const service of editable.values()) {
    groups.push({
      provider: { slug: service.id, name: service.name, models: service.models, isCurrent: service.is_current },
      service,
      models: service.models,
    })
  }
  return groups
})

const filteredProviderGroups = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return providerGroups.value
  return providerGroups.value.filter(group => [
    group.provider.name,
    group.provider.slug,
    group.service?.base_url || '',
    ...group.models,
  ].some(value => value.toLocaleLowerCase().includes(needle)))
})

function inputFor(current: Draft): CustomModelServiceInput {
  const models = [...new Set(current.modelsText.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean))]
  const contextLength = Number(current.contextLength)
  const input: CustomModelServiceInput = {
    ...(current.id ? { id: current.id } : {}),
    name: current.name.trim(),
    base_url: current.baseUrl.trim().replace(/\/$/, ''),
    model: current.model.trim(),
    models: [...new Set([...models, current.model.trim()].filter(Boolean))],
    discover_models: current.discoverModels,
    make_default: current.makeDefault,
    ...(Number.isInteger(contextLength) && contextLength > 0 ? { context_length: contextLength } : {}),
  }
  if (current.clearApiKey) input.api_key = ''
  else if (current.apiKeyTouched && current.apiKey.trim()) input.api_key = current.apiKey.trim()
  return input
}

function validateDraft(): string {
  const value = draft.value
  if (!value?.name.trim()) return '请输入服务名称'
  if (!/^https?:\/\//i.test(value.baseUrl.trim())) return 'Base URL 必须以 http:// 或 https:// 开头'
  if (!value.model.trim()) return '请输入默认模型'
  if (value.contextLength && (!Number.isInteger(Number(value.contextLength)) || Number(value.contextLength) <= 0)) return '上下文长度必须是正整数'
  return ''
}

async function probe() {
  const value = draft.value
  if (!value) return
  if (value.hasApiKey && !value.apiKeyTouched && !value.clearApiKey) {
    error.value = '9119 不会向浏览器回传已保存密钥；请重新输入 API Key 后再测试'
    return
  }
  const validationError = validateDraft()
  if (validationError) { error.value = validationError; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await validateModelService(inputFor(value))
    if (!result.ok) throw new Error(result.message || '连接测试失败')
    const models = [...new Set(result.models.map(item => item.trim()).filter(Boolean))]
    if (models.length) {
      value.modelsText = models.join('\n')
      if (!models.includes(value.model)) value.model = models[0]!
    }
    notice.value = models.length ? `连接正常，发现 ${models.length} 个模型` : '连接正常，未返回模型列表'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '连接测试失败'
  } finally {
    busy.value = false
  }
}

async function save() {
  const value = draft.value
  if (!value) return
  const validationError = validateDraft()
  if (validationError) { error.value = validationError; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    if (value.source === 'legacy') await saveLegacyModelService(props.profile, value.id, inputFor(value))
    else await saveModelService(props.profile, inputFor(value))
    draft.value = null
    draftBaseline.value = ''
    await load(true)
    notifyModelCatalogChanged(props.profile)
    notice.value = 'Provider 与模型已保存并刷新目录'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '模型服务保存失败'
  } finally {
    busy.value = false
  }
}

async function activate(service: CustomModelService) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await activateModelService(props.profile, service.id)
    await load(true)
    notifyModelCatalogChanged(props.profile)
    notice.value = `“${service.name}”已设为当前机器人的默认模型服务`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '设为默认失败'
  } finally {
    busy.value = false
  }
}

async function remove(service: CustomModelService) {
  const suffix = service.is_current ? '，当前默认绑定也会被解除' : ''
  if (!window.confirm(`删除模型服务“${service.name}”及其模型${suffix}？`)) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await deleteModelService(props.profile, service.id)
    if (draft.value?.id === service.id) draft.value = null
    if (!draft.value) draftBaseline.value = ''
    await load(true)
    notifyModelCatalogChanged(props.profile)
    notice.value = `“${service.name}”已删除`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除模型服务失败'
  } finally {
    busy.value = false
  }
}

watch(() => props.profile, () => { draft.value = null; draftBaseline.value = ''; defaultModelKey.value = ''; defaultModelBaseline.value = ''; void load() })
watch(panelDirty, value => emit('dirty-change', value), { immediate: true })
onMounted(() => { void load() })
</script>

<template>
  <section class="management-panel" aria-label="模型服务">
    <div class="panel-context"><strong>9119 Provider 与模型</strong><span>全部来自当前机器人：<b>{{ profile }}</b></span></div>
    <form class="default-model-card" @submit.prevent="saveDefaultModel">
      <label><strong>默认全局模型</strong><small>仅用于之后新建的会话，已有会话保持原模型。</small></label>
      <select v-model="defaultModelKey" aria-label="默认全局模型" :disabled="busy || loading">
        <option value="" disabled>请选择 Provider 与模型</option>
        <optgroup v-for="provider in catalog" :key="provider.slug" :label="provider.name">
          <option v-for="model in provider.models" :key="modelKey(provider.slug, model)" :value="modelKey(provider.slug, model)">{{ provider.slug }} / {{ model }}</option>
        </optgroup>
      </select>
      <button class="primary-button" type="submit" :disabled="busy || loading || !defaultModelDirty">保存默认模型</button>
    </form>
    <div class="panel-heading"><label class="provider-search"><AppIcon name="search" :size="18" /><input v-model="query" type="search" placeholder="搜索 Provider 或模型" aria-label="搜索 Provider 或模型" /></label><button class="primary-button" type="button" :disabled="busy || loading" @click="beginCreate"><AppIcon name="plus" :size="15" />新增服务</button></div>
    <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="panel-notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="panel-empty">正在读取 9119 Provider 与模型…</p>
    <div v-else-if="filteredProviderGroups.length" class="service-list">
      <article v-for="group in filteredProviderGroups" :key="group.provider.slug" class="service-card">
        <div class="service-main"><div class="service-title"><strong>{{ group.provider.name }}</strong><em v-if="group.provider.isCurrent || group.service?.is_current">当前默认</em><em>{{ group.service ? '可编辑' : '只读' }}</em></div><small>{{ group.provider.slug }}<template v-if="group.service?.base_url"> · {{ group.service.base_url }}</template></small><div class="model-chips"><span v-for="model in group.models" :key="model" :class="{ current: group.provider.isCurrent && model === group.provider.currentModel }">{{ model }}</span></div></div>
        <div v-if="group.service" class="card-actions"><button type="button" :disabled="busy" @click="edit(group.service)">编辑</button><button v-if="group.service.source !== 'legacy' && !group.service.is_current" type="button" :disabled="busy" @click="activate(group.service)">设为默认</button><button v-if="group.service.source !== 'legacy'" class="danger" type="button" :disabled="busy" @click="remove(group.service)">删除</button></div>
      </article>
    </div>
    <p v-else-if="!loading" class="panel-empty">{{ query.trim() ? '没有匹配的 Provider 或模型。' : '9119 当前没有返回可用 Provider 或模型。' }}</p>
    <p v-if="!loading" class="catalog-note">完整目录来自 Hermes 9119；仅支持的自定义服务可编辑。</p>

    <form v-if="draft" class="service-editor" :aria-busy="busy" @submit.prevent="save">
      <header><strong>{{ draft.id ? `编辑 ${draft.id}` : '新增模型服务' }}</strong><button type="button" aria-label="关闭编辑" :disabled="busy" @click="closeEditor"><AppIcon name="close" :size="15" /></button></header>
      <div class="form-grid"><label>名称<input v-model="draft.name" :disabled="busy || draft.source === 'legacy'" maxlength="100" autocomplete="off" /></label><label>Base URL<input v-model="draft.baseUrl" :disabled="busy" placeholder="https://example.com/v1" autocomplete="url" /></label></div>
      <div class="form-grid"><label>默认模型<input v-model="draft.model" :disabled="busy" placeholder="model-id" autocomplete="off" /></label><label>上下文长度（可选）<input v-model="draft.contextLength" :disabled="busy" inputmode="numeric" placeholder="例如 131072" /></label></div>
      <label v-if="draft.canEditApiKey">API Key<input v-model="draft.apiKey" type="password" :disabled="busy" :placeholder="draft.hasApiKey && !draft.clearApiKey ? '已保存；留空保持不变' : '可选'" autocomplete="new-password" @input="draft.apiKeyTouched = Boolean(draft.apiKey.trim()); draft.clearApiKey = false" /></label>
      <p v-else class="editor-hint">该 Provider 的密钥不由 9119 环境变量管理，因此这里只编辑 URL 和模型。</p>
      <button v-if="draft.canEditApiKey && draft.hasApiKey && !draft.clearApiKey" class="text-button danger" type="button" :disabled="busy" @click="draft.apiKey = ''; draft.apiKeyTouched = false; draft.clearApiKey = true">清除已保存密钥</button><button v-else-if="draft.canEditApiKey && draft.clearApiKey" class="text-button" type="button" :disabled="busy" @click="draft.clearApiKey = false">取消清除密钥</button>
      <label>模型列表（每行一个）<textarea v-model="draft.modelsText" rows="5" :disabled="busy" placeholder="连接测试后自动填充，也可手动输入" /></label>
      <label class="check-row"><input v-model="draft.discoverModels" type="checkbox" :disabled="busy" />允许 9119 自动发现模型</label><label v-if="draft.source === 'managed'" class="check-row"><input v-model="draft.makeDefault" type="checkbox" :disabled="busy" />保存后设为当前机器人默认服务</label>
      <small class="editor-hint">{{ draft.source === 'legacy' ? '保存后模型列表按当前内容更新；当前默认 Provider 会同步新的 URL 与默认模型。' : '9119 会保留服务中已有的模型条目；删除整项服务会一并移除它们。' }}</small>
      <footer><button class="quiet-button" type="button" :disabled="busy" @click="probe">测试连接</button><button class="primary-button" type="submit" :disabled="busy">{{ busy ? '处理中…' : '保存模型服务' }}</button></footer>
    </form>
  </section>
</template>

<style scoped>
.management-panel{display:grid;gap:16px}.panel-context{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-secondary)}.panel-context strong{font-size:14px}.panel-context span{color:var(--text-muted);font-size:12px}.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:40px}.provider-search{display:flex;min-width:0;min-height:44px;flex:1;align-items:center;gap:9px;padding:0 12px;border:1px solid var(--line);border-radius:9px;color:var(--text-muted);background:var(--surface-raised)}.provider-search:focus-within{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}.provider-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--text-primary);font:14px var(--font-ui)}.primary-button,.quiet-button{display:inline-flex;min-height:40px;align-items:center;justify-content:center;gap:7px;padding:0 14px;border:0;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}.primary-button{background:var(--accent);color:var(--text-on-solid)}.quiet-button{border:1px solid var(--line);background:var(--surface-raised);color:var(--text-secondary)}button:disabled{cursor:wait;opacity:.5}.panel-error,.panel-notice,.panel-empty{margin:0;padding:11px 12px;border-radius:9px;font-size:13px}.panel-error{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}.panel-notice{background:color-mix(in srgb,var(--success,#21845b) 9%,transparent);color:var(--success,#21845b)}.panel-empty{color:var(--text-muted);background:var(--surface-soft)}.service-list{display:grid;border-top:1px solid var(--line)}.service-card{display:flex;align-items:center;gap:14px;padding:18px 12px;border:0;border-bottom:1px solid var(--line)}.service-main{display:grid;min-width:0;flex:1;gap:8px}.service-title{display:flex;flex-wrap:wrap;align-items:center;gap:7px}.service-card strong{font-size:16px}.service-card small{color:var(--text-muted);font:12px var(--font-code);overflow-wrap:anywhere}.service-card em{padding:3px 7px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--text-muted);font:normal 11px var(--font-ui)}.model-chips{display:flex;flex-wrap:wrap;gap:8px}.model-chips span{max-width:100%;padding:6px 9px;overflow:hidden;border-radius:7px;background:var(--surface-soft);color:var(--text-secondary);font:11px var(--font-code);text-overflow:ellipsis;white-space:nowrap}.model-chips span.current{background:color-mix(in srgb,var(--accent) 9%,var(--surface-soft));color:var(--accent)}.card-actions{display:flex;flex:0 0 auto;gap:7px}.card-actions button,.service-editor header button,.text-button{min-height:32px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px}.card-actions button:hover,.text-button:hover{background:var(--surface-soft)}.card-actions .danger,.text-button.danger{color:var(--danger)}.catalog-note{margin:0;color:var(--text-muted);font-size:12px;line-height:1.6}.service-editor{display:grid;gap:14px;padding:18px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-soft)}.service-editor header{display:flex;align-items:center;justify-content:space-between}.service-editor header strong{font-size:15px}.service-editor header button{display:grid;width:36px;height:36px;place-items:center}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.service-editor label{display:grid;gap:7px;color:var(--text-secondary);font-size:13px;font-weight:650}.service-editor input:not([type=checkbox]),.service-editor textarea{width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:13px var(--font-ui)}.service-editor input:not([type=checkbox]){height:42px}.service-editor input:focus,.service-editor textarea:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}.service-editor textarea{resize:vertical;font-family:var(--font-code);line-height:1.5}.check-row{display:flex!important;align-items:center;gap:8px!important;font-weight:500!important}.text-button{justify-self:start;padding-inline:0}.editor-hint{margin:0;color:var(--text-muted);font-size:11px}.service-editor footer{display:flex;justify-content:flex-end;gap:9px}@media(max-width:600px){.panel-heading{align-items:stretch;flex-direction:column;gap:10px}.panel-heading .primary-button{width:100%}.panel-context{align-items:flex-start;flex-direction:column}.service-card{align-items:flex-start;flex-direction:column}.card-actions{width:100%;justify-content:flex-end}.form-grid{grid-template-columns:1fr}}
.default-model-card{display:grid;grid-template-columns:minmax(180px,1fr) minmax(240px,2fr) auto;align-items:end;gap:12px;padding:14px;border:1px solid var(--line);border-radius:11px;background:var(--surface-soft)}
.default-model-card label{display:grid;gap:4px;color:var(--text-secondary)}
.default-model-card label small{color:var(--text-muted);font-size:11px;font-weight:400}
.default-model-card select{min-width:0;height:40px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface-raised);color:var(--text-primary);font:12px var(--font-code)}
@media(max-width:600px){.default-model-card{grid-template-columns:1fr}.default-model-card .primary-button{width:100%}}
</style>
