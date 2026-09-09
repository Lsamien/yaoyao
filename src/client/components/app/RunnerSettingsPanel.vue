<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
import { UNCONFIGURED_COMPUTER_IMAGE } from '@shared/runner'
import type { RunnerConfiguration, RunnerRecord } from '@shared/runner'

type Runner = Omit<RunnerRecord, 'tokenHash' | 'sourceOwner'> & {online: boolean}
const props=defineProps<{computerSetup?:boolean}>()
const bundleAvailable=ref(false),fixedDesktops=ref(false)
const runners = ref<Runner[]>([]), sources = ref<Array<{id:string;name:string}>>([])
const busy = ref(false), error = ref(''), notice = ref('')
const name = ref(''), source = ref('local'), profiles = ref('default')
const serverURL = ref(window.location.origin), hermesURL = ref('http://127.0.0.1:9119')
const computerNetwork=ref<'none'|'public-proxy'>('public-proxy')
const computers=ref(!!props.computerSetup),computerRuntime=ref<'docker'|'podman'>('docker'),computerImage=ref(''),computerPython=ref(''),hermesSource=ref(''),hermesHome=ref('')
const artifactRoots = ref(''), insecure = ref(false), configuration = ref<RunnerConfiguration>()

async function refresh() {
  const data = await apiRequest<{runners:Runner[];sources:Array<{id:string;name:string}>;bundleAvailable?:boolean;fixedDesktops?:boolean}>('/api/app/admin/runners')
  runners.value = data.runners; sources.value = data.sources;bundleAvailable.value=!!data.bundleAvailable;fixedDesktops.value=!!data.fixedDesktops
}
async function action(work:()=>Promise<void>) {
  if(busy.value) return
  error.value = ''; notice.value = ''; busy.value = true
  try { await work() } catch(cause) { error.value = cause instanceof Error ? cause.message : '执行节点操作失败' }
  finally { busy.value = false }
}
async function register() {
  await action(async()=>{
    const web = new URL(serverURL.value), local = new URL(hermesURL.value)
    if(!['http:','https:'].includes(web.protocol)||web.username||web.password||web.search||web.hash||web.pathname!=='/')throw new Error('请填写不带路径的夭夭服务地址')
    if(web.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(web.hostname)&&!insecure.value)throw new Error('远程节点请使用 HTTPS，或勾选可信局域网 HTTP')
    if(!['127.0.0.1','[::1]'].includes(local.hostname)||!['http:','https:'].includes(local.protocol)||local.username||local.password)throw new Error('Hermes 地址必须指向 Runner 所在电脑的回环地址')
    const allowedProfiles = [...new Set(profiles.value.split(/[\s,，]+/).filter(Boolean))]
    if(computers.value&&((!!computerImage.value&&!/^sha256:[a-f0-9]{64}$/.test(computerImage.value))||[computerPython.value,hermesSource.value,hermesHome.value].some(path=>path&&!path.startsWith('/'))))throw new Error('自定义路径必须为执行电脑上的绝对路径；默认安装可留空。镜像 ID 可留空或填写完整 sha256 ID。')
    const result = await apiRequest<{runner:Runner;token:string}>('/api/app/admin/runners', {method:'POST',body:{name:name.value.trim(),sourceNodeId:source.value,allowedProfiles}})
    configuration.value = {protocol:1,serverURL:web.origin,runnerId:result.runner.id,token:result.token,hermesURL:local.toString(),allowedProfiles,artifactRoots:artifactRoots.value.split('\n').map(p=>p.trim()).filter(Boolean),...(insecure.value?{allowInsecureLan:true}:{}),...(computers.value?{computers:{...(fixedDesktops.value?{managedBy:'compose' as const}:{}),network:fixedDesktops.value?'none':computerNetwork.value,runtime:computerRuntime.value,imageId:computerImage.value||UNCONFIGURED_COMPUTER_IMAGE,python:computerPython.value,hermesSource:hermesSource.value,hermesHome:hermesHome.value}}:{})}
    notice.value = '节点已注册，请下载配置并在 Hermes 所在电脑启动 Runner。'
    await refresh()
  })
}
function download() {
  if(!configuration.value) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(configuration.value,null,2)+'\n'],{type:'application/json'}))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'runner.json'; anchor.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function disable(runner:Runner) {
  void action(async()=>{
    await apiRequest(`/api/app/admin/runners/${runner.id}`,{method:'DELETE',body:{}})
    if(configuration.value?.runnerId===runner.id)configuration.value=undefined
    await refresh(); notice.value = `已停用 ${runner.name}`
  })
}
onMounted(()=>{void action(refresh)})
</script>

<template>
  <section class="runner-panel" aria-label="执行节点设置">
    <p>在运行 Hermes 的电脑上启动 Runner，它会主动连接夭夭，接收 Bot 任务并提供本轮团队工具。注册后，该来源的 Bot 任务会交给 Runner；节点离线时无法启动新任务，恢复连接后可重试。</p>
    <p v-if="bundleAvailable"><a href="/api/app/admin/runners/bundle" download>下载配套执行节点程序</a>（包含桌面资源，需要 Node.js 24 或更高版本）。</p>
    <div class="runner-toolbar"><strong>已注册节点</strong><button type="button" :disabled="busy" @click="action(refresh)">刷新状态</button></div>
    <ul v-if="runners.length" class="runner-list">
      <li v-for="runner in runners" :key="runner.id">
        <div><strong>{{ runner.name }}</strong><span>{{ !runner.enabled ? '已停用' : runner.online ? '已连接' : '待连接' }}</span><small>{{ runner.allowedProfiles.join('、') }}</small></div>
        <button v-if="runner.enabled" type="button" :disabled="busy" :aria-label="`停用 ${runner.name}`" @click="disable(runner)">停用</button>
      </li>
    </ul>
    <p v-else>尚未注册执行节点。</p>
    <form v-if="!configuration" @submit.prevent="register">
      <label>节点名称<input v-model="name" required maxlength="100" autocomplete="off" placeholder="我的 Mac" :disabled="busy"></label>
      <label>接管的 Bot 来源<select v-model="source" :disabled="busy"><option v-for="item in sources" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>允许的 Profile<input v-model="profiles" required placeholder="default, writer" :disabled="busy"><small>填写 Hermes 的 Profile 名称，以逗号分隔；账号权限仍然生效。</small></label>
      <label>夭夭服务地址<input v-model="serverURL" type="url" required :disabled="busy"><small>必须能从 Runner 所在电脑访问。</small></label>
      <label>Runner 本机 Hermes 地址<input v-model="hermesURL" type="url" required :disabled="busy"></label>
      <label>允许导出的产物目录<textarea v-model="artifactRoots" rows="2" :disabled="busy" placeholder="每行一个绝对路径，留空时禁止导出文件"></textarea></label>
      <label class="runner-check"><input v-model="insecure" type="checkbox" :disabled="busy">使用可信局域网 HTTP</label>
      <label class="runner-check"><input v-model="computers" type="checkbox" :disabled="busy">启用隔离电脑 Worker</label>
      <fieldset v-if="computers" class="runner-computer">
        <legend>执行电脑配置</legend><p v-if="fixedDesktops">桌面已由 Compose 创建。Runner 只转发执行和控制，不安装桌面镜像、不创建容器；联网方式由 Compose 指定。</p>
        <label v-if="!fixedDesktops">容器运行时<select v-model="computerRuntime"><option value="docker">Docker</option><option value="podman">Podman</option></select></label>
        <label v-if="!fixedDesktops">联网范围<select v-model="computerNetwork"><option value="public-proxy">公网网页（HTTP / HTTPS）</option><option value="none">不联网</option></select></label>
        <small v-if="!fixedDesktops">公网模式通过受控代理访问，不开放宿主和内网地址。</small>
        <label v-if="!fixedDesktops">兼容镜像 ID<input v-model.trim="computerImage" placeholder="可在本地虚拟机设置中准备"></label>
        <label>Hermes Python 路径<input v-model.trim="computerPython" placeholder="留空使用默认安装"></label>
        <label>Hermes 源码目录<input v-model.trim="hermesSource" placeholder="留空使用默认安装"></label>
        <label>Hermes 配置目录<input v-model.trim="hermesHome" placeholder="留空使用默认安装"></label>
        <small>留空时在执行电脑上查找 ~/.hermes/hermes-agent/venv/bin/python。自定义安装请填写绝对路径；镜像可在节点连接后于本页准备。</small>
        <small>这是外部执行节点的高级配置。本机虚拟机可直接在应用设置中准备，并从 Agent 聊天的电脑面板启用。</small>
      </fieldset>
      <button class="solid-button" :disabled="busy || !name.trim() || !profiles.trim()">注册节点</button>
    </form>
    <div v-else class="runner-setup">
      <button class="solid-button" type="button" @click="download">下载 Runner 配置</button>
      <p>配置包含本节点的连接凭据，仅本次可下载。将文件放在 Hermes 所在电脑，设置为仅自己可读：</p>
      <code v-if="bundleAvailable">mkdir -p yaoyao-runner<br>tar -xzf yaoyao-runner.tar.gz -C yaoyao-runner<br>chmod 600 runner.json<br>node yaoyao-runner/runner.mjs --config /完整路径/runner.json</code>
      <code v-else>chmod 600 runner.json<br>npm run runner -- --config /完整路径/runner.json</code>
      <small>{{bundleAvailable?'在运行 Hermes 和 Docker/Podman 的电脑上执行，节点连接后返回本地虚拟机设置准备桌面。':'在 hermes-yaoyao 项目中先运行 npm run build。'}}配置丢失后可停用节点并重新注册。</small>
    </div>
    <p v-if="error" class="runner-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.runner-panel { display: grid; gap: 14px; min-width: 0; font-size: 13px; }
.runner-panel p { margin: 0; line-height: 1.6; color: var(--text-secondary); }
.runner-toolbar,.runner-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.runner-panel button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-primary); cursor: pointer; }
.runner-panel button:disabled { opacity: .5; cursor: default; }
.runner-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.runner-list li { padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
.runner-list li div { display: grid; gap: 5px; overflow-wrap: anywhere; }
.runner-list span,.runner-panel small { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.runner-panel form,.runner-panel label,.runner-setup { display: grid; gap: 8px; min-width: 0; }
.runner-panel form { gap: 14px; }
.runner-computer { display: grid; gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
.runner-panel input:not([type=checkbox]),.runner-panel select,.runner-panel textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text-primary); font: inherit; }
.runner-panel .runner-check { display: flex; align-items: center; }
.runner-panel code { overflow-wrap: anywhere; line-height: 1.7; }
.runner-panel .runner-error { color: var(--danger); }
.runner-panel :is(input,select,textarea,button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
