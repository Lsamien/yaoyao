<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import { processTeamAvatarFile } from '@/utils/teamAvatar'
import type { GroupProfileOption } from './types'
import { TEAM_PRESETS, type TeamPreset } from './teamPresets'

interface CreateGroupMember extends GroupProfileOption {
  description?: string
}

interface CreateGroupPayload {
  name: string
  avatar?: string
  members: CreateGroupMember[]
  autoReply: boolean
  replyRounds: number
  instructions?: string
  hostProfile?: string
  orchestrationMode?: 'free' | 'host'
}

const props = withDefaults(defineProps<{ open: boolean; profiles: GroupProfileOption[]; avatarEnabled?: boolean; hostEnabled?: boolean; hostFlowEnabled?: boolean; roomInstructionsEnabled?: boolean; error?: string; busy?: boolean }>(), {
  avatarEnabled: false,
  hostEnabled: false,
  hostFlowEnabled: false,
  roomInstructionsEnabled: false,
  busy: false,
})
const emit = defineEmits<{ close: []; create: [payload: CreateGroupPayload] }>()

const name = ref('')
const instructions = ref('')
const selected = ref<string[]>([])
const selectedPresetId = ref('custom')
const hostProfile = ref('')
const autoReply = ref(true)
const replyRounds = ref(3)
const orchestrationMode = ref<'free' | 'host'>('free')
const avatarMode = ref<'dynamic' | 'upload'>('dynamic')
const avatarDataURL = ref('')
const avatarError = ref('')
const avatarInput = ref<HTMLInputElement>()
const selectedPreset = computed(() => TEAM_PRESETS.find(preset => preset.id === selectedPresetId.value))
const selectedMembers = computed<CreateGroupMember[]>(() => {
  if (!selectedPreset.value) return selected.value.flatMap(id => props.profiles.find(profile => profile.id === id) ?? [])
  return selectedPreset.value.roles.flatMap((role, index) => {
    const profile = props.profiles.find(item => item.id === selected.value[index])
    return profile ? [{ ...profile, displayName: role.name, description: role.description }] : []
  })
})
const valid = computed(() => name.value.trim().length > 0
  && selected.value.length >= 1
  && selected.value.length <= 8
  && (!selectedPreset.value || selected.value.length === selectedPreset.value.roles.length)
  && (!props.hostEnabled || selected.value.includes(hostProfile.value)))

watch(() => props.open, open => {
  if (!open) return
  name.value = ''
  instructions.value = ''
  selectedPresetId.value = 'custom'
  selected.value = props.profiles.slice(0, 1).map(profile => profile.id)
  hostProfile.value = selected.value[0] ?? ''
  autoReply.value = true
  replyRounds.value = 3
  orchestrationMode.value = 'free'
  avatarMode.value = 'dynamic'
  avatarDataURL.value = ''
  avatarError.value = ''
}, { immediate: true })

function presetShortage(preset: TeamPreset): number {
  return Math.max(0, preset.roles.length - props.profiles.length)
}

function choosePreset(preset?: TeamPreset) {
  if (!preset) {
    selectedPresetId.value = 'custom'
    selected.value = selected.value.slice(0, 8)
    if (!selected.value.length && props.profiles[0]) selected.value = [props.profiles[0].id]
    hostProfile.value = selected.value[0] ?? ''
    orchestrationMode.value = 'free'
    autoReply.value = true
    return
  }
  if (presetShortage(preset)) return
  selectedPresetId.value = preset.id
  name.value = preset.name
  instructions.value = preset.instructions
  selected.value = props.profiles.slice(0, preset.roles.length).map(profile => profile.id)
  const hostIndex = Math.max(0, preset.roles.findIndex(role => role.host))
  hostProfile.value = selected.value[hostIndex] ?? selected.value[0] ?? ''
  orchestrationMode.value = props.hostFlowEnabled ? 'host' : 'free'
  autoReply.value = !props.hostFlowEnabled
  replyRounds.value = 3
}

function assignRole(index: number, profileId: string) {
  const previousProfileId = selected.value[index]
  const occupiedIndex = selected.value.findIndex(id => id === profileId)
  const next = [...selected.value]
  next[index] = profileId
  if (occupiedIndex >= 0 && occupiedIndex !== index && previousProfileId) next[occupiedIndex] = previousProfileId
  selected.value = next
  const hostIndex = selectedPreset.value?.roles.findIndex(role => role.host) ?? -1
  if (hostIndex >= 0) hostProfile.value = next[hostIndex] ?? ''
}

function toggle(profile: GroupProfileOption) {
  if (selected.value.includes(profile.id)) selected.value = selected.value.filter(item => item !== profile.id)
  else if (selected.value.length < 8) selected.value.push(profile.id)
  if (!selected.value.includes(hostProfile.value)) hostProfile.value = selected.value[0] ?? ''
}

async function chooseAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    avatarDataURL.value = await processTeamAvatarFile(file)
    avatarMode.value = 'upload'
    avatarError.value = ''
  } catch (cause) {
    avatarError.value = cause instanceof Error ? cause.message : '处理头像失败'
  } finally {
    if (avatarInput.value) avatarInput.value.value = ''
  }
}

function create() {
  if (!valid.value) return
  const payload: CreateGroupPayload = {
    name: name.value.trim(),
    members: selectedMembers.value,
    autoReply: autoReply.value,
    replyRounds: replyRounds.value,
  }
  if (props.avatarEnabled && avatarMode.value === 'upload') payload.avatar = avatarDataURL.value
  if (props.hostEnabled) payload.hostProfile = hostProfile.value
  if (props.hostFlowEnabled) payload.orchestrationMode = orchestrationMode.value
  if (props.roomInstructionsEnabled) payload.instructions = instructions.value.trim()
  emit('create', payload)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="open" class="dialog-layer" role="presentation" @mousedown.self="emit('close')">
        <section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title">
          <header><div><small>9119 团队</small><h2 id="create-group-title">新建团队</h2></div><button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
          <section class="preset-picker" aria-labelledby="team-preset-label">
            <div class="preset-picker__heading"><span id="team-preset-label">团队预设</span><small>选择后自动分配现有机器人</small></div>
            <div class="preset-grid">
              <button type="button" :class="{ selected: selectedPresetId === 'custom' }" @click="choosePreset()">
                <strong>自定义团队</strong><small>手动选择机器人和协作配置</small><em>自由配置</em>
              </button>
              <button v-for="preset in TEAM_PRESETS" :key="preset.id" type="button" :class="{ selected: selectedPresetId === preset.id }" :disabled="presetShortage(preset) > 0" :aria-label="`${preset.name}，${preset.roles.length} 人${presetShortage(preset) ? `，还缺 ${presetShortage(preset)} 个机器人` : ''}`" @click="choosePreset(preset)">
                <strong>{{ preset.name }}</strong><small>{{ preset.summary }}</small><em>{{ presetShortage(preset) ? `还缺 ${presetShortage(preset)} 人` : `${preset.roles.length} 人` }}</em>
              </button>
            </div>
          </section>
          <label class="field"><span>团队名称</span><input v-model="name" maxlength="80" autofocus placeholder="例如：产品评审" /></label>
          <section v-if="avatarEnabled" class="avatar-picker" aria-labelledby="team-avatar-label">
            <TeamAvatar :name="name || '团队'" :avatar="avatarMode === 'upload' ? avatarDataURL : ''" :members="selectedMembers.map(member => ({ name: member.displayName, avatar: member.avatar }))" :fallback-key="name || 'team'" :size="58" />
            <div><strong id="team-avatar-label">团队头像</strong><small>{{ avatarMode === 'dynamic' ? '由成员的动态角色自动组成' : '使用上传的图片' }}</small><p><button class="quiet-button" :class="{ active: avatarMode === 'dynamic' }" type="button" @click="avatarMode = 'dynamic'">成员组合</button><button class="quiet-button" type="button" @click="avatarInput?.click()"><AppIcon name="image" :size="14" />上传图片</button></p></div>
            <input ref="avatarInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="chooseAvatar" />
          </section>
          <p v-if="avatarError" class="avatar-error" role="alert">{{ avatarError }}</p>
          <label v-if="roomInstructionsEnabled" class="field room-instructions"><span>说明 <small>供所有机器人查阅的规则和形式准则</small></span><textarea v-model="instructions" maxlength="4000" rows="4" placeholder="例如：先确认事实；结论使用中文；涉及发布必须等待确认。" /></label>
          <section v-if="selectedPreset" class="role-mapping" aria-labelledby="role-mapping-label">
            <div class="role-mapping__heading"><span id="role-mapping-label">角色分配</span><small>{{ selectedPreset.roles.length }} 个角色已对应当前机器人</small></div>
            <label v-for="(role, index) in selectedPreset.roles" :key="role.name">
              <span><strong>{{ role.name }}<em v-if="hostEnabled && role.host">管理员</em></strong><small>{{ role.description }}</small></span>
              <select :value="selected[index]" :aria-label="`${role.name}对应的机器人`" @change="assignRole(index, ($event.target as HTMLSelectElement).value)">
                <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.displayName }} · {{ profile.nodeLabel }}</option>
              </select>
            </label>
          </section>
          <div v-else class="agent-picker">
            <div class="agent-picker__heading"><span>选择机器人</span><small>{{ selected.length }}/8</small></div>
            <button v-for="profile in profiles" :key="profile.id" type="button" :class="{ selected: selected.includes(profile.id) }" :disabled="!selected.includes(profile.id) && selected.length >= 8" @click="toggle(profile)">
              <AgentAvatar :name="profile.displayName" :avatar="profile.avatar || ''" :size="28" /><strong>{{ profile.displayName }}<small>{{ profile.profile }} · {{ profile.nodeLabel }}</small></strong><AppIcon v-if="selected.includes(profile.id)" name="check" :size="15" />
            </button>
            <p v-if="!profiles.length">当前没有可用机器人，请先在 Hermes 配置 Profile。</p>
          </div>
          <label v-if="hostEnabled && !selectedPreset" class="host-picker">
            <span>管理员<small>用户没有明确 @ 时，管理员始终负责回应。</small></span>
            <select v-model="hostProfile" aria-label="管理员">
              <option v-for="profileID in selected" :key="profileID" :value="profileID">{{ profiles.find(profile => profile.id === profileID)?.displayName || profileID }}</option>
            </select>
          </label>
          <label v-if="hostFlowEnabled" class="host-picker">
            <span>协作模式<small>管理员可按依赖串行调度，也可一次 @ 多人并列执行；整批结束后统一复核。</small></span>
            <select v-model="orchestrationMode" aria-label="协作模式">
              <option value="free">自由讨论</option>
              <option value="host">管理员协调</option>
            </select>
          </label>
          <div class="dialog-settings">
            <label><input v-model="autoReply" type="checkbox" :aria-label="hostEnabled ? '所有成员无需 @ 也回复' : '启用自动回复'" />{{ hostEnabled ? (orchestrationMode === 'host' ? '自由讨论时无需 @ 也回复' : '所有成员无需 @ 也回复') : '启用自动回复' }}</label>
            <label>最多轮数 <input v-model.number="replyRounds" type="number" min="1" max="12" /></label>
          </div>
          <p v-if="error" class="create-error" role="alert">{{ error }}</p>
          <footer><button class="quiet-button" type="button" @click="emit('close')">取消</button><button class="solid-button" type="button" :disabled="!valid || busy" @click="create">{{ busy ? '创建中…' : '创建团队' }}</button></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-layer { position: fixed; z-index: 200; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(5px); }
.create-dialog { width: min(680px, 100%); max-height: min(780px, calc(100vh - 36px)); padding: 18px; overflow-y: auto; border: 1px solid var(--line); border-radius: 17px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; } header small { color: var(--text-muted); font-size: 9px; letter-spacing: .06em; } h2 { margin: 3px 0 0; font-size: 19px; letter-spacing: -.03em; }
.preset-picker { margin-bottom: 15px; }.preset-picker__heading, .role-mapping__heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 7px; color: var(--text-secondary); font-size: 10px; }.preset-picker__heading small, .role-mapping__heading small { color: var(--text-muted); font-size: 9px; }.preset-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }.preset-grid button { position: relative; display: grid; min-height: 82px; align-content: start; gap: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); color: var(--text-primary); cursor: pointer; text-align: left; }.preset-grid button:hover { border-color: var(--line-strong); background: var(--surface-hover); }.preset-grid button.selected { border-color: color-mix(in srgb, var(--accent) 58%, var(--line)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 13%, transparent); }.preset-grid button:disabled { cursor: not-allowed; opacity: .48; }.preset-grid strong { padding-right: 42px; font-size: 10px; }.preset-grid small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }.preset-grid em { position: absolute; top: 9px; right: 9px; color: var(--accent); font-size: 8px; font-style: normal; }
.field { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 10px; }.field span { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }.field small { color: var(--text-muted); font-size: 9px; font-weight: 400; }.field input, .field textarea { padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; outline: none; resize: vertical; background: var(--surface-soft); color: var(--text-primary); }.field input { height: 38px; }.field textarea { min-height: 86px; padding-block: 9px; line-height: 1.5; }.field input:focus, .field textarea:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.room-instructions { margin-top: 13px; }
.avatar-picker { display: flex; align-items: center; gap: 12px; margin-top: 13px; padding: 11px; border-radius: 11px; background: var(--surface-soft); }.avatar-picker > div { display: grid; min-width: 0; gap: 3px; }.avatar-picker strong { font-size: 10px; }.avatar-picker small { color: var(--text-muted); font-size: 9px; }.avatar-picker p { display: flex; gap: 5px; margin: 3px 0 0; }.avatar-picker .quiet-button { display: inline-flex; min-height: 27px; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid transparent; border-radius: 7px; background: var(--surface-hover); color: var(--text-secondary); cursor: pointer; font-size: 9px; }.avatar-picker .quiet-button.active { border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); color: var(--accent); }.avatar-error { margin: 6px 0 0; color: var(--danger); font-size: 9px; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.agent-picker { margin-top: 17px; }.agent-picker__heading { display: flex; justify-content: space-between; margin-bottom: 7px; color: var(--text-secondary); font-size: 10px; }.agent-picker__heading small { color: var(--text-muted); }.agent-picker > button { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 5px 8px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.agent-picker > button:hover, .agent-picker > button.selected { background: var(--surface-soft); }.agent-picker > button:disabled { opacity: .35; }.agent-picker > button strong { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; font-size: 11px; }.agent-picker > button strong small { overflow: hidden; color: var(--text-muted); font-size: 9px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }.agent-picker p { color: var(--text-muted); font-size: 10px; }
.role-mapping { margin-top: 17px; padding: 11px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); }.role-mapping > label { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 42%); align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }.role-mapping > label:first-of-type { border-top: 0; }.role-mapping > label > span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }.role-mapping strong { display: flex; align-items: center; gap: 6px; font-size: 10px; }.role-mapping strong em { padding: 2px 5px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 8px; font-style: normal; font-weight: 600; }.role-mapping small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }.role-mapping select { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; outline: none; background: var(--surface-raised); color: var(--text-primary); font-size: 9px; }.role-mapping select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.host-picker { display: grid; grid-template-columns: minmax(0, 1fr) 148px; align-items: center; gap: 12px; margin-top: 13px; padding: 11px; border: 1px solid var(--line); border-radius: 10px; color: var(--text-secondary); font-size: 10px; }.host-picker > span { display: flex; min-width: 0; flex-direction: column; gap: 3px; font-weight: 650; }.host-picker small { color: var(--text-muted); font-size: 9px; font-weight: 400; line-height: 1.45; }.host-picker select { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font-size: 10px; }.host-picker select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.dialog-settings { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 15px; padding: 11px; border-radius: 10px; background: var(--surface-soft); }.dialog-settings label { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 10px; }.dialog-settings input[type="checkbox"] { accent-color: var(--accent); }.dialog-settings input[type="number"] { width: 51px; padding: 4px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-raised); color: var(--text-primary); text-align: center; }
.create-error { margin: 12px 0 0; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--danger) 34%, var(--line)); border-radius: 9px; background: color-mix(in srgb, var(--danger) 7%, transparent); color: var(--danger); font-size: 9px; line-height: 1.45; }
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.dialog-fade-enter-active, .dialog-fade-leave-active { transition: opacity 140ms ease; }.dialog-fade-enter-active .create-dialog, .dialog-fade-leave-active .create-dialog { transition: transform 170ms var(--ease-out); }.dialog-fade-enter-from, .dialog-fade-leave-to { opacity: 0; }.dialog-fade-enter-from .create-dialog, .dialog-fade-leave-to .create-dialog { transform: translateY(8px) scale(.985); }
@media (max-width: 620px) { .preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.role-mapping > label { grid-template-columns: 1fr; gap: 6px; }.host-picker { grid-template-columns: 1fr; }.host-picker select { width: 100%; } }
@media (max-width: 420px) { .preset-grid { grid-template-columns: 1fr; } }
</style>
