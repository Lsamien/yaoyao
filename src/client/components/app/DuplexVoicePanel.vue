<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { getDuplexVoiceSettings, saveDuplexVoiceSettings, type DuplexVoice } from '@/api/agentManagement'

const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const hasApiKey = ref(false)
const apiKey = ref('')
const voices = ref<DuplexVoice[]>([])
const currentVoiceId = ref('')
const baseline = ref('')

function snapshot(): string {
  return JSON.stringify({ voices: voices.value, currentVoiceId: currentVoiceId.value })
}

const dirty = computed(() => Boolean(apiKey.value.trim()) || (baseline.value !== '' && snapshot() !== baseline.value))
watch(dirty, value => emit('dirty-change', value), { immediate: true })

async function load() {
  loading.value = true; error.value = ''
  try {
    const settings = await getDuplexVoiceSettings()
    hasApiKey.value = settings.hasApiKey
    voices.value = settings.voices.map(voice => ({ ...voice }))
    currentVoiceId.value = settings.currentVoiceId
    apiKey.value = ''
    baseline.value = snapshot()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '双流语音设置加载失败'
  } finally {
    if (!baseline.value) baseline.value = snapshot()
    loading.value = false
  }
}

function addVoice() {
  let suffix = voices.value.length + 1
  while (voices.value.some(voice => voice.id === `voice-${suffix}`)) suffix += 1
  voices.value.push({ id: `voice-${suffix}`, name: `新音色 ${suffix}` })
  if (!currentVoiceId.value) currentVoiceId.value = voices.value[0]!.id
}

function removeVoice(index: number) {
  if (voices.value.length <= 1) { error.value = '至少保留一个音色'; return }
  const [removed] = voices.value.splice(index, 1)
  if (removed?.id === currentVoiceId.value) currentVoiceId.value = voices.value[0]!.id
}

function validate(): string {
  if (!voices.value.length) return '至少保留一个音色'
  const ids = new Set<string>()
  for (const voice of voices.value) {
    voice.id = voice.id.trim(); voice.name = voice.name.trim()
    if (!voice.id || !voice.name) return '音色 ID 和名称不能为空'
    if (voice.id.length > 200 || voice.name.length > 200) return '音色 ID 和名称不能超过 200 个字符'
    if (ids.has(voice.id)) return `音色 ID 重复：${voice.id}`
    ids.add(voice.id)
  }
  if (!ids.has(currentVoiceId.value)) currentVoiceId.value = voices.value[0]!.id
  return ''
}

async function save() {
  const validationError = validate()
  if (validationError) { error.value = validationError; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await saveDuplexVoiceSettings({
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
      voices: voices.value,
      currentVoiceId: currentVoiceId.value,
    })
    hasApiKey.value = result.hasApiKey
    voices.value = result.voices.map(voice => ({ ...voice }))
    currentVoiceId.value = result.currentVoiceId
    apiKey.value = ''
    baseline.value = snapshot()
    notice.value = '双流语音设置已保存，iOS 可直接同步使用'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '双流语音设置保存失败'
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="voice-panel" aria-label="双流语音">
    <div class="voice-heading"><div><h3>yaoyao 双流语音</h3><p>这是整个 yaoyao 安装共享的全局设置，不随当前 Agent 切换。</p></div><span>全局</span></div>
    <p v-if="error" class="voice-error" role="alert">{{ error }}</p><p v-else-if="notice" class="voice-notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="voice-empty">正在读取语音设置…</p>
    <form v-else :aria-busy="busy" @submit.prevent="save">
      <label>API Key<input v-model="apiKey" type="password" :disabled="busy" :placeholder="hasApiKey ? '已保存；留空保持不变' : '输入双流语音 API Key'" autocomplete="new-password" /></label>
      <div class="voice-list-heading"><strong>音色列表</strong><button type="button" :disabled="busy || voices.length >= 100" @click="addVoice"><AppIcon name="plus" :size="13" />增加音色</button></div>
      <div class="voice-list">
        <div v-for="(voice, index) in voices" :key="index" class="voice-row">
          <label>音色 ID<input v-model="voice.id" :disabled="busy" maxlength="200" autocomplete="off" /></label><label>显示名称<input v-model="voice.name" :disabled="busy" maxlength="200" autocomplete="off" /></label><button class="remove-button" type="button" aria-label="删除音色" :disabled="busy || voices.length <= 1" @click="removeVoice(index)"><AppIcon name="trash" :size="14" /></button>
        </div>
      </div>
      <label>当前音色<select v-model="currentVoiceId" :disabled="busy"><option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.name || voice.id }}</option></select></label>
      <footer><button class="primary-button" type="submit" :disabled="busy || !voices.length">{{ busy ? '正在保存…' : '保存双流语音设置' }}</button></footer>
    </form>
  </section>
</template>

<style scoped>
.voice-panel{display:grid;gap:18px}.voice-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.voice-heading h3{margin:0;font-size:16px}.voice-heading p{margin:6px 0 0;color:var(--text-muted);font-size:13px;line-height:1.55}.voice-heading>span{padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--text-muted);font-size:11px}.voice-error,.voice-notice,.voice-empty{margin:0;padding:11px 12px;border-radius:9px;font-size:13px}.voice-error{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}.voice-notice{background:color-mix(in srgb,var(--success,#21845b) 9%,transparent);color:var(--success,#21845b)}.voice-empty{color:var(--text-muted);background:var(--surface-soft)}form{display:grid;gap:18px}label{display:grid;gap:7px;color:var(--text-secondary);font-size:13px;font-weight:650}input,select{width:100%;height:42px;box-sizing:border-box;padding:0 11px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:13px var(--font-ui)}input:focus,select:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}.voice-list-heading{display:flex;align-items:center;justify-content:space-between}.voice-list-heading strong{font-size:14px}.voice-list-heading button,.primary-button{display:inline-flex;min-height:40px;align-items:center;justify-content:center;gap:7px;padding:0 13px;border:0;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}.voice-list-heading button{border:1px solid var(--line);background:var(--surface-raised);color:var(--text-secondary)}.primary-button{min-width:150px;background:var(--accent);color:var(--text-on-solid)}button:disabled{cursor:wait;opacity:.5}.voice-list{display:grid;gap:10px}.voice-row{display:grid;grid-template-columns:1fr 1fr 40px;align-items:end;gap:10px}.remove-button{display:grid;width:40px;height:42px;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--danger);cursor:pointer}.remove-button:hover{background:color-mix(in srgb,var(--danger) 7%,transparent)}footer{display:flex;justify-content:flex-end;padding-top:16px;border-top:1px solid var(--line)}@media(max-width:600px){.voice-row{grid-template-columns:1fr 40px}.voice-row label:first-child{grid-column:1/-1}.voice-row label:nth-child(2){grid-column:1}.remove-button{grid-column:2}.primary-button{width:100%}}
</style>
