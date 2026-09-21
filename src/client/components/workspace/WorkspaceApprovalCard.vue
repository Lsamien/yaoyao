<script setup lang="ts">
import { ShieldCheck } from '@vicons/tabler'

defineProps<{ prompt: string; agentName?: string; busy?: boolean; error?: string }>()
const emit = defineEmits<{ choose: [choice: 'once' | 'deny' | 'auto'] }>()
</script>

<template>
  <section class="workspace-approval" aria-label="工具审批" :aria-busy="busy || undefined">
    <h3><ShieldCheck aria-hidden="true" />需要你的确认</h3>
    <p class="workspace-approval__request"><span v-if="agentName">{{ agentName }}： </span>{{ prompt }}</p>
    <div class="workspace-approval__actions">
      <button class="workspace-approval__allow" type="button" :disabled="busy" @click="emit('choose', 'once')">允许</button>
      <button class="workspace-approval__deny" type="button" :disabled="busy" @click="emit('choose', 'deny')">拒绝</button>
    </div>
    <p class="workspace-approval__hint">允许仅本次。所有 Bot 的审批策略在应用设置中统一管理。</p>
    <p v-if="busy" class="workspace-approval__status" role="status">正在处理…</p>
    <p v-if="error" class="workspace-approval__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.workspace-approval{box-sizing:border-box;width:100%;margin:16px 0 6px;padding:14px;border:1px solid var(--line);border-radius:18px;background:var(--settings-panel);color:var(--text-primary)}
h3{display:flex;align-items:center;gap:10px;margin:0;font-size:18px;line-height:1.3;font-weight:650}h3 svg{width:24px;height:24px;flex-shrink:0}
.workspace-approval__request{max-height:160px;overflow:auto;margin:8px 0 12px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-secondary)}
.workspace-approval__actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
button{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;min-height:44px;padding:10px 6px;border-radius:12px;font:600 14px/1.3 var(--font-ui);white-space:nowrap;color:inherit;cursor:pointer;transition:background .15s ease,opacity .15s ease}
button svg{width:18px;height:18px;flex-shrink:0}.workspace-approval__allow{background:var(--accent);color:var(--text-on-solid);border:1px solid var(--accent)}.workspace-approval__deny{background:var(--surface);border:1px solid var(--line-strong)}.workspace-approval__auto{background:var(--settings-selected);border:1px solid transparent}
button:hover:not(:disabled){filter:brightness(.94)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}
.workspace-approval__hint{margin:10px 0 0;color:var(--text-secondary);font-size:13px;line-height:1.4}.workspace-approval__scope{margin:6px 0 0;color:var(--text-secondary);font-size:12px;line-height:1.4}.workspace-approval__status,.workspace-approval__error{margin:10px 0 0;font-size:13px;line-height:1.5}.workspace-approval__error{color:var(--danger)}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style>
