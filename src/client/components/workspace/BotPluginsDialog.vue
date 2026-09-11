<script setup lang="ts">
import { ref } from 'vue'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'
import BotPluginsPanel from './BotPluginsPanel.vue'
const emit = defineEmits<{ close: [] }>()
const dirty = ref(false)
const beforeClose = () => !dirty.value || window.confirm('放弃尚未保存的插件更改？')
</script>
<template><StandaloneDialog title="已连接应用" :before-close="beforeClose" @close="emit('close')"><BotPluginsPanel @dirty-change="dirty = $event" /></StandaloneDialog></template>
