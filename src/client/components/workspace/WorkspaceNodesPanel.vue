<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
type Node = { id: string; name: string; url: string }
const nodes = ref<Node[]>([]), name = ref(''), qrPayload = ref(''), reauthorizing = ref(''), editing = ref<Node>(), error = ref(''), busy = ref(false)
async function load() {
  try { nodes.value = (await apiRequest<{nodes: Node[]}>('/api/app/nodes')).nodes }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '读取节点失败' }
}
async function add() {
  busy.value = true; error.value = ''
  try {
    await apiRequest('/api/app/nodes', {method:'POST',body:{qrPayload:qrPayload.value.trim(),name:name.value.trim(),...(reauthorizing.value?{nodeId:reauthorizing.value}:{})}})
    qrPayload.value = ''; name.value = ''; reauthorizing.value = ''; await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '连接失败' }
  finally { busy.value = false }
}
async function save() {
  if (!editing.value) return
  busy.value = true; error.value = ''
  try {
    const raw = editing.value.url.trim(), url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!url.port) url.port = '15300'
    await apiRequest(`/api/app/nodes/${editing.value.id}`, {method:'PATCH',body:{name:editing.value.name.trim(),url:url.href}})
    editing.value = undefined; await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { busy.value = false }
}
async function revoke(id: string) {
  try { await apiRequest(`/api/app/nodes/${id}`, {method:'DELETE'}); await load() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '断开失败' }
}
onMounted(load)
</script>
<template>
  <section class="nodes-panel">
    <p>远程节点连接 15300 夭夭 AI，仅作为当前服务器的子节点。连接后可用它的基础智能体创建自己的机器人并加入群聊。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="node in nodes" :key="node.id">
      <div><strong>{{ node.name }}</strong><small>{{ node.url }} · 子节点</small></div>
      <button @click="editing = { ...node }">管理</button><button @click="reauthorizing = node.id; name = node.name">更新扫码授权</button><button @click="revoke(node.id)">断开</button>
    </article>
    <form v-if="editing" @submit.prevent="save">
      <label>节点名称<input v-model="editing.name" required maxlength="100" /></label>
      <label>IP 或 Web 地址<input v-model="editing.url" required placeholder="http://服务器:15300" /></label>
      <p>新地址需指向原来的子节点；省略端口时使用 15300。</p>
      <button :disabled="busy">保存</button><button type="button" @click="editing = undefined">取消</button>
    </form>
    <form @submit.prevent="add">
      <label>子节点名称<input v-model="name" maxlength="100" /></label>
      <label>子节点配对码<textarea v-model="qrPayload" required placeholder="yaoyao://pair?…" /></label>
      <p>在目标 15300 的“手机与节点”页面生成二维码，用手机扫码添加，或在这里粘贴配对码。服务器登录二维码不能用于子节点连接。</p>
      <button :disabled="busy">{{ busy ? '正在连接…' : reauthorizing ? '更新节点授权' : '添加子节点' }}</button>
    </form>
  </section>
</template>
<style scoped>
.nodes-panel {
  padding: 18px;
  display: grid;
  gap: 18px;
  color: var(--text-primary);
}
p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-muted);
}
article {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
article div {
  display: grid;
  gap: 5px;
}
small {
  font-size: 11px;
  color: var(--text-muted);
}
form {
  display: grid;
  gap: 15px;
}
label {
  display: grid;
  gap: 7px;
  font-size: 13px;
}
input,
textarea,
button {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-soft);
  color: inherit;
  padding: 10px;
}
button {
  cursor: pointer;
}
p[role='alert'] {
  color: var(--danger, #b44);
}
</style>
