<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { audit, auditCsvUrl, type AuditEntry, type AuditFilter } from '../api'

const entries = ref<AuditEntry[]>([])
const modules = ref<string[]>([])
const module = ref('')
const outcome = ref('')
const days = ref('7')
const loading = ref(false)
const error = ref('')
const more = ref(false)
const PAGE = 100

function filter(before?: number): AuditFilter {
  return { module: module.value || undefined, outcome: outcome.value || undefined, since: days.value ? Date.now() - Number(days.value) * 86_400_000 : undefined, before }
}
async function load(append = false) {
  loading.value = true; error.value = ''
  try {
    const before = append ? entries.value.at(-1)?.id : undefined
    const result = await audit(filter(before), PAGE)
    entries.value = append ? [...entries.value, ...result.entries] : result.entries
    modules.value = result.modules
    more.value = result.entries.length === PAGE
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
  finally { loading.value = false }
}
watch([module, outcome, days], () => { void load() })
onMounted(() => { void load() })
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const outcomeLabel: Record<string, string> = { ok: '成功', denied: '拒绝', failed: '失败' }
</script>

<template>
  <div class="audit">
    <div class="filters">
      <label for="audit-module">模块<select id="audit-module" v-model="module"><option value="">全部模块</option><option v-for="item in modules" :key="item" :value="item">{{ item }}</option></select></label>
      <label for="audit-outcome">结果<select id="audit-outcome" v-model="outcome"><option value="">全部</option><option value="ok">成功</option><option value="denied">拒绝</option><option value="failed">失败</option></select></label>
      <label for="audit-days">时间<select id="audit-days" v-model="days"><option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="">全部（保留 180 天）</option></select></label>
      <a class="ghost" :href="auditCsvUrl(filter())">导出 CSV</a>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>时间</th><th>账号</th><th>来源</th><th>模块</th><th>操作</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="entry in entries" :key="entry.id">
            <td class="mono">{{ time(entry.at) }}</td>
            <td>{{ entry.actor }}</td>
            <td class="mono">{{ entry.ip }}</td>
            <td>{{ entry.module }}</td>
            <td><span class="mono action">{{ entry.action }}</span><small v-if="entry.detail">{{ entry.detail }}</small></td>
            <td><span class="badge" :class="entry.outcome">{{ outcomeLabel[entry.outcome] }} {{ entry.status }}</span></td>
          </tr>
          <tr v-if="!entries.length && !loading"><td colspan="6" class="empty">没有符合条件的记录。</td></tr>
        </tbody>
      </table>
    </div>
    <button v-if="more" class="ghost" type="button" :disabled="loading" @click="load(true)">加载更多</button>
  </div>
</template>

<style scoped>
.audit { display: grid; gap: 14px; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
label { display: grid; gap: 4px; font-size: 12px; color: var(--text-muted); }
select { height: 34px; padding: 0 10px; border: 1px solid var(--input-border-color); border-radius: 8px; background: var(--surface); color: var(--text-primary); font: 13px var(--font-ui); }
.ghost { display: inline-flex; align-items: center; height: 34px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text-primary); font: 13px var(--font-ui); text-decoration: none; cursor: pointer; justify-self: start; }
.table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { padding: 9px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--text-muted); font-weight: 600; background: var(--surface-soft); }
tr:last-child td { border-bottom: 0; }
.mono { font-family: var(--font-code); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.action { display: block; white-space: normal; overflow-wrap: anywhere; }
td small { display: block; margin-top: 3px; color: var(--text-muted); overflow-wrap: anywhere; }
.badge { font-size: 11px; white-space: nowrap; }
.badge.ok { color: var(--success); } .badge.denied { color: var(--warning); } .badge.failed { color: var(--danger); }
.empty { color: var(--text-muted); text-align: center; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
</style>
