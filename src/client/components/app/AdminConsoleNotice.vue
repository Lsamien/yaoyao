<script setup lang="ts">
import { ref } from 'vue'

const desktop = typeof window !== 'undefined' ? window.yaoyaoDesktop : undefined
const canOpen = Boolean(desktop?.openAdminConsole)
const error = ref('')
async function open() {
  error.value = ''
  try { await desktop?.openAdminConsole?.() } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法打开管理后台' }
}
</script>

<template>
  <section class="admin-console-notice" aria-label="管理后台">
    <h4>系统设置已移到管理后台</h4>
    <p>用户、模型服务与 API Key、执行与权限、电脑与执行节点、本地虚拟机、消息推送、语音、访问地址和更新，都在独立的管理后台中设置。管理后台只允许管理员登录，所有修改都会记入审计日志。</p>
    <button v-if="canOpen" type="button" class="solid-button" @click="open">打开管理后台</button>
    <ol v-else>
      <li>在运行夭夭服务的那台电脑上，用浏览器打开 <code>http://127.0.0.1:15301</code>（端口可能由 <code>YAOYAO_ADMIN_PORT</code> 改过）。</li>
      <li>从其他电脑管理时，先建立 SSH 隧道：<code>ssh -L 15301:127.0.0.1:15301 服务器</code>，再在本机打开上面的地址。</li>
      <li>Docker 部署时，管理后台只发布在宿主机的 <code>127.0.0.1:15301</code>。</li>
    </ol>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.admin-console-notice { display: grid; gap: 12px; max-width: 620px; }
h4 { margin: 0; font-size: 16px; }
p, li { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.7; }
ol { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; }
code { font: 12px var(--font-code); overflow-wrap: anywhere; }
.solid-button { justify-self: start; height: 38px; padding: 0 16px; border: 0; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font: 600 13px var(--font-ui); cursor: pointer; }
.error { color: var(--danger); }
</style>
