<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import { confirmPassword, profiles as loadProfiles, type ConsoleSession } from './api'

const props = defineProps<{ session: ConsoleSession }>()
const emit = defineEmits<{ refresh: []; logout: [] }>()

type PageId = 'overview' | 'users' | 'models' | 'execution' | 'devices' | 'vm' | 'memory' | 'push' | 'voice' | 'network' | 'update' | 'audit' | 'account'
interface NavItem { id: PageId; label: string; hint: string }
const groups: Array<{ label: string; items: NavItem[] }> = [
  { label: '', items: [{ id: 'overview', label: '概览', hint: '服务状态与待处理事项' }] },
  { label: '账号', items: [{ id: 'users', label: '用户与权限', hint: '建号、审核注册、虚拟机许可' }] },
  { label: '模型与 Bot', items: [
    { id: 'models', label: '模型服务', hint: '供应商、账号登录、API Key、辅助模型' },
    { id: 'execution', label: '执行与权限', hint: '执行位置、命令审批、本机工具、文件访问' },
    { id: 'memory', label: '记忆服务', hint: 'OpenViking 连接与会话同步' },
  ] },
  { label: '环境', items: [
    { id: 'devices', label: '电脑与设备', hint: '远程电脑、执行节点、设备授权' },
    { id: 'vm', label: '本地虚拟机', hint: '镜像、容量、实例与空闲策略' },
  ] },
  { label: '系统', items: [
    { id: 'push', label: '消息推送', hint: 'APNs 与 FCM' },
    { id: 'voice', label: '语音', hint: '双流语音与语音服务' },
    { id: 'network', label: '网络与安全', hint: '服务器名称、访问地址、后台访问' },
    { id: 'update', label: '更新与回滚', hint: '检查、更新、回滚' },
    { id: 'audit', label: '审计日志', hint: '登录与所有修改记录' },
    { id: 'account', label: '我的账号', hint: '用户名与密码' },
  ] },
]
const items = groups.flatMap(group => group.items)

const pages: Record<PageId, ReturnType<typeof defineAsyncComponent>> = {
  overview: defineAsyncComponent(() => import('./pages/OverviewPage.vue')),
  users: defineAsyncComponent(() => import('./pages/UsersPage.vue')),
  models: defineAsyncComponent(() => import('@/components/app/HermesModelSettingsPanel.vue')),
  execution: defineAsyncComponent(() => import('./pages/ExecutionPage.vue')),
  devices: defineAsyncComponent(() => import('./pages/DevicesPage.vue')),
  vm: defineAsyncComponent(() => import('@/components/app/LocalVmSettingsPanel.vue')),
  memory: defineAsyncComponent(() => import('./pages/MemoryPage.vue')),
  push: defineAsyncComponent(() => import('./pages/PushPage.vue')),
  voice: defineAsyncComponent(() => import('./pages/VoicePage.vue')),
  network: defineAsyncComponent(() => import('./pages/NetworkPage.vue')),
  update: defineAsyncComponent(() => import('./pages/UpdatePage.vue')),
  audit: defineAsyncComponent(() => import('./pages/AuditPage.vue')),
  account: defineAsyncComponent(() => import('./pages/AccountPage.vue')),
}

const isPage = (value: string): value is PageId => items.some(item => item.id === value)
const page = ref<PageId>(isPage(location.hash.slice(1)) ? location.hash.slice(1) as PageId : 'overview')
const current = computed(() => items.find(item => item.id === page.value)!)
const profileList = ref<Profile[]>([])
const navOpen = ref(false)
const now = ref(Date.now())

function go(id: PageId) {
  page.value = id
  navOpen.value = false
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`)
}
const onHash = () => { const id = location.hash.slice(1); if (isPage(id)) page.value = id }
watch(page, () => emit('refresh'))

const minutesLeft = computed(() => Math.max(0, Math.floor(((props.session.expiresAt ?? 0) - now.value) / 60_000)))
const sudoActive = computed(() => (props.session.sudoUntil ?? 0) > now.value)

const reauthOpen = ref(false)
const reauthPassword = ref('')
const reauthError = ref('')
const reauthBusy = ref(false)
async function reauthenticate() {
  if (reauthBusy.value) return
  reauthBusy.value = true; reauthError.value = ''
  try { await confirmPassword(reauthPassword.value); reauthPassword.value = ''; reauthOpen.value = false; emit('refresh') }
  catch (cause) { reauthError.value = cause instanceof Error ? cause.message : '验证失败' }
  finally { reauthBusy.value = false }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  window.addEventListener('hashchange', onHash)
  timer = setInterval(() => { now.value = Date.now() }, 15_000)
  try { profileList.value = await loadProfiles() } catch { profileList.value = [] }
})
onBeforeUnmount(() => { window.removeEventListener('hashchange', onHash); if (timer) clearInterval(timer) })

const pageProps = computed(() => {
  if (page.value === 'models' || page.value === 'users') return { profiles: profileList.value }
  if (page.value === 'overview') return { onNavigate: (id: string) => { if (isPage(id)) go(id) } }
  if (page.value === 'account') return { session: props.session, onChanged: () => emit('refresh') }
  return {}
})
</script>

<template>
  <div class="shell" :class="{ 'nav-open': navOpen }">
    <aside class="side" aria-label="后台导航">
      <div class="brand"><span class="mark" aria-hidden="true"></span><span>夭夭后台</span><small>{{ session.version }}</small></div>
      <nav>
        <section v-for="group in groups" :key="group.label">
          <h2 v-if="group.label">{{ group.label }}</h2>
          <button v-for="item in group.items" :key="item.id" type="button" :class="{ on: page === item.id }" :aria-current="page === item.id ? 'page' : undefined" @click="go(item.id)">{{ item.label }}</button>
        </section>
      </nav>
    </aside>
    <div class="main">
      <header class="bar">
        <button class="menu" type="button" aria-label="打开导航" @click="navOpen = !navOpen">☰</button>
        <div class="title"><h1>{{ current.label }}</h1><p>{{ current.hint }}</p></div>
        <div class="who">
          <span class="pill" :class="session.external ? 'warn' : 'ok'">{{ session.external ? '允许远程访问' : '仅本机访问' }}</span>
          <button v-if="!sudoActive" class="pill action" type="button" title="改密钥、推送证书、更新等操作前需要确认密码" @click="reauthOpen = true">确认密码</button>
          <span class="pill ok" v-else>已确认密码</span>
          <span class="user">{{ session.user?.username }} · 剩余 {{ minutesLeft }} 分钟</span>
          <button class="ghost" type="button" @click="emit('logout')">退出</button>
        </div>
      </header>
      <form v-if="reauthOpen" class="reauth" @submit.prevent="reauthenticate">
        <span>再次输入管理员密码，之后 10 分钟内的高风险操作不再询问。</span>
        <input v-model="reauthPassword" type="password" autocomplete="current-password" aria-label="管理员密码" required :disabled="reauthBusy" />
        <button class="solid" :disabled="reauthBusy || !reauthPassword">确认</button>
        <button class="ghost" type="button" @click="reauthOpen = false; reauthError = ''">取消</button>
        <p v-if="reauthError" class="error" role="alert">{{ reauthError }}</p>
      </form>
      <main class="content">
        <KeepAlive :max="3">
          <component :is="pages[page]" :key="page" v-bind="pageProps" />
        </KeepAlive>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100%; }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 16px 10px; background: var(--rail-bg); color: #e8ece9; }
.brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px 16px; font-weight: 700; }
.brand small { margin-left: auto; font: 11px var(--font-code); color: #96a29d; font-weight: 400; }
.mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #4cc5a6, #1f8f76); flex: 0 0 auto; }
nav { display: grid; gap: 6px; }
nav section { display: grid; gap: 2px; }
nav h2 { margin: 10px 8px 4px; font: 600 11px var(--font-ui); letter-spacing: .06em; color: #96a29d; }
nav button { text-align: left; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: #cfd8d4; font: 13px var(--font-ui); cursor: pointer; }
nav button:hover { background: rgba(255, 255, 255, .06); }
nav button.on { background: rgba(255, 255, 255, .12); color: #fff; }
nav button:focus-visible, .ghost:focus-visible, .pill.action:focus-visible { outline: 2px solid #4cc5a6; outline-offset: 2px; }
.main { min-width: 0; display: flex; flex-direction: column; }
.bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--canvas); }
.menu { display: none; border: 0; background: transparent; font-size: 18px; color: var(--text-primary); cursor: pointer; }
.title { flex: 1; min-width: 200px; }
.title h1 { margin: 0; font-size: 19px; }
.title p { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
.who { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.pill { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line-strong); font-size: 12px; background: transparent; color: var(--text-secondary); }
.pill.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, transparent); }
.pill.warn { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 40%, transparent); }
.pill.action { cursor: pointer; color: var(--text-primary); }
.ghost { height: 30px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text-primary); font: 12px var(--font-ui); cursor: pointer; }
.solid { height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--text-on-solid); font: 600 12px var(--font-ui); cursor: pointer; }
.solid:disabled { opacity: .5; }
.reauth { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 24px; border-bottom: 1px solid var(--line); background: var(--surface-soft); font-size: 13px; }
.reauth input { height: 32px; padding: 0 10px; border: 1px solid var(--input-border-color); border-radius: 8px; background: var(--surface); color: var(--text-primary); }
.error { flex-basis: 100%; margin: 0; color: var(--danger); font-size: 12px; }
.content { padding: 22px 24px 48px; max-width: 1080px; width: 100%; }
@media (max-width: 760px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: fixed; inset: 0 auto 0 0; width: 240px; z-index: 20; transform: translateX(-100%); transition: transform .2s; }
  .nav-open .side { transform: none; box-shadow: var(--shadow-float); }
  .menu { display: block; }
  .bar, .reauth { padding-inline: max(16px, env(safe-area-inset-left, 0px)); }
  .content { padding-inline: max(16px, env(safe-area-inset-left, 0px)); }
}
@media (prefers-reduced-motion: reduce) { .side { transition: none; } }
</style>
