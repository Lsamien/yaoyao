<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import {
  AddOutline,
  ChatbubbleOutline,
  ConstructOutline,
  FolderOutline,
  GridOutline,
  PeopleOutline,
  SearchOutline,
  TimeOutline,
} from '@vicons/ionicons5'

type SidebarIconName = 'add' | 'board' | 'chat' | 'history' | 'folder' | 'people' | 'search' | 'tools'

const props = withDefaults(defineProps<{ name: SidebarIconName; size?: number }>(), { size: 20 })
const component = computed(() => ({
  add: AddOutline,
  board: GridOutline,
  chat: ChatbubbleOutline,
  history: TimeOutline,
  folder: FolderOutline,
  people: PeopleOutline,
  search: SearchOutline,
  tools: ConstructOutline,
})[props.name])
</script>

<template>
  <NIcon :component="component" :size="size" aria-hidden="true" />
</template>
