<script setup lang="ts">
import {onMounted,ref,nextTick} from 'vue'
import {apiRequest} from '@/api/client'
import ExecutionResourceDialog from './ExecutionResourceDialog.vue'
import type {ExecutionSettingsView,SystemResourceSummary} from '@shared/executionEnvironment'
const errorBox=ref<HTMLElement>()
const state=ref<ExecutionSettingsView>(),busy=ref(false),error=ref(''),status=ref('')
const mode=ref<'none'|'server'|'virtual'>('none'),password=ref(''),clearPassword=ref(false)
const editing=ref<SystemResourceSummary>(),showResource=ref(false)
const root='/api/app/admin/execution'
async function load(){state.value=await apiRequest<ExecutionSettingsView>(root);mode.value=state.value.execution.mode}
async function action(work:()=>Promise<void>,message:string){if(busy.value)return;busy.value=true;error.value='';status.value='';try{await work();status.value=message}catch(e){error.value=e instanceof Error?e.message:'保存失败';await nextTick();errorBox.value?.focus()}finally{busy.value=false}}
function edit(resource?:SystemResourceSummary){editing.value=resource;showResource.value=true}
async function resourceSaved(){showResource.value=false;await action(load,'系统授权已保存')}
async function saveEnvironment(){await action(async()=>{await apiRequest(root+'/environment',{method:'PUT',body:{mode:mode.value,revision:state.value!.execution.revision}});await load()},'默认运行环境已保存，从下一轮任务生效')}
async function saveProxy(){await action(async()=>{const {hasPassword,...proxy}=state.value!.proxy;await apiRequest(root+'/proxy',{method:'PUT',timeoutMs:60000,body:{...proxy,...(clearPassword.value?{password:''}:password.value?{password:password.value}:{})}});password.value='';clearPassword.value=false;await load()},'代理配置已保存，请查看各节点生效状态')}
async function testProxy(){await action(async()=>{const result=await apiRequest<{nodes:Array<{name:string;ok:boolean;error?:string}>}>(root+'/proxy/test',{method:'POST',timeoutMs:60000,body:{}});if(result.nodes.some(n=>!n.ok))throw new Error(result.nodes.filter(n=>!n.ok).map(n=>`${n.name}：${n.error||'代理连接失败，请核对地址和认证'}`).join('；'))},'在线节点的网络网关已就绪，均可连接已保存的代理')}
onMounted(()=>action(load,''))
</script>

<template>
  <div class="execution-settings" :aria-busy="busy">
    <p v-if="error" ref="errorBox" role="alert" tabindex="-1">{{error}}</p>
    <p v-if="status" role="status">{{status}}</p>
    <p v-if="!state">正在加载运行环境…</p>
    <template v-else>
      <form @submit.prevent="saveEnvironment">
        <h4>默认运行环境</h4>
        <p>所有 Bot 在未指定目标时优先使用所选环境，从下一轮任务生效。其他已开启且获授权的环境仍可使用。Hermes 继续负责推理与调度。</p>
        <label>默认执行位置<select v-model="mode" :disabled="busy"><option value="none">不指定环境</option><option value="server">服务器本机 · Hermes 所在节点</option><option value="virtual">虚拟环境 · Bot 对应的隔离环境</option></select></label>
        <p v-if="mode==='none'">不预设执行位置，按任务选择已允许的环境；目标不明确时再询问。</p>
        <p v-else-if="mode==='server'">未指定目标时优先在 Hermes 所在节点执行，使用节点的环境变量和本机登录。已开启的虚拟机、电脑及浏览器仍可使用。</p>
        <p v-else>未指定目标的脚本优先在 Bot 虚拟环境中运行，使用下方授予该 Bot 的系统变量；其他已允许的环境仍可使用。</p>
        <p>开启托管浏览器后，未指定浏览器或设备的网页任务默认在托管浏览器中打开。</p>
        <button :disabled="busy||mode===state.execution.mode">保存默认环境</button>
        <p v-for="turn in state.activeTurns.filter(t=>t.revision!==state!.execution.revision)" :key="turn.agentId">{{turn.agentId}} 的当前任务仍以 {{turn.mode}} 为默认环境，结束后更新。</p>
      </form>
      <section>
        <h4>Yaoyao 环境与服务授权</h4>
        <p>系统统一保存，按 Bot 授权使用。不受默认运行环境限制；变量和临时登录文件仅注入虚拟机脚本，API 服务通过授权工具使用。授权值不会回显。共享虚拟机的成员必须统一获得变量权限，才能注入脚本。</p>
        <ul><li v-for="resource in state.resources" :key="resource.id"><div><strong>{{resource.name}}</strong><p>{{resource.kind==='codex'?'Codex CLI 登录':resource.kind==='api'?'模型 / 生图等 API 服务':'环境变量'}} · {{resource.agentIds.length}} 个 Bot · {{resource.envKeys.join('、')||'通过服务工具调用'}}</p></div><button type="button" :disabled="busy" @click="edit(resource)">编辑 {{resource.name}}</button><button type="button" :disabled="busy" @click="action(async()=>{await apiRequest(root+'/resources/'+resource.id,{method:'DELETE'});await load()},'授权已撤销')">撤销</button></li></ul>
        <button type="button" :disabled="busy" @click="edit()">添加授权或变量</button>
        <ExecutionResourceDialog v-if="showResource" :resource="editing" :agents="state.agents" @close="showResource=false" @saved="resourceSaved" />
      </section>
      <form @submit.prevent="saveProxy">
        <h4>虚拟机全局代理</h4>
        <p v-if="state.execution.mode==='server'">默认运行环境是「服务器本机」，已开启的虚拟机仍可使用。此处代理仅用于虚拟机；本机命令、Hermes 模型请求和托管浏览器仍使用各自的网络配置。</p>
        <p>所有受管虚拟环境的程序共用出口。保留公网 HTTP/HTTPS 限制，其他协议阻断；代理故障时不直连。保存会断开旧网络任务。</p>
        <label class="check"><input v-model="state.proxy.enabled" type="checkbox" :disabled="busy">启用统一代理</label>
        <template v-if="state.proxy.enabled">
          <label>协议<select v-model="state.proxy.protocol" :disabled="busy"><option value="http">HTTP CONNECT</option><option value="socks5">SOCKS5</option></select></label>
          <label>代理地址<input v-model="state.proxy.host" required placeholder="执行节点可以访问的主机名或 IP" :disabled="busy"></label>
          <label>端口<input v-model.number="state.proxy.port" type="number" min="1" max="65535" required :disabled="busy"></label>
          <label>用户名<input v-model="state.proxy.username" autocomplete="off" :disabled="busy"></label>
          <label v-if="state.proxy.hasPassword" class="check"><input v-model="clearPassword" type="checkbox" :disabled="busy">清除已保存的代理密码</label>
          <label>密码<input v-model="password" type="password" autocomplete="new-password" :placeholder="state.proxy.hasPassword?'留空保留已保存密码':''" :disabled="busy"></label>
        </template>
        <div class="actions"><button :disabled="busy">保存代理</button><button type="button" :disabled="busy||!state.proxy.enabled" @click="testProxy">测试已保存的代理</button><button type="button" :disabled="busy" @click="action(load,'状态已刷新')">刷新状态</button></div>
        <p v-for="node in state.nodes" :key="node.id">{{node.name}}：{{node.status}}</p>
        <p>Yaoyao 后端代发的服务请求使用后端网络配置。Compose 部署需要更新网络网关；旧环境不会假报代理已生效。</p>
      </form>
    </template>
  </div>
</template>

<style scoped>
.execution-settings{display:grid;gap:24px;margin-bottom:28px;font-size:14px}.execution-settings form,.execution-settings section{display:grid;gap:14px;padding:20px;background:var(--settings-panel);border:1px solid var(--line);border-radius:12px;min-width:0}.execution-settings h4{margin:0;font-size:16px}.execution-settings p{margin:0;color:var(--text-secondary);line-height:1.65;overflow-wrap:anywhere}.execution-settings label{display:grid;gap:8px}.execution-settings input,.execution-settings select,.execution-settings textarea,.execution-settings button{min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;max-width:100%;box-sizing:border-box}.execution-settings textarea{min-height:96px;resize:vertical;width:100%}.execution-settings button{cursor:pointer;justify-self:start}.execution-settings :disabled{opacity:.6;cursor:default}.execution-settings :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.execution-settings [role=alert]{color:var(--danger)}.execution-settings .check{display:flex;align-items:center;gap:10px;min-height:44px;flex-wrap:wrap}.check input{min-height:20px;width:20px;height:20px}.execution-settings fieldset{border:1px solid var(--line);border-radius:8px;min-width:0}.execution-settings ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}.execution-settings li{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.execution-settings li>div{flex:1;min-width:140px}.execution-settings .actions{display:flex;gap:10px;flex-wrap:wrap}@media(max-width:600px){.execution-settings form,.execution-settings section{padding:14px}.execution-settings form form{padding:10px}}
</style>
