<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue'

defineProps<{
  avatarName: string
  avatar?: string
}>()
</script>

<template>
  <div
    class="thinking-indicator"
    role="status"
    aria-live="polite"
    aria-label="机器人正在输入"
    data-testid="chat-run-thinking-dots"
  >
    <AgentAvatar
      class="thinking-indicator__avatar"
      :name="avatarName"
      :avatar="avatar"
      :size="20"
      state="working"
      aria-hidden="true"
    />
    <span class="thinking-indicator__dots" aria-hidden="true">
      <i
        v-for="index in 3"
        :key="index"
        class="thinking-indicator__dot"
        :style="{ '--dot-index': index - 1 }"
      />
    </span>
  </div>
</template>

<style scoped>
.thinking-indicator {
  display: flex;
  min-height: 34px;
  align-items: center;
  column-gap: 8px;
  margin: 5px 0 20px;
  color: var(--text-muted);
}

.thinking-indicator__dots {
  display: inline-flex;
  align-items: center;
  height: 16px;
  gap: 4px;
}

.thinking-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 90%, transparent);
  animation: thinking-dot-bounce 0.9s ease-in-out infinite;
  animation-delay: calc(var(--dot-index) * 0.15s);
}

@keyframes thinking-dot-bounce {
  0%, 55%, 100% { transform: translateY(0); }
  28% { transform: translateY(-5px); }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-indicator__dot {
    animation: none;
    transform: none;
  }
}
</style>
