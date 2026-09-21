<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LoadingScreen from '@/components/app/LoadingScreen.vue'
import LoginView from '@/views/LoginView.vue'
import PasswordChangeView from '@/views/PasswordChangeView.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useKanbanStore } from '@/stores/kanban'
import { useThemeStore } from '@/stores/theme'
import AgentIdentityFixture from '@/components/app/AgentIdentityFixture.vue'

const auth = useAuthStore()
const chat = useChatStore()
const kanban = useKanbanStore()
const theme = useThemeStore()
const route = useRoute()
const router = useRouter()
const allowedRoute = computed(() => !auth.isBotOnly || /^\/conversations(?:\/|$)/.test(route.path))
watch([() => auth.isBotOnly, () => route.path], () => {
  if (!allowedRoute.value) void router.replace('/conversations')
}, { immediate: true, flush: 'sync' })
const agentIdentityFixture = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get('fixture') === 'agent-identity'

const pageTitle = computed(() => {
  const name = route.name === 'computer' ? '电脑接管' : route.name === 'bot-automations' ? '自动化' : route.path.startsWith('/history')
    ? '历史记录'
    : route.path.startsWith('/conversations')
    ? '聊天'
    : route.path.startsWith('/kanban')
      ? kanban.selectedBoard?.name || kanban.selectedBoardSlug || '看板'
    : route.path.startsWith('/files')
      ? '文件库'
      : chat.activeSession?.title || '对话'
  return `${name} · 夭夭 AI`
})

watch(() => theme.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.dataset.theme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#181817' : '#f8f8f6')
}, { immediate: true })

watch(pageTitle, value => { document.title = value }, { immediate: true })

onMounted(() => {
  if (!agentIdentityFixture) void router.isReady().then(() => auth.bootstrap())
})
</script>

<template>
  <AgentIdentityFixture v-if="agentIdentityFixture" />
  <LoadingScreen v-else-if="auth.status === 'checking'" />
  <LoginView v-else-if="!auth.isAuthenticated" />
  <PasswordChangeView v-else-if="auth.user?.mustChangePassword" />
  <RouterView v-else-if="allowedRoute" />
  <LoadingScreen v-else />
</template>
