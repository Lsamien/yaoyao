<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LoadingScreen from '@/components/app/LoadingScreen.vue'
import LoginView from '@/views/LoginView.vue'
import PasswordChangeView from '@/views/PasswordChangeView.vue'
import { useUnreadStore } from '@/stores/unread'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import AgentIdentityFixture from '@/components/app/AgentIdentityFixture.vue'

const unread=useUnreadStore()
const auth = useAuthStore()
watch(()=>auth.isAuthenticated ? `${auth.serverIdentity?.serverId ?? location.origin}:${auth.user?.id ?? ''}` : '',()=>{
 if(auth.isAuthenticated&&auth.user)unread.start(auth.user.id)
 else { unread.reset();void window.yaoyaoDesktop?.unreadState?.(null).catch(()=>{}) }
},{immediate:true})
const theme = useThemeStore()
const route = useRoute()
const router = useRouter()
// Bot mode is the only interface for every account.
const allowedRoute = computed(() => /^\/conversations(?:\/|$)/.test(route.path))
let routerReady = false
void router.isReady().then(() => {
  routerReady = true
  if (!allowedRoute.value) void router.replace('/conversations')
})
watch(() => route.path, () => {
  if (routerReady && !allowedRoute.value) void router.replace('/conversations')
}, { flush: 'sync' })
const agentIdentityFixture = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get('fixture') === 'agent-identity'

const pageTitle = computed(() => {
  const name = route.name === 'computer' ? '电脑接管' : route.name === 'bot-automations' ? '自动化' : '聊天'
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
