<script setup lang="ts">
import type { Profile } from '@shared/types'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'
defineProps<{ profiles?: Profile[] }>()
</script>

<template>
  <SystemManagementPanel section="users" :profiles="profiles ?? []" :active="true" />
</template>
