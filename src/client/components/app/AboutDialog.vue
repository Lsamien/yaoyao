<script setup lang="ts">
import { version } from '../../../../package.json'
import BrandMark from '@/components/common/BrandMark.vue'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'
const emit = defineEmits<{ close: [] }>()
</script>
<template>
  <StandaloneDialog title="关于夭夭 AI" compact @close="emit('close')"><section class="about-content">
    <BrandMark :size="56" :label="false" compact bare /><h3>夭夭 AI</h3><p class="about-version">版本 {{ version }}</p>
    <p>与 AI 聊天，让 Bot 协作完成任务。<br />基于 Apache-2.0 许可证开放源代码。</p>
    <nav aria-label="关于链接"><a href="https://github.com/Lsamien/yaoyao" target="_blank" rel="noopener noreferrer">GitHub</a><a href="https://yaoyao.samien.cn" target="_blank" rel="noopener noreferrer">帮助中心</a><a href="https://github.com/Lsamien/yaoyao/releases" target="_blank" rel="noopener noreferrer">版本发布</a></nav>
  </section></StandaloneDialog>
</template>
<style scoped>
.about-content{display:grid;justify-items:center;gap:12px;text-align:center}.about-content h3{font-size:21px;margin:0}.about-content p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.8}.about-content .about-version{font-size:12px}.about-content nav{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}.about-content a{padding:10px 8px;color:var(--accent);font-size:13px;text-decoration:none}.about-content a:hover{text-decoration:underline}.about-content a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
