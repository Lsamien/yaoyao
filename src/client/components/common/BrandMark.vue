<script setup lang="ts">
withDefaults(defineProps<{
  size?: number
  label?: boolean
  compact?: boolean
  bare?: boolean
}>(), {
  size: 32,
  label: false,
  compact: false,
  bare: false,
})
</script>

<template>
  <span class="brand-mark" :class="{ 'brand-mark--compact': compact, 'brand-mark--bare': bare }">
    <span class="brand-mark__plate" :style="{ width: `${size}px`, height: `${size}px` }">
      <img src="/brand/AppIcon-1024.png" alt="" aria-hidden="true" />
    </span>
    <span v-if="label" class="brand-mark__name">夭夭 AI</span>
  </span>
</template>

<style scoped>
.brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--text-primary);
}

.brand-mark__plate {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 24%;
  background: #f1f1ef;
}

.brand-mark__plate img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.brand-mark__name {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -.035em;
}

.brand-mark--compact { gap: 8px; }
.brand-mark--compact .brand-mark__name { font-size: 16px; }
.brand-mark--bare .brand-mark__plate { border-radius: 0; background: transparent; }
</style>
