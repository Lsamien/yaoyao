<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { overview, type ConsoleOverview } from '../api'

const emit = defineEmits<{ navigate: [page: string] }>()
const data = ref<ConsoleOverview>()
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true; error.value = ''
  try { data.value = await overview() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
  finally { loading.value = false }
}
onMounted(load)

const todo = computed(() => {
  const value = data.value
  if (!value) return []
  const rows: Array<{ text: string; detail: string; page: string; action: string }> = []
  if (value.users.pending.length) rows.push({ text: `${value.users.pending.length} 个账号等待开通`, detail: value.users.pending.map(user => user.username).join('、'), page: 'users', action: '去审核' })
  for (const host of value.desktopHosts.offline) rows.push({ text: `电脑「${host.name}」离线`, detail: host.lastSeen ? `最后在线 ${new Date(host.lastSeen).toLocaleString('zh-CN')}` : '注册后尚未连接', page: 'devices', action: '查看' })
  if (value.update?.updateAvailable) rows.push({ text: `可更新到 ${value.update.latest}`, detail: `当前 ${value.update.current}`, page: 'update', action: '更新' })
  if (!value.kernel.ready) rows.push({ text: '内置 Hermes 内核不可用', detail: value.kernel.error ?? '', page: 'network', action: '查看' })
  if (!value.push.configured) rows.push({ text: '手机推送尚未配置', detail: '配置 APNs 或 FCM 后，手机才能收到 Bot 完成通知', page: 'push', action: '配置' })
  return rows
})
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="overview">
    <p v-if="error" class="error" role="alert">{{ error }} <button type="button" class="link" @click="load">重试</button></p>
    <template v-if="data">
      <div class="tiles">
        <div class="tile"><small>内置 Hermes</small><b>{{ data.kernel.version }}</b><span :class="data.kernel.ready ? 'ok' : 'bad'">{{ data.kernel.ready ? '就绪' : '不可用' }}</span></div>
        <div class="tile"><small>账号</small><b>{{ data.users.total }}</b><span :class="data.users.pending.length ? 'warn' : ''">{{ data.users.pending.length ? `${data.users.pending.length} 个待开通` : `${data.users.disabled} 个已停用` }}</span></div>
        <div class="tile"><small>电脑在线</small><b>{{ data.desktopHosts.online }} / {{ data.desktopHosts.total }}</b><span :class="data.desktopHosts.offline.length ? 'warn' : data.desktopHosts.total ? 'ok' : ''">{{ !data.desktopHosts.total ? '尚未添加电脑' : data.desktopHosts.offline.length ? `${data.desktopHosts.offline.length} 台离线` : '全部在线' }}</span></div>
        <div class="tile"><small>执行节点在线</small><b>{{ data.runners.online }} / {{ data.runners.total }}</b><span>{{ data.push.configured ? `推送已配置 · ${data.push.registrations} 台设备` : '推送未配置' }}</span></div>
      </div>
      <div class="split">
        <section class="panel">
          <header><strong>待处理</strong><span>{{ todo.length }} 项</span></header>
          <p v-if="!todo.length" class="empty">没有需要处理的事项。</p>
          <div v-for="row in todo" :key="row.text" class="row">
            <div class="text"><span>{{ row.text }}</span><small>{{ row.detail }}</small></div>
            <button type="button" class="ghost" @click="emit('navigate', row.page)">{{ row.action }}</button>
          </div>
        </section>
        <section class="panel">
          <header><strong>最近操作</strong><button type="button" class="link" @click="emit('navigate', 'audit')">审计日志</button></header>
          <p v-if="!data.recentAudit.length" class="empty">还没有记录。</p>
          <ul class="log">
            <li v-for="entry in data.recentAudit" :key="entry.id"><time>{{ time(entry.at) }}</time><span>{{ entry.actor }} · {{ entry.module }} · {{ entry.action }}</span><em :class="entry.outcome">{{ entry.outcome === 'ok' ? '成功' : entry.outcome === 'denied' ? '拒绝' : '失败' }}</em></li>
          </ul>
        </section>
      </div>
      <p class="footnote">版本 {{ data.version }} · Web {{ data.web.host }}:{{ data.web.port }} · 后台 {{ data.console.host }}:{{ data.console.port }}</p>
    </template>
    <p v-else-if="loading" class="empty">正在读取…</p>
  </div>
</template>

<style scoped>
.overview { display: grid; gap: 18px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { display: grid; gap: 4px; padding: 14px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); }
.tile small { color: var(--text-muted); }
.tile b { font: 600 22px var(--font-code); font-variant-numeric: tabular-nums; }
.tile span { font-size: 12px; color: var(--text-secondary); }
.ok { color: var(--success) !important; } .warn { color: var(--warning) !important; } .bad { color: var(--danger) !important; }
.split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; }
.panel { border: 1px solid var(--line); border-radius: 11px; overflow: hidden; background: var(--surface); }
.panel header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
.row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.text { display: grid; flex: 1; min-width: 0; gap: 2px; font-size: 13px; }
.text small { color: var(--text-muted); overflow-wrap: anywhere; }
.log { margin: 0; padding: 6px 14px 10px; list-style: none; display: grid; gap: 6px; font-size: 12px; }
.log li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: baseline; }
.log time { font: 11px var(--font-code); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.log span { min-width: 0; overflow-wrap: anywhere; }
.log em { font-style: normal; font-size: 11px; }
.log em.ok { color: var(--success); } .log em.denied { color: var(--warning); } .log em.failed { color: var(--danger); }
.empty { margin: 0; padding: 14px; color: var(--text-muted); font-size: 13px; }
.ghost { height: 30px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text-primary); font: 12px var(--font-ui); cursor: pointer; white-space: nowrap; }
.link { border: 0; background: transparent; color: var(--workflow-accent); cursor: pointer; font-size: 12px; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.footnote { margin: 0; color: var(--text-muted); font: 11px var(--font-code); }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
</style>
