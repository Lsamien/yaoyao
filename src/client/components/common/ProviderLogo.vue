<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { safeProviderLogo } from '@shared/botProviderLogos'

const props = defineProps<{ name: string; logo?: string; bundledLogo?: string }>()
const failed = ref<string[]>([])
const source = computed(() => [props.bundledLogo, props.logo].map(safeProviderLogo).find((url): url is string => !!url && !failed.value.includes(url)))
const initial = computed(() => Array.from(props.name.trim())[0]?.toLocaleUpperCase() || '?')
watch(() => [props.logo, props.bundledLogo], () => { failed.value = [] })
function onError(event: Event) {
  const url = (event.target as HTMLImageElement).getAttribute('src')
  if (url && !failed.value.includes(url)) failed.value.push(url)
}
</script>

<template>
  <span class="provider-logo" :class="{ 'provider-logo--fallback': !source }" aria-hidden="true">
    <img v-if="source" :key="source" :src="source" alt="" width="28" height="28" loading="lazy" decoding="async" referrerpolicy="no-referrer" :draggable="false" @error="onError" />
    <span v-else>{{ initial }}</span>
  </span>
</template>

<style scoped>
.provider-logo{display:grid;place-items:center;box-sizing:border-box;width:40px;height:40px;flex:0 0 40px;overflow:hidden;border:1px solid var(--line);border-radius:10px;background:#fff}
.provider-logo img{display:block;width:28px;height:28px;object-fit:contain}
.provider-logo--fallback{background:var(--surface-soft);color:var(--text-primary);font-size:17px;font-weight:650}
</style>
