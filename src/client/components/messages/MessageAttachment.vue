<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiMessageAttachment } from './types'

const props = defineProps<{ attachment: UiMessageAttachment }>()
const emit = defineEmits<{ open: [attachment: UiMessageAttachment]; rendered: [] }>()
const failed = ref(false)
const retry = ref(0)
watch(() => props.attachment.url, () => { failed.value = false; retry.value = 0 })
const url = computed(() => {
  if (!retry.value || !props.attachment.url) return props.attachment.url
  const url = new URL(props.attachment.url, window.location.href)
  url.searchParams.set('_retry', String(retry.value))
  return url.href
})
const filename = computed(() => {
  const name = props.attachment.name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
})
const size = computed(() => {
  const bytes = props.attachment.size
  if (bytes === undefined || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${+(bytes / 1024).toFixed(1)} KB`
  return `${+(bytes / 1024 ** 2).toFixed(1)} MB`
})
</script>

<template>
  <div v-if="attachment.kind === 'image' && attachment.url" class="message-media">
    <button v-if="!failed" class="message-media__image" type="button" :aria-label="`预览图片 ${attachment.name}`" @click="emit('open', attachment)">
      <img :src="url" :alt="attachment.name" @load="emit('rendered')" @error="failed = true; emit('rendered')" />
    </button>
    <button v-else class="message-file" type="button" @click="failed = false; retry = Date.now()">
      <AppIcon name="image" :size="22" /><span>{{ attachment.name }} · 加载失败，点击重试</span>
    </button>
  </div>
  <button v-else class="message-file" type="button" :aria-label="`预览文件 ${attachment.name}${size ? `，${size}` : ''}`" @click="emit('open', attachment)">
    <span class="message-file__icon"><AppIcon :name="attachment.kind || 'file'" :size="23" /></span>
    <span class="message-file__info">
      <span class="message-file__name"><strong>{{ filename[0] }}</strong><span>{{ filename[1] }}</span></span>
      <span v-if="size" class="message-file__size">{{ size }}</span>
    </span>
  </button>
</template>

<style scoped>
.message-file { display:flex; align-items:center; gap:11px; width:fit-content; max-width:100%; min-height:64px; padding:10px 15px 10px 11px; border:0; border-radius:20px; background:var(--message-file-surface, #f1f1f1); color:var(--text-primary); text-align:left; cursor:pointer; }
.message-file__icon { display:grid; place-items:center; flex:0 0 32px; width:32px; height:36px; border-radius:10px; color:var(--text-secondary); background:color-mix(in srgb, var(--text-primary) 5%, transparent); }
.message-file__info { min-width:0; display:flex; flex-direction:column; gap:3px; }
.message-file__name { display:flex; min-width:0; max-width:300px; font-size:16px; line-height:1.4; }
.message-file__name strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:560; }
.message-file__name > span { flex-shrink:0; color:var(--text-muted); }
.message-file__size { font-size:12px; line-height:1.4; color:var(--text-muted); }
.message-file:hover { filter:brightness(.97); }
.message-file:focus-visible, .message-media__image:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.message-media { max-width:100%; }
.message-media__image { display:block; width:fit-content; max-width:100%; padding:0; border:0; border-radius:12px; overflow:hidden; background:transparent; cursor:zoom-in; }
.message-media__image img { display:block; width:auto; height:auto; max-width:min(100%, 430px); max-height:420px; object-fit:contain; }
@media(max-width:600px) { .message-media__image img { max-height:360px; } }
</style>
