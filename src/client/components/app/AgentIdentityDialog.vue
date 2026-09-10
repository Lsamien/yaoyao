<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentIdentityPanel from './AgentIdentityPanel.vue'
import type { ProfileIdentityInput } from '@/api/profiles'
import ModelServicesPanel from './ModelServicesPanel.vue'
import DuplexVoicePanel from './DuplexVoicePanel.vue'

const props = defineProps<{ open: boolean; profile?: Profile; busy?: boolean; error?: string; isAdmin?: boolean }>()
const emit = defineEmits<{ close: []; save: [input: ProfileIdentityInput] }>()

const activeTab = ref<'identity' | 'models' | 'voice'>('identity')

watch(() => [props.open, props.profile] as const, () => {
  if (props.open) activeTab.value = 'identity'
}, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <Transition name="identity-fade">
      <div v-if="open && profile" class="identity-layer" @mousedown.self="emit('close')">
        <section class="identity-dialog" role="dialog" aria-modal="true" aria-label="机器人管理">
          <header><div><small>AGENT 管理</small><h2>{{ profile.agentName || profile.displayName || profile.name }}</h2></div><button class="icon-button" type="button" aria-label="关闭" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></header>
          <nav v-if="isAdmin" class="management-tabs" aria-label="机器人管理分类"><button type="button" :class="{ active: activeTab === 'identity' }" @click="activeTab = 'identity'">身份</button><button type="button" :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">模型服务</button><button type="button" :class="{ active: activeTab === 'voice' }" @click="activeTab = 'voice'">双流语音</button></nav>
          <AgentIdentityPanel v-if="activeTab === 'identity'" :profile="profile" :busy="busy" :error="error" @save="emit('save', $event)">
            <template #actions>
              <button class="quiet-button" type="button" :disabled="busy" @click="emit('close')">取消</button>
              <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在同步…' : '保存并同步' }}</button>
            </template>
          </AgentIdentityPanel>
          <ModelServicesPanel v-else-if="isAdmin && activeTab === 'models'" :profile="profile.name" />
          <DuplexVoicePanel v-else-if="isAdmin && activeTab === 'voice'" />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.identity-layer{position:fixed;z-index:230;inset:0;display:grid;place-items:center;padding:18px;background:var(--scrim);backdrop-filter:blur(4px)}.identity-dialog{width:min(680px,100%);max-height:calc(100dvh - 36px);box-sizing:border-box;padding:18px;overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--surface-raised);box-shadow:var(--shadow-float)}.identity-dialog>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.identity-dialog h2{margin:3px 0 0;font-size:17px}.identity-dialog header small{color:var(--text-muted);font-size:9px;letter-spacing:.08em}.management-tabs{display:flex;gap:4px;margin-bottom:18px;padding:3px;border-radius:10px;background:var(--surface-soft)}.management-tabs button{min-height:32px;flex:1;border:0;border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer;font-size:10px}.management-tabs button.active{background:var(--surface-raised);color:var(--text-primary);box-shadow:0 1px 4px rgba(0,0,0,.08)}.identity-fade-enter-active,.identity-fade-leave-active{transition:opacity 130ms ease}.identity-fade-enter-from,.identity-fade-leave-to{opacity:0}
@media(max-width:600px){.identity-layer{place-items:end center;padding:0}.identity-dialog{width:100%;max-height:calc(100dvh - 12px);border-radius:17px 17px 0 0;padding-bottom:max(18px,env(safe-area-inset-bottom))}.management-tabs{position:sticky;top:-18px;z-index:2}}
</style>
