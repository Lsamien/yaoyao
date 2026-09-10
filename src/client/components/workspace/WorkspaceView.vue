<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import { updateProfileIdentity, type ProfileIdentityInput } from '@/api/profiles'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

withDefaults(defineProps<{
  sidebarTitle: string
  sidebarSubtitle?: string
  sidebarContextTitle?: string
  sidebarFocusMode?: boolean
  inspectorOpen?: boolean
  inspectorCloseLabel?: string
}>(), { sidebarSubtitle: '', sidebarContextTitle: '', sidebarFocusMode: false, inspectorOpen: false, inspectorCloseLabel: '关闭预览' })

const emit = defineEmits<{ closeInspector: [] }>()
const auth = useAuthStore()
const theme = useThemeStore()

const userName = computed(() => auth.user?.displayName || auth.user?.username || '')
const identityBusy = ref(false)
const identityError = ref('')
const identityResetVersion = ref(0)

async function logout() { await auth.logout() }
function selectProfile(name: string) { auth.selectProfile(name) }
async function saveIdentity(input: ProfileIdentityInput) {
  const profile = auth.activeProfile
  if (!profile) return
  identityBusy.value = true
  identityError.value = ''
  try {
    await updateProfileIdentity(profile, input)
    await auth.refreshProfiles()
    await auth.refreshProfileAvatars()
    identityError.value = ''
    identityResetVersion.value += 1
  } catch (cause) {
    identityError.value = cause instanceof Error ? cause.message : '保存机器人身份失败'
  } finally {
    identityBusy.value = false
  }
}
async function refreshOnFocus() {
  await auth.refreshProfiles()
  await auth.refreshProfileAvatars()
}
function refreshOnWindowFocus() { void refreshOnFocus().catch(() => undefined) }
onMounted(() => {
  window.addEventListener('focus', refreshOnWindowFocus)
  void auth.refreshProfileAvatars().catch(() => undefined)
})
onBeforeUnmount(() => window.removeEventListener('focus', refreshOnWindowFocus))
</script>

<template>
  <WorkspaceShell :server-name="auth.serverIdentity?.displayName"
    :user-name="userName"
    :user-avatar="auth.user?.avatar"
    :pairing-user-name="auth.user?.username || ''"
    :active-profile="auth.activeProfile"
    :profiles="auth.profiles"
    :theme="theme.resolvedTheme"
    :theme-preference="theme.theme"
    :insecure-transport="auth.insecureLan"
    :is-admin="auth.user?.role === 'admin'"
    :upstream-ready="auth.upstreamReady"
    :upstream-error="auth.upstreamError"
    :identity-busy="identityBusy"
    :identity-error="identityError"
    :identity-reset-version="identityResetVersion"
    :sidebar-title="sidebarTitle"
    :sidebar-subtitle="sidebarSubtitle"
    :sidebar-context-title="sidebarContextTitle"
    :sidebar-focus-mode="sidebarFocusMode"
    :inspector-open="inspectorOpen"
    :inspector-close-label="inspectorCloseLabel"
    @logout="logout"
    @toggle-theme="theme.toggle"
    @set-theme="theme.setTheme"
    @select-profile="selectProfile"
    @save-identity="saveIdentity"
    @close-inspector="emit('closeInspector')"
  >
    <template #sidebar-action><slot name="sidebar-action" /></template>
    <template #sidebar-before-heading><slot name="sidebar-before-heading" /></template>
    <template #sidebar><slot name="sidebar" /></template>
    <template #mobile-sidebar><slot name="sidebar" /></template>
    <template #default><slot /></template>
    <template #inspector><slot name="inspector" /></template>
  </WorkspaceShell>
</template>
