<script setup lang="ts">
import { computed, ref } from 'vue'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import { workspaceAgentActivity, workspaceConversationItem } from './viewModels'
import type { WorkspaceAgent, WorkspaceConversation } from '@shared/workspace'
const props = withDefaults(defineProps<{ conversations: WorkspaceConversation[]; agents?: WorkspaceAgent[]; selected?: string }>(), { agents: () => [] })
const emit = defineEmits<{ select: [id: string]; settings: [id: string]; pin: [id: string]; archive: [id: string]; delete: [id: string] }>()
const menuId = ref('')
const menuPosition = ref({ left: '8px', top: '8px' })
const menuConversation = computed(() => props.conversations.find(c => c.id === menuId.value))
const agentActivity = computed(() => workspaceAgentActivity(props.conversations))
const rows = computed(() => props.conversations.filter(c => !c.archived).map(c => ({
  ...workspaceConversationItem(c, props.agents, agentActivity.value),
  section: '',
})))
function openMenu(id: string, event: MouseEvent) {
  menuId.value = id
  menuPosition.value = { left: `${Math.max(8, Math.min(event.clientX, window.innerWidth - 170))}px`, top: `${Math.max(8, Math.min(event.clientY, window.innerHeight - 180))}px` }
}
function action(kind: 'pin' | 'archive' | 'delete') {
  if (kind === 'pin') emit('pin', menuId.value)
  else if (kind === 'archive') emit('archive', menuId.value)
  else emit('delete', menuId.value)
  menuId.value = ''
}
function openSettings(){const id=menuId.value;menuId.value='';emit('settings',id)}
</script>
<template>
  <div class="conversation-list">
    <ResourceSidebar :items="rows" :active-id="selected" :searchable="false" :avatar-size="44" external-search
      empty-title="还没有聊天" empty-description="创建机器人，或选择成员新建群聊。"
      @select="emit('select', $event)" @more="openMenu" @context-menu="openMenu" />
    <Teleport to="body">
      <div v-if="menuConversation" class="conversation-menu-dismiss" @pointerdown.self="menuId = ''" @keydown.esc="menuId = ''">
        <section class="conversation-actions" :style="menuPosition" role="menu" aria-label="聊天操作">
          <button role="menuitem" @click="openSettings">{{ menuConversation.kind === 'direct' ? '机器人设置' : '群聊设置' }}</button>
          <button role="menuitem" @click="action('pin')">{{ menuConversation.pinned ? '取消置顶' : '置顶聊天' }}</button>
          <button role="menuitem" @click="action('archive')">{{ menuConversation.archived ? '恢复聊天' : '归档聊天' }}</button>
          <button class="danger" role="menuitem" @click="action('delete')">删除聊天</button>
        </section>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.conversation-list{display:flex;height:100%;min-height:0;flex:1;flex-direction:column;overflow:hidden}
.conversation-list :deep(.sidebar-list){padding:0 12px 18px;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--text-muted) 60%,transparent) transparent}
.conversation-list :deep(.sidebar-list::-webkit-scrollbar){width:8px}
.conversation-list :deep(.sidebar-list::-webkit-scrollbar-thumb){border:2px solid transparent;border-radius:999px;background:color-mix(in srgb,var(--text-muted) 60%,transparent);background-clip:padding-box}
.conversation-list :deep(.sidebar-list:hover::-webkit-scrollbar-thumb){background:color-mix(in srgb,var(--text-muted) 82%,transparent);background-clip:padding-box}
.conversation-list :deep(.sidebar-item){min-height:76px;padding:14px 8px;gap:16px;border-radius:12px}
.conversation-list :deep(.sidebar-item__icon){width:44px;height:44px;flex-basis:44px}
.conversation-list :deep(.sidebar-item__row strong){font-size:15px;font-weight:600;line-height:22px}
.conversation-list :deep(.sidebar-item__row--secondary){font-size:13px;line-height:19px;margin-top:4px}
.conversation-list :deep(.sidebar-item__row small){font-size:10px;color:var(--text-muted)}
.conversation-menu-dismiss{position:fixed;inset:0;z-index:200}.conversation-actions{position:absolute;display:grid;min-width:155px;padding:5px;border:1px solid var(--line);border-radius:10px;background:var(--surface-raised);box-shadow:var(--shadow-float)}.conversation-actions button{padding:9px 12px;border:0;border-radius:7px;background:transparent;color:var(--text-primary);text-align:left;cursor:pointer;font-size:12px}.conversation-actions button:hover{background:var(--surface-hover)}
.conversation-actions button.danger{color:var(--danger)}
</style>
