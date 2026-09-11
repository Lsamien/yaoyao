<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest, apiUrl } from '@/api/client'

const props = defineProps<{ profile?: string }>()
const emit = defineEmits<{ 'dirty-change': [value: boolean] }>()
const all = ref(false), folders = ref(''), cwd = ref(''), cwdError = ref('')
const loading = ref(false), saving = ref(false), error = ref(''), saved = ref(false)
let generation = 0
async function load() {
  const current = ++generation
  loading.value = true; error.value = ''; cwd.value = ''; cwdError.value = ''
  try {
    const value = await apiRequest<{ mode: 'all' | 'folders'; folders: string[]; workingDirectory?: string; cwdError?: string }>(
      apiUrl('/api/app/settings/file-access', { profile: props.profile || 'default' }))
    if (current !== generation) return
    all.value = value.mode === 'all'; folders.value = value.folders.join('\n')
    cwd.value = value.workingDirectory || ''; cwdError.value = value.cwdError || ''
    emit('dirty-change', false)
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : '无法读取文件访问设置' }
  finally { if (current === generation) loading.value = false }
}
function changed() { saved.value = false; emit('dirty-change', true) }
async function save() {
  saving.value = true; error.value = ''; saved.value = false
  try {
    await apiRequest('/api/app/settings/file-access', { method: 'PUT', body: {
      mode: all.value ? 'all' : 'folders', folders: folders.value.split('\n').map(value => value.trim()).filter(Boolean),
    } })
    saved.value = true; emit('dirty-change', false)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { saving.value = false }
}
onMounted(load)
onBeforeUnmount(() => { generation += 1 })
watch(() => props.profile, load)
</script>

<template>
  <section class="file-access" aria-label="文件访问权限">
    <p>控制聊天中服务器文件的预览和下载。设置保存在服务端，Web、桌面版和移动端共用。</p>
    <div class="cwd"><strong>工作目录 · 始终允许</strong><code>{{ cwd || '尚未取得工作目录' }}</code><small>当前 Profile：{{ profile || 'default' }} · 使用服务器配置的 terminal.cwd</small></div>
    <p v-if="cwdError" role="alert" class="error">{{ cwdError }}</p>
    <form @submit.prevent="save" @input="changed">
      <label class="toggle"><input v-model="all" type="checkbox" :disabled="loading || saving" /><span><strong>全局授权：允许所有目录</strong><small>开启后无需逐个添加文件夹。仍遵守 Hermes 所在服务器的文件权限。</small></span></label>
      <label class="folders">额外允许的文件夹<textarea v-model="folders" :disabled="loading || saving || all" rows="5" placeholder="每行一个服务器绝对路径，例如 /tmp" aria-describedby="folder-help" /></label>
      <small id="folder-help">未开启全局授权且列表为空时，只允许工作目录；添加目录后也包含其子目录。</small>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">已保存，后续服务端文件请求立即使用新权限。</p>
      <div class="actions"><button type="button" :disabled="loading || saving" @click="load">重新读取</button><button type="submit" class="save" :disabled="loading || saving">{{ saving ? '保存中…' : loading ? '读取中…' : '保存设置' }}</button></div>
    </form>
  </section>
</template>

<style scoped>
.file-access{display:grid;gap:18px;max-width:680px;color:var(--text-primary);font-size:13px;line-height:1.7}.file-access p{margin:0}.cwd{display:grid;gap:8px;padding:16px;background:var(--surface-soft);border:1px solid var(--line);border-radius:12px}.cwd code{overflow-wrap:anywhere;white-space:pre-wrap}.file-access small{display:block;color:var(--text-secondary);font-size:12px}.file-access form{display:grid;gap:14px}.toggle{display:flex;gap:12px;align-items:center;min-height:56px;cursor:pointer}.toggle input{width:20px;height:20px;accent-color:var(--accent)}.folders{display:grid;gap:8px}.folders textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text-primary);font:inherit;resize:vertical}.actions{display:flex;gap:10px;justify-content:flex-end}.actions button{min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}.actions .save{background:var(--accent);color:var(--text-on-solid)}button:disabled,textarea:disabled{opacity:.55;cursor:default}.error{color:var(--danger)}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
