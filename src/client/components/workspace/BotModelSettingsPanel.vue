<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceAgent } from '@shared/workspace'
import { botFastLabels, botReasoningLabels, inheritedBotModelSettings, type BotModelOptions, type BotModelSettings } from '@shared/botModelSettings'
const props = defineProps<{ agent: WorkspaceAgent }>()
const emit = defineEmits<{ saved: []; dirtyChange: [dirty: boolean]; busyChange: [busy: boolean] }>()
const options = ref<BotModelOptions>(), draft = ref(inheritedBotModelSettings()), baseline = ref('')
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), changedElsewhere = ref(false)
let generation = 0
const dirty = computed(() => !!baseline.value && JSON.stringify(draft.value) !== baseline.value)
watch(dirty, value => emit('dirtyChange', value), { immediate: true })
watch(saving, value => emit('busyChange', value), { flush: 'sync' })
const key = (provider: string, model: string) => JSON.stringify([provider, model])
const modelKey = computed({ get: () => draft.value.model && draft.value.provider ? key(draft.value.provider, draft.value.model) : '', set: (value: string) => {
  const pair = value ? JSON.parse(value) as [string, string] : [null, null]
  draft.value = { ...draft.value, provider: pair[0]!, model: pair[1]! }
} })
const selected = computed(() => options.value?.models.find(item => item.provider === (draft.value.provider ?? options.value?.defaults.provider) && item.model === (draft.value.model ?? options.value?.defaults.model)))
const invalid = computed(() => draft.value.model && !selected.value ? '所选模型已不可用，请重新选择或继承基础机器人。'
  : draft.value.reasoningEffort && !selected.value?.reasoningEfforts.includes(draft.value.reasoningEffort) ? '该模型不支持所选思考等级，请重新选择或继承。'
  : draft.value.fastMode && !selected.value?.fastModes.includes(draft.value.fastMode) ? '该模型不支持所选速度，请重新选择或继承。' : '')
async function load() {
  const current = ++generation
  loading.value = true; options.value = undefined; error.value = ''; notice.value = ''
  try {
    const value = await apiRequest<BotModelOptions>(`/api/app/agents/${props.agent.id}/model-options`)
    if (current !== generation) return
    if (value.version !== 1) throw new Error('请升级模型工具桥后重试。')
    options.value = value; draft.value = { ...inheritedBotModelSettings(), ...value.settings }
    baseline.value = JSON.stringify(draft.value); changedElsewhere.value = false
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : '模型设置加载失败' }
  finally { if (current === generation) loading.value = false }
}
async function save() {
  if (!options.value || invalid.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  const settings: BotModelSettings = { ...draft.value }
  const body = { modelSettings: { ...settings }, expectedRevision: options.value.revision }
  type Result = { agent?: WorkspaceAgent; confirmationRequired?: boolean; confirmationMessage?: string; confirmationTarget?: string }
  try {
    let result = await apiRequest<Result>(`/api/app/agents/${props.agent.id}`, { method: 'PATCH', body })
    if (result.confirmationRequired) {
      if (!window.confirm(result.confirmationMessage || '确认使用此模型？')) return
      if (!result.confirmationTarget) throw new Error('模型确认响应无效，请重新加载。')
      result = await apiRequest<Result>(`/api/app/agents/${props.agent.id}`, { method: 'PATCH', body: { ...body, confirmedModel: result.confirmationTarget } })
    }
    if (!result.agent) throw new Error('模型设置尚未保存，请重新加载后重试。')
    options.value.revision = result.agent.revision; options.value.settings = result.agent.modelSettings ?? null
    baseline.value = JSON.stringify(settings); changedElsewhere.value = false
    notice.value = '已保存，从下一轮开始使用。'; emit('saved')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '模型设置保存失败' }
  finally { saving.value = false }
}
watch(() => [props.agent.revision, saving.value] as const, ([revision]) => {
  if (!options.value || saving.value || revision <= options.value.revision) return
  if (dirty.value) changedElsewhere.value = true
  else void load()
})
onMounted(load)
function reload() { if (!dirty.value || window.confirm('放弃未保存的模型设置并重新加载？')) void load() }
onBeforeUnmount(() => { generation++; emit('dirtyChange', false); emit('busyChange', false) })
</script>
<template>
  <section class="bot-model-settings" aria-label="Bot 模型设置">
    <p>保存后，该 Bot 在所有会话和群聊中从下一轮开始使用。</p>
    <p v-if="loading" role="status">正在读取模型设置…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="changedElsewhere" role="status">其他端已更新资料。当前草稿已保留，请重新加载后保存。</p>
    <form v-if="options" @submit.prevent="save">
      <fieldset :disabled="loading || saving">
        <label>模型与 Provider<select v-model="modelKey" aria-label="Bot 模型">
          <option value="">继承基础机器人 · {{ options.defaults.provider }} / {{ options.defaults.model }}</option>
          <option v-if="modelKey && !selected" :value="modelKey">{{ draft.provider }} / {{ draft.model }}（不可用）</option>
          <option v-for="item in options.models" :key="key(item.provider,item.model)" :value="key(item.provider,item.model)">{{ item.provider }} / {{ item.name }}</option>
        </select></label>
        <label>思考等级<select v-model="draft.reasoningEffort" aria-label="Bot 思考等级">
          <option :value="null">继承基础机器人 · {{ botReasoningLabels[options.defaults.reasoningEffort] || options.defaults.reasoningEffort }}</option>
          <option v-if="draft.reasoningEffort && !selected?.reasoningEfforts.includes(draft.reasoningEffort)" :value="draft.reasoningEffort">{{ draft.reasoningEffort }}（不可用）</option>
          <option v-for="effort in selected?.reasoningEfforts || []" :key="effort" :value="effort">{{ botReasoningLabels[effort] || effort }}</option>
        </select></label>
        <small v-if="selected && !selected.reasoningKnown">该模型未声明完整思考能力，等级是否有效由模型服务决定。</small>
        <label>速度<select v-model="draft.fastMode" aria-label="Bot 速度">
          <option :value="null">继承基础机器人 · {{ botFastLabels[options.defaults.fastMode] }}</option>
          <option v-if="draft.fastMode && !selected?.fastModes.includes(draft.fastMode)" :value="draft.fastMode">{{ botFastLabels[draft.fastMode] }}（不可用）</option>
          <option v-for="speed in selected?.fastModes || ['normal']" :key="speed" :value="speed">{{ botFastLabels[speed] }}</option>
        </select></label>
        <small>快速模式可能产生额外费用；每轮开始加速和首次回复加速使用 Hermes 配置的加速时长。</small>
        <p v-if="invalid" class="error" role="alert">{{ invalid }}</p>
        <button type="submit" :disabled="!!invalid || changedElsewhere">{{ saving ? '正在保存…' : '保存模型设置' }}</button>
      </fieldset>
    </form>
    <button type="button" :disabled="loading || saving" @click="reload">{{ options ? '重新加载' : '重试' }}</button>
  </section>
</template>
<style scoped>
.bot-model-settings{display:grid;gap:14px;max-width:650px}p{margin:0;color:var(--text-secondary);line-height:1.6;font-size:14px}fieldset{border:0;margin:0;padding:0;display:grid;gap:16px}label{display:grid;gap:8px;font-weight:550;font-size:14px}select{min-height:44px;max-width:100%;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;color:var(--text-primary);background:var(--surface)}small{color:var(--text-secondary);line-height:1.6}.error{color:var(--danger,#c33)}button{min-height:44px;padding:10px 16px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);cursor:pointer;justify-self:start}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
