<script setup lang="ts">
type IconName =
  | 'chat'
  | 'history'
  | 'groups'
  | 'files'
  | 'artifacts'
  | 'board'
  | 'plus'
  | 'search'
  | 'dots'
  | 'sun'
  | 'moon'
  | 'logout'
  | 'menu'
  | 'close'
  | 'paperclip'
  | 'brain'
  | 'settings'
  | 'model'
  | 'bolt'
  | 'arrow-up'
  | 'stop'
  | 'tools'
  | 'users'
  | 'chevron-down'
  | 'chevron-left'
  | 'download'
  | 'external'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'link'
  | 'refresh'
  | 'quote'
  | 'check'
  | 'alert'
  | 'copy'
  | 'branch'
  | 'topic'
  | 'archive'
  | 'trash'
  | 'edit'
  | 'panel'
  | 'pin'
  | 'pin-filled'
  | 'pin-off'
  | 'globe'
  | 'bell'
  | 'monitor'

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 18 })
</script>

<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'monitor'"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></template>
    <template v-else-if="name === 'chat'">
      <path d="M8 18h-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-5l-6 4z" />
      <path d="M8 9h8M8 13h5" />
    </template>
    <template v-else-if="name === 'history'"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2M3 12H1m2 0 2-2m-2 2 2 2" /></template>
    <template v-else-if="name === 'groups'">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </template>
    <template v-else-if="name === 'files'">
      <path d="M4 4a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </template>
    <template v-else-if="name === 'artifacts'">
      <path d="M12 3 3 8l9 5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />
    </template>
    <template v-else-if="name === 'board'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1" /></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14M5 12h14" /></template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></template>
    <template v-else-if="name === 'dots'"><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></template>
    <template v-else-if="name === 'sun'"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></template>
    <template v-else-if="name === 'moon'"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z" /></template>
    <template v-else-if="name === 'logout'"><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6" /></template>
    <template v-else-if="name === 'menu'"><path d="M4 7h16M4 12h16M4 17h16" /></template>
    <template v-else-if="name === 'close'"><path d="m6 6 12 12M18 6 6 18" /></template>
    <template v-else-if="name === 'paperclip'"><path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.5-9.5a4 4 0 1 1 5.7 5.7l-9.6 9.5a2 2 0 0 1-2.8-2.8l8.9-8.9" /></template>
    <template v-else-if="name === 'brain'"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-5-.1 2.5 2.5 0 0 1-3-3 3 3 0 0 1 0-5.8A2.5 2.5 0 0 1 7 6a2.5 2.5 0 0 1 2.5-4Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 5-.1 2.5 2.5 0 0 0 3-3 3 3 0 0 0 0-5.8A2.5 2.5 0 0 0 17 6a2.5 2.5 0 0 0-2.5-4Z" /></template>
    <template v-else-if="name === 'settings'"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3v-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></template>
    <template v-else-if="name === 'model'"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" /></template>
    <template v-else-if="name === 'bolt'"><path d="M13.3 2 4.5 13h6.2L9.8 22l9.7-12h-6.2z" fill="currentColor" stroke="none" /></template>
    <template v-else-if="name === 'arrow-up'"><path d="M12 19V5m-7 7 7-7 7 7" stroke-width="2.2" /></template>
    <template v-else-if="name === 'stop'"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" /></template>
    <template v-else-if="name === 'tools'"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.4 7.2 6.1 4.9a4 4 0 0 0 5 5l-7.4 7.4a2.1 2.1 0 0 0 3 3l7.4-7.4a4 4 0 0 0 5-5l-2.3 2.3-3.6-3.6z" /></template>
    <template v-else-if="name === 'users'"><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 3a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2" /></template>
    <template v-else-if="name === 'chevron-down'"><path d="m6 9 6 6 6-6" /></template>
    <template v-else-if="name === 'chevron-left'"><path d="m15 18-6-6 6-6" /></template>
    <template v-else-if="name === 'download'"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14" /></template>
    <template v-else-if="name === 'external'"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></template>
    <template v-else-if="name === 'image'"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></template>
    <template v-else-if="name === 'video'"><rect x="2" y="5" width="15" height="14" rx="2" /><path d="m17 10 5-3v10l-5-3z" /></template>
    <template v-else-if="name === 'audio'"><path d="M9 18V5l11-2v13M9 9l11-2" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></template>
    <template v-else-if="name === 'file'"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></template>
    <template v-else-if="name === 'link'"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></template>
    <template v-else-if="name === 'refresh'"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.1 9a8 8 0 0 1 13-3l2 2M18.9 15a8 8 0 0 1-13 3l-2-2" /></template>
    <template v-else-if="name === 'quote'"><path d="M3 21c3 0 7-1 7-8V5H4v8h3c0 3-1 4-4 5zM14 21c3 0 7-1 7-8V5h-6v8h3c0 3-1 4-4 5z" /></template>
    <template v-else-if="name === 'check'"><path d="m5 12 4 4L19 6" /></template>
    <template v-else-if="name === 'alert'"><path d="M12 3 2 21h20zM12 9v4M12 17h.01" /></template>
    <template v-else-if="name === 'copy'"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></template>
    <template v-else-if="name === 'branch'"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 7c6 0 4 6 8 6h2" /></template>
    <template v-else-if="name === 'topic'"><path d="M5 9h14M5 15h14M9 5 7 19M17 5l-2 14" /></template>
    <template v-else-if="name === 'archive'"><path d="M3 6h18M5 6v14h14V6M3 3h18v3H3zM9 10h6" /></template>
    <template v-else-if="name === 'trash'"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5" /></template>
    <template v-else-if="name === 'edit'"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></template>
    <template v-else-if="name === 'panel'"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></template>
    <template v-else-if="name === 'pin'"><path d="M9 4v6l-2 4v2h10v-2l-2-4V4M12 16v5M8 4h8" /></template>
    <template v-else-if="name === 'pin-filled'"><path d="M8 3a1 1 0 0 0 0 2h1v4.72l-2.8 4.7A1 1 0 0 0 7.06 16H11v5a1 1 0 1 0 2 0v-5h3.94a1 1 0 0 0 .86-1.58L15 9.72V5h1a1 1 0 1 0 0-2z" fill="currentColor" stroke="none" /></template>
    <template v-else-if="name === 'pin-off'"><path d="M9 4v6l-2 4v2h10v-2l-2-4V4M12 16v5M8 4h8" /><path d="M4 4l16 16" /></template>
    <template v-else-if="name === 'globe'"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></template>
    <template v-else-if="name === 'bell'"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></template>
  </svg>
</template>

<style scoped>
.app-icon { display: block; flex: 0 0 auto; }
</style>
