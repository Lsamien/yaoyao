<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { saveServerIdentity } from '@/api/serverIdentity'

const auth = useAuthStore()
const serverId = ref('')
const name = ref(''), revision = ref(0), baseline = ref(''), busy = ref(false), error = ref(''), notice = ref('')
const editable = computed(() => auth.user?.role === 'admin')
const dirty = computed(() => name.value !== baseline.value)
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()
watch(dirty, value => emit('dirty-change', value))
function hydrate() {
  if (!auth.serverIdentity) return
  name.value = baseline.value = auth.serverIdentity.name
  revision.value = auth.serverIdentity.revision
  serverId.value = auth.serverIdentity.serverId
}
watch(() => auth.serverIdentity, () => { if (!dirty.value) hydrate() }, { immediate: true })
async function reload() { await auth.refreshServerIdentity(); hydrate(); error.value = '' }
async function save() {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const value = await saveServerIdentity(name.value, revision.value, serverId.value)
    auth.acceptServerIdentity(value); hydrate(); notice.value = '服务器名称已保存，三端同步显示。'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { busy.value = false }
}
void auth.refreshServerIdentity()
</script>

<template>
  <section v-if="auth.serverIdentity" class="server-identity" aria-label="服务器名称">
    <h3>服务器名称</h3>
    <form v-if="editable" @submit.prevent="save">
      <label>统一显示名称<input v-model="name" name="server-display-name" maxlength="100" placeholder="例如：家里的 Mac" :disabled="busy" /></label>
      <p>该服务器上的机器人共用此名称，Web、iOS 和安卓同步。留空恢复服务器主机名。</p>
      <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <button type="submit" :disabled="busy || !dirty">{{ busy ? '保存中…' : '保存服务器名称' }}</button>
      <button v-if="error" type="button" :disabled="busy" @click="reload">重新载入</button>
    </form>
    <template v-else><strong>{{ auth.serverIdentity.displayName }}</strong><p>由服务器管理员设置，三端同步显示。</p></template>
  </section>
</template>

<style scoped>
.server-identity{padding:16px 0;border-top:1px solid var(--line)}h3{margin:0 0 12px;font-size:15px}label{display:grid;gap:8px;font-size:13px}input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text)}p{font-size:12px;line-height:1.6;color:var(--text-secondary)}button{min-height:36px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer}button:disabled{opacity:.5;cursor:default}[role=alert]{color:var(--danger,#dc2626)}
</style>
