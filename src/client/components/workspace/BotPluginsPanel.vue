<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
import AppIcon from '@/components/common/AppIcon.vue'
import type { JsonValue } from '@shared/types'
import type { WorkspaceAgent } from '@shared/workspace'
import type { BotAppCard, BotAppConnection, BotMcpPlugin, BotPluginSettings } from '@shared/workspacePlugins'

const emit = defineEmits<{ 'dirty-change': [value: boolean] }>()
const base = '/api/app/bot-tools'
const surface = ref<'apps' | 'mcp'>('apps'), view = ref('marketplace')
const settings = ref<BotPluginSettings>({ configured: false, revision: 0 }), canManage = ref(false)
const plugins = ref<BotMcpPlugin[]>([]), cards = ref<BotAppCard[]>([]), connections = ref<BotAppConnection[]>([]), agents = ref<WorkspaceAgent[]>([])
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref(''), search = ref(''), apiKey = ref(''), authConfigs = ref('{}')
const editing = ref<string | null>(null), editorOpen = ref(false), grantSlug = ref(''), grantIds = ref<string[]>([]), aliasSlug = ref(''), alias = ref('')
const form = reactive({ name: '', transport: 'stdio' as 'stdio' | 'http', command: 'npx', args: '[]', url: '', env: '{}', headers: '{}', agentIds: [] as string[], revision: 0 })
const pendingUrls = ref<Record<string, string>>({})
const visibleCount = ref(40)
watch([search, view], () => { visibleCount.value = 40 })
let closed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
const call = <T,>(path: string, method: string, body?: unknown) => apiRequest<T>(base + path, { method, ...(body === undefined ? {} : { body: body as JsonValue }) })
const selectable = computed(() => agents.value.filter(a => !a.archived && !a.remoteAgentId && !a.temporaryGoalId))
const filtered = computed(() => {
  const all = new Map(cards.value.map(c => [c.slug, c]))
  for (const c of connections.value) if (!all.has(c.slug)) all.set(c.slug, { slug: c.slug, name: c.slug, description: '' })
  const query = search.value.trim().toLowerCase()
  return [...all.values()].filter(c => (view.value !== 'connected' || connections.value.some(item => item.slug === c.slug)) && `${c.name} ${c.slug} ${c.description}`.toLowerCase().includes(query))
})
const connected = (slug: string) => connections.value.find(c => c.slug === slug)
const stateLabel = (status: string) => ({ ACTIVE: '已连接', INITIATED: '待授权', INITIALIZING: '连接中', PENDING: '待授权', EXPIRED: '已过期', FAILED: '连接失败', INACTIVE: '未启用' }[status.toUpperCase()] ?? status)
const grantNames = (ids: string[]) => ids.map(id => agents.value.find(a => a.id === id)?.name).filter(Boolean).join('、') || '尚未授权 Bot'
async function load() {
  const version = ++generation
  const results = await Promise.allSettled([
    apiRequest<BotPluginSettings & { canManageMcp: boolean }>(base + '/settings'),
    apiRequest<{ plugins: BotMcpPlugin[]; canManage: boolean }>(base + '/mcp'),
    apiRequest<{ cards: BotAppCard[] }>(base + '/apps/catalog'),
    apiRequest<{ connections: BotAppConnection[]; authoritative: boolean }>(base + '/apps'),
    apiRequest<{ agents: WorkspaceAgent[] }>('/api/app/agents'),
  ])
  if (closed || version !== generation) return
  const [s, m, c, a, bots] = results
  if (s.status === 'fulfilled') { settings.value = s.value; canManage.value = s.value.canManageMcp }
  if (m.status === 'fulfilled') plugins.value = m.value.plugins
  if (c.status === 'fulfilled') cards.value = c.value.cards
  if (a.status === 'fulfilled' && a.value.authoritative) connections.value = a.value.connections
  if (bots.status === 'fulfilled') agents.value = bots.value.agents
  error.value = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason instanceof Error ? r.reason.message : '读取失败，请重试').join('；')
  loading.value = false
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await fn(); if (!closed) await load() } catch (e) { if (!closed) error.value = e instanceof Error ? e.message : '操作失败，请重试' }
  finally { busy.value = false }
}
function edit(plugin?: BotMcpPlugin) {
  editing.value = plugin?.id ?? null
  Object.assign(form, { name: plugin?.name ?? '', transport: plugin?.transport ?? 'stdio', command: plugin?.command ?? 'npx', args: JSON.stringify(plugin?.args ?? [], null, 2), url: plugin?.url ?? '', env: JSON.stringify(Object.fromEntries((plugin?.envKeys ?? []).map(k => [k, true])), null, 2), headers: JSON.stringify(Object.fromEntries((plugin?.headerKeys ?? []).map(k => [k, true])), null, 2), agentIds: [...(plugin?.agentIds ?? [])], revision: plugin?.revision ?? 0 })
  editorOpen.value = true; emit('dirty-change', false)
}
function closeEditor() { editorOpen.value = false; emit('dirty-change', false) }
async function save() {
  await action(async () => {
    let args: unknown, env: unknown, headers: unknown
    try { args = JSON.parse(form.args); env = JSON.parse(form.env); headers = JSON.parse(form.headers) } catch { throw new Error('参数、环境变量和请求头必须是有效 JSON') }
    const definition = { name: form.name, transport: form.transport, command: form.command, args, url: form.url, env, headers, agentIds: form.agentIds }
    await call(editing.value ? '/mcp/' + editing.value : '/mcp', editing.value ? 'PUT' : 'POST', editing.value ? { definition, revision: form.revision } : definition)
    closeEditor(); notice.value = '已保存。测试连接成功后即可启用。'
  })
}
async function test(plugin: BotMcpPlugin) { await action(async () => { const result = await call<{ plugin: BotMcpPlugin }>('/mcp/' + plugin.id + '/test', 'POST', {}); notice.value = `连接成功，发现 ${result.plugin.toolCount} 个工具。` }) }
async function toggle(plugin: BotMcpPlugin) { await action(async () => { await call('/mcp/' + plugin.id, 'PATCH', { enabled: !plugin.enabled, revision: plugin.revision }) }) }
async function remove(plugin: BotMcpPlugin) { if (window.confirm(`移除插件“${plugin.name}”？此插件将不再提供给 Bot。`)) await action(async () => { await call('/mcp/' + plugin.id, 'DELETE') }) }
async function configure(clear = false) {
  if (clear && !window.confirm('清除当前账号的应用连接服务配置？Bot 将暂时无法使用这些应用。')) return
  await action(async () => {
    let configs: unknown
    try { configs = JSON.parse(authConfigs.value) } catch { throw new Error('Auth Config 映射必须是有效 JSON') }
    await call('/settings', 'PUT', { apiKey: clear ? '' : apiKey.value, revision: settings.value.revision, authConfigs: configs })
    apiKey.value = ''; authConfigs.value = '{}'; emit('dirty-change', false); notice.value = clear ? '已清除连接服务配置。' : '应用连接服务已配置。'
  })
}
async function connect(card: BotAppCard) {
  if (busy.value) return
  if (connected(card.slug)?.accounts.length && aliasSlug.value !== card.slug) { aliasSlug.value = card.slug; alias.value = ''; return }
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  const previousAccounts = new Set(connected(card.slug)?.accounts.map(a => a.id) ?? [])
  await action(async () => {
    try {
      const result = await call<{ url: string }>('/apps/' + card.slug + '/authorize', 'POST', alias.value.trim() && aliasSlug.value === card.slug ? { alias: alias.value.trim() } : {})
      pendingUrls.value[card.slug] = result.url
      if (popup) popup.location.href = result.url
      aliasSlug.value = ''; alias.value = ''; notice.value = '请在新窗口完成授权，然后刷新连接状态。'
      clearTimeout(timer); let attempts = 0
      const poll = async () => {
        if (closed) return
        await load()
        const completed = connected(card.slug)?.accounts.some(a => !previousAccounts.has(a.id) && a.status.toUpperCase() === 'ACTIVE')
        if (completed) { delete pendingUrls.value[card.slug]; notice.value = `${card.name} 已连接。` }
        else if (!closed && ++attempts < 24) timer = setTimeout(poll, 5000)
      }
      timer = setTimeout(poll, 5000)
    } catch (e) { popup?.close(); throw e }
  })
}
async function disconnect(slug: string, id: string) { if (window.confirm('断开这个应用账号？其他账号的连接会保留。')) await action(async () => { await call('/apps/' + slug + '/accounts/' + encodeURIComponent(id), 'DELETE'); delete pendingUrls.value[slug] }) }
function openGrant(slug: string) { grantSlug.value = slug; grantIds.value = [...(connected(slug)?.agentIds ?? [])] }
async function saveGrant() { await action(async () => { await call('/apps/' + grantSlug.value + '/agents', 'PUT', { agentIds: grantIds.value, revision: connected(grantSlug.value)?.revision ?? 0 }); grantSlug.value = ''; emit('dirty-change', false) }) }
onMounted(load)
onBeforeUnmount(() => { closed = true; generation++; clearTimeout(timer) })
</script>

<template>
  <section class="bot-plugins" aria-label="Bot 插件管理">
    <p class="intro">为 Bot 连接应用和工具，按需选择可使用它们的机器人。</p>
    <div class="plugin-tabs" role="tablist" aria-label="插件类型">
      <button type="button" role="tab" :aria-selected="surface === 'apps'" @click="surface = 'apps'"><AppIcon name="link" :size="17" />应用</button>
      <button type="button" role="tab" :aria-selected="surface === 'mcp'" @click="surface = 'mcp'"><AppIcon name="tools" :size="17" />MCP 服务</button>
    </div>
    <p v-if="error" class="plugin-error" role="alert">{{ error }} <button type="button" :disabled="busy" @click="load">重试</button></p>
    <p v-if="notice" class="plugin-notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取插件…</p>
    <template v-else-if="surface === 'mcp'">
      <div class="plugin-toolbar"><p>自定义 MCP 服务</p><button :disabled="!canManage || busy" @click="edit()"><AppIcon name="plus" :size="16" />添加服务</button></div>
      <p class="hint">本机程序在 Web 服务所在主机运行。新增或修改后需重新测试并启用，仅向所选 Bot 提供工具。</p>
      <p v-if="!canManage" class="hint">自定义 MCP 服务由管理员管理。</p>
      <form v-if="editorOpen" class="plugin-editor" aria-label="MCP 服务配置" @submit.prevent="save" @input="emit('dirty-change', true)" @change="emit('dirty-change', true)">
        <h4>{{ editing ? '编辑 MCP 服务' : '添加 MCP 服务' }}</h4>
        <label>名称<input v-model="form.name" required maxlength="80" /></label>
        <label>连接方式<select v-model="form.transport"><option value="stdio">本机程序（stdio）</option><option value="http">远程地址（HTTP）</option></select></label>
        <template v-if="form.transport === 'stdio'"><label>程序<input v-model="form.command" required placeholder="npx 或程序的完整路径" /></label><label>参数（JSON 数组）<textarea v-model="form.args" rows="3" spellcheck="false" /></label><label>环境变量（JSON）<textarea v-model="form.env" rows="3" spellcheck="false" autocomplete="off" /></label></template>
        <template v-else><label>MCP 地址<input v-model="form.url" type="url" required placeholder="https://example.com/mcp" /></label><label>请求头（JSON）<textarea v-model="form.headers" rows="3" spellcheck="false" autocomplete="off" /></label></template>
        <p class="hint">凭据请放在环境变量或请求头中。已保存的值用 true 表示保留，不会回显。</p>
        <fieldset><legend>允许使用的 Bot</legend><label v-for="agent in selectable" :key="agent.id" class="check-row"><input v-model="form.agentIds" type="checkbox" :value="agent.id" />{{ agent.name }}</label><p v-if="!selectable.length" class="hint">创建 Bot 后可在这里授权。</p></fieldset>
        <div class="editor-actions"><button type="button" :disabled="busy" @click="closeEditor">取消</button><button type="submit" class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存服务' }}</button></div>
      </form>
      <p v-if="!plugins.length && !editorOpen" class="plugin-empty">还没有 MCP 服务。添加服务并测试连接后，即可授权 Bot 使用。</p>
      <article v-for="plugin in plugins" :key="plugin.id" class="mcp-card">
        <div class="card-heading"><AppIcon name="tools" :size="20" /><h4>{{ plugin.name }}</h4><span class="badge" :class="{ enabled: plugin.enabled }">{{ plugin.enabled ? '已启用' : '未启用' }}</span></div>
        <p class="hint endpoint">{{ plugin.transport === 'stdio' ? plugin.command : plugin.url }}</p>
        <p class="hint">{{ plugin.testedAt ? `已验证 · ${plugin.toolCount} 个工具` : '尚未测试连接' }} · {{ grantNames(plugin.agentIds) }}</p>
        <div class="card-actions"><button :disabled="busy || !canManage" @click="test(plugin)">测试连接</button><button :disabled="busy || !canManage || (!plugin.enabled && !plugin.testedAt)" @click="toggle(plugin)">{{ plugin.enabled ? '停用' : '启用' }}</button><button :disabled="busy || !canManage" @click="edit(plugin)">编辑</button><button class="danger" :disabled="busy || !canManage" @click="remove(plugin)">移除</button></div>
      </article>
    </template>
    <template v-else-if="!loading">
      <div class="plugin-toolbar"><div class="view-tabs" role="tablist" aria-label="应用列表"><button role="tab" :aria-selected="view === 'marketplace'" @click="view = 'marketplace'">应用目录</button><button role="tab" :aria-selected="view === 'connected'" @click="view = 'connected'">已连接 {{ connections.length || '' }}</button></div><button :disabled="busy" aria-label="刷新应用连接" @click="load"><AppIcon name="refresh" :size="17" /></button></div>
      <label class="plugin-search"><AppIcon name="search" :size="17" /><input v-model="search" type="search" aria-label="搜索应用" placeholder="搜索应用" /></label>
      <p v-if="!settings.configured" class="plugin-notice">配置 Composio 连接服务后，即可连接应用。</p>
      <div class="app-grid"><article v-for="card in filtered.slice(0, visibleCount)" :key="card.slug" class="app-card">
        <div class="card-heading"><span class="app-monogram" aria-hidden="true">{{ card.name.slice(0, 1) }}</span><h4>{{ card.name }}</h4></div><p class="hint">{{ card.description }}</p>
        <div v-for="account in connected(card.slug)?.accounts ?? []" :key="account.id" class="app-account"><span>{{ account.alias || stateLabel(account.status) }}<small v-if="account.alias">{{ stateLabel(account.status) }}</small></span><button class="danger" :disabled="busy" :aria-label="`断开 ${card.name} ${account.alias || '账号'}`" @click="disconnect(card.slug, account.id)">断开</button></div>
        <label v-if="aliasSlug === card.slug">账号别名<input v-model="alias" placeholder="例如：工作账号" maxlength="64" /></label>
        <div class="card-actions"><button :disabled="busy || !settings.configured || (aliasSlug === card.slug && !alias.trim())" @click="connect(card)">{{ aliasSlug === card.slug ? '继续连接' : connected(card.slug)?.accounts.length ? '添加账号' : '连接' }}</button><button v-if="connected(card.slug)?.accounts.length" :disabled="busy" @click="openGrant(card.slug)">授权 Bot</button></div>
        <a v-if="pendingUrls[card.slug]" :href="pendingUrls[card.slug]" target="_blank" rel="noopener noreferrer">继续授权 <AppIcon name="external" :size="13" /></a>
        <p v-if="connected(card.slug)" class="hint">{{ grantNames(connected(card.slug)!.agentIds) }}</p>
        <form v-if="grantSlug === card.slug" class="grant-editor" @submit.prevent="saveGrant" @change="emit('dirty-change', true)"><fieldset><legend>允许使用的 Bot</legend><label v-for="agent in selectable" :key="agent.id" class="check-row"><input v-model="grantIds" type="checkbox" :value="agent.id" />{{ agent.name }}</label></fieldset><div class="card-actions"><button type="button" :disabled="busy" @click="grantSlug = ''; emit('dirty-change', false)">取消</button><button type="submit" :disabled="busy">保存授权</button></div></form>
      </article></div>
      <button v-if="filtered.length > visibleCount" type="button" @click="visibleCount += 40">显示更多应用（{{ filtered.length - visibleCount }}）</button>
      <p v-if="!filtered.length" class="plugin-empty">{{ search ? '没有匹配的应用。' : '还没有已连接的应用。可前往应用目录添加。' }}</p>
      <details class="connection-settings" :open="!settings.configured"><summary>应用连接服务 <span>{{ settings.configured ? '已配置' : '未配置' }}</span></summary><p class="hint">使用你的 Composio 项目连接应用。密钥加密保存在服务器，仅用于当前账号。</p><form @submit.prevent="configure()" @input="emit('dirty-change', true)"><label>Composio API Key<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="settings.configured ? '已保存，输入新密钥可替换' : 'ak_…'" /></label><details><summary>自定义 Auth Config（可选）</summary><label>应用与 Auth Config 映射（JSON）<textarea v-model="authConfigs" rows="3" spellcheck="false" /></label></details><div class="card-actions"><button type="submit" :disabled="busy || !apiKey.trim()">保存连接服务</button><button v-if="settings.configured" type="button" class="danger" :disabled="busy" @click="configure(true)">清除配置</button><a href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer">获取 API Key</a></div></form></details>
    </template>
  </section>
</template>

<style scoped>
.bot-plugins{display:grid;gap:16px;color:var(--text-primary);font-size:13px}.intro,.hint{color:var(--text-secondary);line-height:1.6;margin:0}.hint{font-size:12px}.plugin-tabs,.view-tabs,.plugin-toolbar,.card-heading,.card-actions,.editor-actions{display:flex;align-items:center;gap:8px}.plugin-tabs{border-bottom:1px solid var(--line);padding-bottom:8px}.plugin-tabs button[aria-selected=true],.view-tabs button[aria-selected=true]{background:var(--surface-soft);font-weight:650}.plugin-toolbar{justify-content:space-between}.plugin-toolbar p{margin:0;font-weight:650}.card-heading h4{font-size:14px;margin:0;flex:1;min-width:0;overflow-wrap:anywhere}.card-actions{flex-wrap:wrap}.bot-plugins button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-raised);color:inherit;font:inherit;cursor:pointer}.bot-plugins button:hover{background:var(--surface-hover)}.bot-plugins button:disabled{opacity:.45;cursor:not-allowed}.bot-plugins :is(button,input,select,textarea,a,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}.bot-plugins a{color:var(--accent);display:inline-flex;align-items:center;gap:4px}.bot-plugins .danger{color:var(--danger)}.bot-plugins .primary{background:var(--accent);color:var(--text-on-solid);border-color:var(--accent)}.bot-plugins label{display:grid;gap:6px;font-size:12px;line-height:1.6}.bot-plugins input:not([type=checkbox]),.bot-plugins select,.bot-plugins textarea{width:100%;box-sizing:border-box;min-width:0;padding:9px 10px;border:1px solid var(--line);border-radius:8px;color:var(--text-primary);background:var(--surface);font:inherit}.bot-plugins textarea{resize:vertical;font-family:var(--font-mono,monospace)}.plugin-search{position:relative}.plugin-search>svg{position:absolute;left:10px;top:11px;color:var(--text-muted)}.plugin-search input{padding-left:34px!important}.plugin-editor,.mcp-card,.app-card,.connection-settings{border:1px solid var(--line);border-radius:12px;padding:14px;display:grid;gap:12px;background:var(--surface)}.plugin-editor h4{margin:0}.plugin-editor{background:var(--surface-soft)}.editor-actions{justify-content:flex-end}.bot-plugins fieldset{border:1px solid var(--line);border-radius:8px;display:grid;gap:4px;max-height:180px;overflow:auto}.bot-plugins .check-row{display:flex;align-items:center;gap:8px;min-height:32px}.check-row input{accent-color:var(--accent)}.app-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.app-card{align-content:start}.app-monogram{display:grid;place-items:center;width:34px;height:34px;flex-shrink:0;border-radius:9px;background:var(--surface-soft);font-size:17px;font-weight:650}.app-account{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding-top:8px}.app-account span{min-width:0;overflow-wrap:anywhere}.app-account small{display:block;color:var(--text-muted);margin-top:3px}.badge{font-size:11px;color:var(--text-muted);white-space:nowrap}.badge.enabled{color:var(--accent)}.endpoint{overflow-wrap:anywhere}.plugin-error,.plugin-notice{padding:12px;border-radius:8px;background:var(--surface-soft);margin:0;line-height:1.6}.plugin-error{color:var(--danger)}.plugin-empty{text-align:center;color:var(--text-secondary);padding:28px 12px;line-height:1.8}.connection-settings{display:block}.connection-settings summary{cursor:pointer;font-weight:600;line-height:1.8}.connection-settings summary span{float:right;font-weight:400;color:var(--text-muted)}.connection-settings p{margin:12px 0}.connection-settings form{display:grid;gap:12px}.grant-editor{display:grid;gap:8px}@media(max-width:767px){.app-grid{grid-template-columns:1fr}.bot-plugins button{min-height:44px}.bot-plugins .check-row{min-height:44px}}
</style>
