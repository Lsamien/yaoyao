import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DesktopUpdateAction, DesktopUpdateState } from '@shared/desktopUpdate'

export function useDesktopUpdate() {
  const desktop = window.yaoyaoDesktop
  const supported = Boolean(desktop?.updateState && desktop?.updateAction)
  const state = ref<DesktopUpdateState>()
  const error = ref('')
  const pending = ref(false)
  const visible = computed(() => Boolean(state.value?.available
    || ['downloading', 'verifying', 'preparing', 'ready', 'installing'].includes(state.value?.phase ?? '')
    || (state.value?.phase === 'failed' && state.value.latestVersion)))
  let stopped = false, reading = false
  let timer: ReturnType<typeof setInterval> | undefined
  let detach: (() => void) | undefined

  async function refresh() {
    if (!supported || stopped || reading) return
    reading = true
    try {
      const next = await desktop!.updateState!()
      if (!stopped) state.value = next
    } catch { /* Navigation may briefly disconnect the bridge; retry on the next poll. */ }
    finally { reading = false }
  }

  async function run(action?: DesktopUpdateAction) {
    if (!supported || stopped || pending.value) return
    const current = state.value
    const nextAction = action ?? (current?.phase === 'ready'
      ? current.installMode === 'restart' ? 'install' : 'open'
      : current?.available ? 'download' : 'check')
    if (!action && (current?.retryable === false || ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(current?.phase ?? ''))) return
    pending.value = true
    error.value = ''
    try {
      const operation = desktop!.updateAction!(nextAction)
      // Read the running state while the download IPC is still pending.
      void refresh()
      const next = await operation
      if (!stopped && next) state.value = next
    } catch (cause) {
      if (!stopped) error.value = cause instanceof Error ? cause.message : '更新未完成，请重试'
    } finally { pending.value = false }
  }

  onMounted(() => {
    if (!supported) return
    void refresh()
    timer = setInterval(() => void refresh(), 500)
    detach = desktop?.onUpdateRequested?.(() => { void refresh() })
  })
  onBeforeUnmount(() => { stopped = true; clearInterval(timer); detach?.() })
  return { supported, state, error, pending, visible, refresh, run }
}
