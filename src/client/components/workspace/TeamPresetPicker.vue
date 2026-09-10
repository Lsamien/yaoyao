<script setup lang="ts">
import { TEAM_PRESETS, type TeamPreset } from '@/components/groups/teamPresets'
const props = defineProps<{ selected: string; available: number }>()
const emit = defineEmits<{ select: [preset?: TeamPreset] }>()
const shortage = (preset: TeamPreset) => Math.max(0, preset.roles.length - props.available)
</script>
<template>
  <section class="preset-picker" aria-label="团队预设">
    <div class="preset-picker__heading"><span>团队预设</span><small>选择后分配已创建的机器人</small></div>
    <div class="preset-grid">
      <button type="button" :class="{ selected: selected === 'custom' }" @click="emit('select')"><strong>自定义团队</strong><small>手动选择机器人和协作配置</small><em>自由配置</em></button>
      <button v-for="preset in TEAM_PRESETS" :key="preset.id" type="button" :class="{ selected: selected === preset.id }" :disabled="shortage(preset) > 0" :aria-label="preset.name" @click="emit('select', preset)">
        <strong>{{ preset.name }}</strong><small>{{ preset.summary }}</small><em>{{ shortage(preset) ? `还缺 ${shortage(preset)} 人` : `${preset.roles.length} 人` }}</em>
      </button>
    </div>
    <small v-if="available < 5" class="preset-help">成员不足时，请先创建所需的机器人。</small>
  </section>
</template>
<style scoped>
.preset-picker { margin-bottom: 15px; }.preset-picker__heading, .role-mapping__heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 7px; color: var(--text-secondary); font-size: 10px; }.preset-picker__heading small, .role-mapping__heading small { color: var(--text-muted); font-size: 9px; }.preset-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }.preset-grid button { position: relative; display: grid; min-height: 82px; align-content: start; gap: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); color: var(--text-primary); cursor: pointer; text-align: left; }.preset-grid button:hover { border-color: var(--line-strong); background: var(--surface-hover); }.preset-grid button.selected { border-color: color-mix(in srgb, var(--accent) 58%, var(--line)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 13%, transparent); }.preset-grid button:disabled { cursor: not-allowed; opacity: .48; }.preset-grid strong { padding-right: 42px; font-size: 10px; }.preset-grid small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }.preset-grid em { position: absolute; top: 9px; right: 9px; color: var(--accent); font-size: 8px; font-style: normal; }

.preset-help{display:block;margin-top:8px;color:var(--text-muted);font-size:11px}
@media(max-width:620px){.preset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:420px){.preset-grid{grid-template-columns:1fr}}
</style>
