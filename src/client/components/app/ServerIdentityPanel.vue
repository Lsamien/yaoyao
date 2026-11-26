<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
void auth.refreshServerIdentity()
</script>

<template>
  <section v-if="auth.serverIdentity" class="server-identity" aria-label="服务器名称">
    <h3>服务器名称</h3>
    <strong>{{ auth.serverIdentity.displayName }}</strong>
    <p>由管理员在管理后台设置，三端同步显示。</p>
  </section>
</template>

<style scoped>
.server-identity{padding:16px 0;border-top:1px solid var(--line)}h3{margin:0 0 12px;font-size:15px}p{font-size:12px;line-height:1.6;color:var(--text-secondary)}
</style>
