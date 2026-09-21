<script setup lang="ts">
import type { SystemNoticeIcon } from '@/utils/systemMessageNotice'
import AppIcon from '@/components/common/AppIcon.vue'

defineProps<{ title: string; icon?: SystemNoticeIcon; href?: string; accessibleLabel?: string }>()
</script>

<template>
  <div class="system-message-notice">
    <a v-if="href" class="system-message-notice__label" :href="href" :aria-label="accessibleLabel || title">
      <AppIcon :name="icon || 'info'" :size="16" aria-hidden="true" /><span>{{ title }}</span>
    </a>
    <details v-else-if="$slots.default">
      <summary class="system-message-notice__label" :aria-label="accessibleLabel || `${title}，查看详情`">
        <AppIcon :name="icon || 'info'" :size="16" aria-hidden="true" /><span role="status">{{ title }}</span>
      </summary>
      <div class="system-message-notice__details"><slot /></div>
    </details>
    <div v-else class="system-message-notice__label" role="status">
      <AppIcon :name="icon || 'info'" :size="16" aria-hidden="true" /><span>{{ title }}</span>
    </div>
  </div>
</template>

<style scoped>
.system-message-notice { width: 100%; min-width: 0; color: var(--text-muted); font-size: 13px; line-height: 1.6; text-align: center; }
.system-message-notice__label { display: flex; width: fit-content; max-width: 100%; min-height: 44px; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; margin: 0 auto; padding: 8px 4px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; font-weight: 400; text-decoration: none; list-style: none; overflow-wrap: anywhere; }
.system-message-notice__label :deep(svg) { flex-shrink: 0; }
summary, a { cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:hover, a:hover { color: var(--text-secondary); }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.system-message-notice__details { width: min(640px, 100%); max-height: 360px; box-sizing: border-box; overflow: auto; margin: 4px auto 12px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--text-secondary); background: var(--surface); text-align: left; overflow-wrap: anywhere; }
.system-message-notice__details :deep(.markdown) { font-size: 13px; text-align: left; }
</style>
