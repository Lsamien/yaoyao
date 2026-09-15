<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ title: string; compact?: boolean; settings?: boolean; beforeClose?: () => boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
function close() { if (props.beforeClose?.() !== false) emit('close') }
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
}
onMounted(async () => { await nextTick(); dialog.value?.showModal() })
onBeforeUnmount(() => dialog.value?.close())
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="standalone-dialog" :class="{ 'standalone-dialog--compact': compact, 'standalone-dialog--settings': settings }" :aria-label="title" @cancel.prevent="close" @click="backdrop">
    <header><h2>{{ title }}</h2><button type="button" :aria-label="`关闭${title}`" autofocus @click="close"><AppIcon name="close" :size="20" /></button></header>
    <div class="standalone-dialog__content"><slot /></div>
  </dialog></Teleport>
</template>
<style scoped>
.standalone-dialog{width:min(1040px,calc(100vw - 48px));height:min(780px,calc(100dvh - 48px));max-width:none;max-height:none;margin:auto;padding:0;border:1px solid var(--line);border-radius:22px;background:var(--surface);color:var(--text-primary);box-shadow:0 24px 100px #0005;overflow:hidden}.standalone-dialog[open]{display:flex;flex-direction:column}.standalone-dialog::backdrop{background:#0007;backdrop-filter:blur(3px)}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px 16px;border-bottom:1px solid var(--line);flex-shrink:0}h2{font-size:21px;font-weight:650;margin:0;letter-spacing:-.02em}header button{display:grid;place-items:center;width:44px;height:44px;padding:0;flex-shrink:0;border:0;border-radius:10px;color:inherit;background:transparent;cursor:pointer}header button:hover{background:var(--surface-hover)}header button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.standalone-dialog__content{padding:24px;overflow:auto;min-height:0;flex:1}.standalone-dialog--compact{width:min(380px,calc(100vw - 32px));height:fit-content;max-height:calc(100dvh - 32px);border-radius:18px}.standalone-dialog--compact header{padding:10px 12px 10px 20px}.standalone-dialog--compact h2{font-size:15px}.standalone-dialog--compact .standalone-dialog__content{padding:20px 24px 28px}@media(max-width:600px){.standalone-dialog:not(.standalone-dialog--compact){width:100vw;height:100dvh;border:0;border-radius:0}header{padding:10px 12px 10px 20px}h2{font-size:18px}.standalone-dialog__content{padding:20px}}
</style>
<style scoped>
.standalone-dialog--settings{width:min(900px,calc(100vw - 48px));height:min(650px,calc(100dvh - 64px));border-radius:14px;box-shadow:0 24px 72px #0003}.standalone-dialog--settings>header{height:60px;padding:8px 16px 8px 20px;box-sizing:border-box}.standalone-dialog--settings h2{font-size:18px;font-weight:650}.standalone-dialog--settings .standalone-dialog__content{padding:0;overflow:hidden}.standalone-dialog--settings::backdrop{background:var(--scrim);backdrop-filter:blur(3px)}@media(max-width:600px){.standalone-dialog--settings{width:100vw;height:100dvh;border-radius:0}.standalone-dialog--settings>header{padding-left:20px}}
</style>
