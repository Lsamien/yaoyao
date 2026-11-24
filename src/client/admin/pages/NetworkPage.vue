<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'
import { fetchServerIdentity, saveServerIdentity } from '@/api/serverIdentity'
import { overview, type ConsoleOverview } from '../api'

const name = ref(''), baseline = ref(''), revision = ref(0), serverId = ref('')
const busy = ref(false), error = ref(''), notice = ref('')
const status = ref<ConsoleOverview>()
const dirty = computed(() => name.value.trim() !== baseline.value)

function accept(value: { name: string; revision: number; serverId: string }) {
  name.value = baseline.value = value.name
  revision.value = value.revision
  serverId.value = value.serverId
}
async function save() {
  busy.value = true; error.value = ''; notice.value = ''
  try { accept(await saveServerIdentity(name.value.trim(), revision.value, serverId.value)); notice.value = '服务器名称已保存，Web、手机和电脑客户端会同步显示。' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { busy.value = false }
}
onMounted(async () => {
  try { accept(await fetchServerIdentity()) } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
  try { status.value = await overview() } catch { /* Access summary is informational. */ }
})
</script>

<template>
  <div class="stack">
    <section>
      <h2>服务器名称</h2>
      <form class="row" @submit.prevent="save">
        <label for="server-name" class="sr-only">服务器名称</label>
        <input id="server-name" v-model="name" maxlength="40" :disabled="busy" />
        <button class="solid" :disabled="busy || !dirty || !name.trim()">保存</button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
    </section>
    <section v-if="status">
      <h2>访问方式</h2>
      <dl class="facts">
        <div><dt>夭夭 Web</dt><dd><code>{{ status.web.host }}:{{ status.web.port }}</code></dd></div>
        <div><dt>管理后台</dt><dd><code>{{ status.console.host }}:{{ status.console.port }}</code> · {{ status.console.external ? '允许远程访问（已启用白名单与二次验证）' : '仅本机' }}</dd></div>
      </dl>
      <p class="hint">管理后台的监听地址、端口和访问白名单由服务器环境变量 <code>YAOYAO_ADMIN_HOST</code>、<code>YAOYAO_ADMIN_PORT</code>、<code>YAOYAO_ADMIN_ALLOW_IPS</code> 决定，修改后需重启服务。从其他电脑管理时，推荐使用 SSH 隧道：<code>ssh -L {{ status.console.port }}:127.0.0.1:{{ status.console.port }} 服务器</code>。</p>
    </section>
    <SystemManagementPanel section="connection" :active="true" :hide-computers="true" />
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 28px; }
section { display: grid; gap: 10px; }
h2 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-size: 15px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
input { flex: 1; min-width: 200px; max-width: 360px; height: 38px; padding: 0 12px; border: 1px solid var(--input-border-color); border-radius: 9px; background: var(--surface); color: var(--text-primary); font: 14px var(--font-ui); }
.solid { height: 38px; padding: 0 16px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); cursor: pointer; }
.solid:disabled { opacity: .5; }
.facts { margin: 0; display: grid; gap: 8px; }
.facts div { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
dt { width: 90px; color: var(--text-muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
code { font: 12px var(--font-code); }
.hint { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.notice { margin: 0; color: var(--success); font-size: 13px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
