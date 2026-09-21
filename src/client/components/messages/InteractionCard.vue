<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiInteraction } from './types'

const props = defineProps<{ interaction: UiInteraction; busy?: boolean }>()
const emit = defineEmits<{ approve: [approved: boolean]; clarify: [text: string] }>()
const selectedOption = ref('')
const customAnswer = ref('')
const answer = computed(() => customAnswer.value.trim() || selectedOption.value)

function selectOption(option: string): void {
  selectedOption.value = option
  customAnswer.value = ''
}

function submit(): void {
  if (!answer.value || props.busy) return
  emit('clarify', answer.value)
}

watch(() => props.interaction.id, () => {
  selectedOption.value = ''
  customAnswer.value = ''
})
</script>

<template>
  <section class="interaction-card" :class="`interaction-card--${interaction.kind}`" aria-live="polite" :aria-labelledby="`interaction-title-${interaction.id}`">
    <span class="interaction-card__handle" aria-hidden="true" />
    <div class="interaction-card__heading">
      <span class="interaction-card__icon"><AppIcon :name="interaction.kind === 'approval' ? 'check' : 'chat'" :size="18" /></span>
      <div>
        <small>{{ interaction.kind === 'approval' ? '需要审批' : '需要你的回答' }}</small>
        <strong :id="`interaction-title-${interaction.id}`">{{ interaction.title || interaction.prompt }}</strong>
      </div>
    </div>
    <p v-if="interaction.title" class="interaction-card__prompt">{{ interaction.prompt }}</p>
    <details v-if="interaction.detail" class="interaction-card__details"><summary>查看详情<AppIcon name="chevron-down" :size="13" /></summary><pre>{{ interaction.detail }}</pre></details>
    <div v-if="interaction.kind === 'approval'" class="interaction-card__actions">
      <button class="quiet-button" type="button" :disabled="busy" @click="emit('approve', false)">拒绝</button>
      <button class="solid-button" type="button" :disabled="busy" @click="emit('approve', true)">允许</button>
    </div>
    <form v-else class="interaction-card__answer" @submit.prevent="submit">
      <fieldset v-if="interaction.options?.length" class="interaction-card__options">
        <legend>请选择一个回答</legend>
        <label v-for="option in interaction.options" :key="option" :class="{ selected: selectedOption === option }">
          <input v-model="selectedOption" type="radio" :value="option" :disabled="busy" @change="selectOption(option)" />
          <span>{{ option }}</span>
          <AppIcon v-if="selectedOption === option" name="check" :size="15" />
        </label>
      </fieldset>
      <div class="interaction-card__custom">
        <label :for="`interaction-answer-${interaction.id}`">其他回答</label>
        <div class="interaction-card__custom-row">
          <textarea :id="`interaction-answer-${interaction.id}`" v-model="customAnswer" rows="2" :disabled="busy" placeholder="补充你的想法（可选）" @input="selectedOption = ''" />
          <button class="solid-button" type="submit" :disabled="busy || !answer">
            {{ busy ? '提交中…' : '提交回答' }}<AppIcon v-if="!busy" name="arrow-up" :size="14" />
          </button>
        </div>
      </div>
      <small class="interaction-card__hint">选择预设答案，或输入你自己的回答</small>
    </form>
  </section>
</template>

<style scoped>
.interaction-card {
  position: relative;
  width: min(640px, 100%);
  margin: 20px auto 4px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface-raised);
  box-shadow: 0 10px 34px color-mix(in srgb, var(--text-primary) 8%, transparent);
  box-sizing: border-box;
}
.interaction-card__handle { display: none; }
.interaction-card__heading { display: flex; align-items: flex-start; gap: 12px; }
.interaction-card__icon { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; border-radius: 11px; background: color-mix(in srgb, var(--workflow-accent) 10%, var(--surface-soft)); color: var(--workflow-accent); }
.interaction-card__heading > div { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.interaction-card__heading small { color: var(--text-muted); font-size: 10px; font-weight: 650; letter-spacing: .06em; }
.interaction-card__heading strong { color: var(--text-primary); font-size: 15px; font-weight: 650; line-height: 1.5; }
.interaction-card__prompt { margin: 10px 0 0 50px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.interaction-card__details { margin: 10px 0 0 50px; color: var(--text-muted); font-size: 11px; }
.interaction-card__details summary { display: inline-flex; min-height: 32px; align-items: center; gap: 5px; cursor: pointer; list-style: none; }
.interaction-card__details summary::-webkit-details-marker { display: none; }
.interaction-card__details[open] summary .app-icon { transform: rotate(180deg); }
.interaction-card__details pre { max-height: 180px; overflow: auto; font: 10px/1.55 var(--font-code); white-space: pre-wrap; }
.interaction-card__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.interaction-card button { min-height: 44px; padding: 9px 15px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--text-primary); cursor: pointer; font: 13px var(--font-ui); }
.interaction-card button:hover:not(:disabled) { background: var(--surface-hover); }
.interaction-card button:disabled { cursor: default; opacity: .5; }
.interaction-card .solid-button { display: inline-flex; min-width: 112px; align-items: center; justify-content: center; gap: 7px; border-color: var(--workflow-accent); background: var(--workflow-accent); color: var(--workflow-on-accent); font-weight: 620; }
.interaction-card .solid-button:hover:not(:disabled) { background: color-mix(in srgb, var(--workflow-accent) 88%, var(--text-primary)); }
.interaction-card__answer { display: grid; gap: 10px; margin-top: 13px; }
.interaction-card__options { display: grid; min-width: 0; gap: 9px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; padding: 0; border: 0; }
.interaction-card__options legend { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.interaction-card__options label { display: grid; min-width: 0; min-height: 54px; align-items: center; gap: 9px; grid-template-columns: 18px minmax(0, 1fr) 16px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); box-sizing: border-box; color: var(--text-secondary); cursor: pointer; transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }
.interaction-card__options label:hover { border-color: var(--line-strong); background: var(--surface-hover); }
.interaction-card__options label.selected { border-color: var(--workflow-accent); background: color-mix(in srgb, var(--workflow-accent) 6%, var(--surface)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--workflow-accent) 10%, transparent); color: var(--text-primary); }
.interaction-card__options input { width: 17px; height: 17px; margin: 0; accent-color: var(--workflow-accent); cursor: pointer; }
.interaction-card__options span { min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 560; line-height: 1.45; }
.interaction-card__options .app-icon { color: var(--workflow-accent); }
.interaction-card__custom { display: grid; gap: 6px; }
.interaction-card__custom > label { color: var(--text-secondary); font-size: 11px; font-weight: 560; }
.interaction-card__custom-row { display: flex; align-items: stretch; gap: 8px; }
.interaction-card__custom textarea { width: 100%; min-height: 58px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 11px; outline: 0; background: var(--surface-soft); box-sizing: border-box; color: var(--text-primary); font: 13px/1.55 var(--font-ui); resize: vertical; }
.interaction-card__custom textarea::placeholder { color: var(--input-placeholder-color); }
.interaction-card__custom textarea:focus { border-color: var(--workflow-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--workflow-accent) 14%, transparent); }
.interaction-card__hint { margin-top: -2px; color: var(--text-muted); font-size: 10px; line-height: 1.4; }
.interaction-card :is(button,input,textarea,summary):focus-visible { outline: 2px solid var(--workflow-accent); outline-offset: 2px; }

@media (max-width: 768px) {
  .interaction-card { position: sticky; z-index: 5; bottom: 8px; width: 100%; margin: 22px auto 0; padding: 24px 14px max(16px, env(safe-area-inset-bottom)); border-radius: 22px 22px 15px 15px; box-shadow: 0 -10px 34px color-mix(in srgb, var(--text-primary) 14%, transparent); }
  .interaction-card__handle { display: block; position: absolute; top: 8px; left: 50%; width: 38px; height: 4px; border-radius: 999px; background: var(--line-strong); transform: translateX(-50%); }
  .interaction-card__heading { gap: 10px; }
  .interaction-card__icon { width: 36px; height: 36px; flex-basis: 36px; }
  .interaction-card__heading strong { font-size: 15px; }
  .interaction-card__prompt,.interaction-card__details { margin-left: 46px; }
  .interaction-card__answer { gap: 11px; margin-top: 14px; }
  .interaction-card__options { grid-template-columns: 1fr; }
  .interaction-card__options label { min-height: 52px; padding-block: 10px; }
  .interaction-card__custom-row { align-items: stretch; flex-direction: column; gap: 10px; }
  .interaction-card__custom textarea { min-height: 58px; }
  .interaction-card__hint { display: none; }
  .interaction-card .solid-button { width: 100%; min-height: 50px; }
  .interaction-card__actions > button { min-height: 48px; flex: 1; }
}

@media (prefers-reduced-motion: reduce) { .interaction-card__options label { transition: none; } }
</style>
