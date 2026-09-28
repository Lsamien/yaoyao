<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {apiRequest} from '@/api/client'
import {createUuid} from '@/utils/id'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'
import type {CodexAuthorizationAttempt, ExecutionSettingsView, SystemResourceSummary} from '@shared/executionEnvironment'

const props=defineProps<{resource?:SystemResourceSummary; agents:ExecutionSettingsView['agents']}>()
const emit=defineEmits<{close:[]; saved:[]}>()
const root='/api/app/admin/execution', deviceUrl='https://auth.openai.com/codex/device'
const name=ref(props.resource?.name??''),kind=ref(props.resource?.kind??'codex')
const agentIds=ref([...(props.resource?.agentIds??[])]),baseUrl=ref(props.resource?.baseUrl??'')
const values=ref(''),token=ref(''),tokenEnv=ref(props.resource?.tokenEnv??''),authJson=ref(''),fileName=ref('')
const method=ref<'browser'|'file'>('browser'),attempt=ref<CodexAuthorizationAttempt>()
const busy=ref(false),starting=ref(false),reading=ref(false),error=ref(''),errorBox=ref<HTMLElement>()
const pending=computed(()=>['starting','pending'].includes(attempt.value?.status??''))
const canSave=computed(()=>!busy.value&&!starting.value&&!reading.value&&!pending.value&&(kind.value!=='codex'||!!props.resource||(method.value==='browser'?attempt.value?.status==='authorized':!!authJson.value)))
let timer:ReturnType<typeof setTimeout>|undefined,closed=false,generation=0
async function fail(message:string){error.value=message;await nextTick();errorBox.value?.focus()}
async function cancelRequest(id:string){try{await apiRequest(root+'/codex-auth/'+id,{method:'DELETE'})}catch{/* Server expiry also clears abandoned login attempts. */}}
function abandon(){generation++;clearTimeout(timer);const id=attempt.value?.id;attempt.value=undefined;starting.value=false;if(id)void cancelRequest(id)}
function close(){if(busy.value)return;abandon();emit('close')}
function schedule(id:string,version:number){
  clearTimeout(timer)
  if(!closed&&version===generation&&pending.value)timer=setTimeout(()=>poll(id,version),1500)
}
async function poll(id:string,version:number){
  try{
    const result=await apiRequest<CodexAuthorizationAttempt>(root+'/codex-auth/'+id)
    if(closed||version!==generation)return
    attempt.value=result;error.value=''
  }catch(e){if(!closed&&version===generation)error.value=e instanceof Error?e.message:'无法读取授权状态，请重试'}
  schedule(id,version)
}
async function begin(){
  if(busy.value||starting.value)return
  abandon();error.value=''
  const id=createUuid(),version=generation
  starting.value=true;attempt.value={id,status:'starting',expiresAt:Date.now()+15*60_000}
  // Open during the click, before awaiting the server; desktop clients route this to the system browser.
  window.open(deviceUrl,'_blank','noopener,noreferrer,popup,width=640,height=760')
  try{
    const result=await apiRequest<CodexAuthorizationAttempt>(root+'/codex-auth',{method:'POST',body:{requestId:id}})
    if(closed||version!==generation){void cancelRequest(id);return}
    attempt.value=result;schedule(id,version)
  }catch(e){if(!closed&&version===generation){abandon();void cancelRequest(id);await fail(e instanceof Error?e.message:'无法开始授权')}}
  finally{if(version===generation)starting.value=false}
}
function validateFile(content:string){
  try{const data=JSON.parse(content);if(!data||Array.isArray(data)||typeof data!=='object'||!(typeof data.OPENAI_API_KEY==='string'&&data.OPENAI_API_KEY||typeof data.tokens?.access_token==='string'&&data.tokens.access_token))throw new Error()}
  catch{throw new Error('请选择有效的 Codex auth.json 授权文件')}
  if(new TextEncoder().encode(content).length>64000)throw new Error('授权文件不能超过 64 KB')
}
async function readFile(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return
  authJson.value='';fileName.value='';error.value='';reading.value=true
  const version=generation
  try{if(file.size>64000)throw new Error('授权文件不能超过 64 KB');const content=await file.text();validateFile(content);if(!closed&&version===generation){authJson.value=content;fileName.value=file.name}}
  catch(e){if(!closed&&version===generation)await fail(e instanceof Error?e.message:'无法读取授权文件')}
  finally{reading.value=false;input.value=''}
}
async function save(){
  if(!canSave.value)return
  busy.value=true;error.value=''
  try{
    let variables:Record<string,string>|undefined
    if(values.value.trim()){
      try{variables=JSON.parse(values.value);if(!variables||Array.isArray(variables)||typeof variables!=='object')throw new Error()}
      catch{throw new Error('环境变量需要 JSON 对象，例如 {"MY_API_KEY":"值"}')}
    }
    if(kind.value==='codex'&&method.value==='file'&&authJson.value)validateFile(authJson.value)
    const body={name:name.value,kind:kind.value,agentIds:agentIds.value,revision:props.resource?.revision??0,
      ...(variables?{variables}:{}),
      ...(kind.value==='api'?{baseUrl:baseUrl.value,...(token.value?{token:token.value}:{}),tokenEnv:tokenEnv.value}:{}),
      ...(kind.value==='codex'&&method.value==='file'&&authJson.value?{authJson:authJson.value}:{}),
      ...(kind.value==='codex'&&method.value==='browser'&&attempt.value?.status==='authorized'?{authAttemptId:attempt.value.id}:{})}
    await apiRequest(root+'/resources'+(props.resource?'/'+props.resource.id:''),{method:props.resource?'PUT':'POST',body})
    attempt.value=undefined;authJson.value='';token.value='';values.value='';emit('saved')
  }catch(e){await fail(e instanceof Error?e.message:'保存授权失败')}
  finally{busy.value=false}
}
watch([kind,method],()=>{abandon();authJson.value='';fileName.value='';error.value=''})
onBeforeUnmount(()=>{closed=true;abandon();authJson.value='';token.value='';values.value=''})
</script>

<template>
  <StandaloneDialog :title="resource?'编辑授权':'添加授权'" :before-close="()=>!busy" @close="close">
    <form class="resource-editor" :aria-busy="busy" @submit.prevent="save">
      <p v-if="error" ref="errorBox" role="alert" tabindex="-1">{{error}}</p>
      <label>授权类型<select v-model="kind" :disabled="busy||!!resource"><option value="codex">Codex 账号登录</option><option value="api">API 服务</option><option value="variables">环境变量</option></select></label>
      <template v-if="kind==='codex'">
        <div class="methods" role="group" aria-label="登录方式"><button type="button" :aria-pressed="method==='browser'" :disabled="busy" @click="method='browser'">浏览器授权（推荐）</button><button type="button" :aria-pressed="method==='file'" :disabled="busy" @click="method='file'">导入授权文件</button></div>
        <p v-if="resource">已有登录会保留；完成新授权并保存后才会替换。</p>
        <section v-if="method==='browser'" class="login-card" aria-label="浏览器授权">
          <p>打开浏览器登录 ChatGPT，输入本次授权码。完成后此窗口会自动更新。</p>
          <p v-if="attempt?.status==='starting'" role="status">正在获取授权码…</p>
          <div v-if="attempt?.status==='pending'" class="device-code" role="status"><span>在浏览器中输入授权码</span><strong>{{attempt.userCode}}</strong><small>有效期至 {{new Date(attempt.expiresAt).toLocaleTimeString('zh-CN')}}，仅用于你主动发起的本次登录。</small></div>
          <p v-if="attempt?.status==='authorized'" role="status">浏览器授权成功。选择允许使用的 Bot，然后保存授权。</p>
          <p v-if="attempt?.error||attempt?.status==='expired'||attempt?.status==='cancelled'" role="alert">{{attempt.error||(attempt.status==='expired'?'授权已过期，请重新登录。':'授权已取消，请重新登录。')}}</p>
          <div class="actions">
            <template v-if="pending"><a :href="deviceUrl" target="_blank" rel="noopener noreferrer">打开浏览器继续授权</a><button type="button" :disabled="busy" @click="abandon">取消本次登录</button></template>
            <button v-else type="button" :disabled="busy" @click="begin">{{attempt?.status==='authorized'?'重新登录':'打开浏览器授权'}}</button>
          </div>
          <p class="hint">账号需在 ChatGPT 安全设置中允许设备码登录。浏览器窗口未打开时，可点击“打开浏览器继续授权”。</p>
        </section>
        <section v-else class="login-card" aria-label="授权文件导入">
          <label>选择授权文件<input type="file" accept=".json,application/json" :disabled="busy||reading" @change="readFile"></label>
          <p v-if="fileName" role="status">已读取 {{fileName}}</p>
          <details><summary>或粘贴 auth.json 内容</summary><label>Codex auth.json<textarea v-model="authJson" autocomplete="off" spellcheck="false" :disabled="busy" :placeholder="resource?'留空保留原登录':'粘贴 Codex auth.json 内容'" /></label></details>
        </section>
        <p class="hint">登录供获授权 Bot 的虚拟机 Codex CLI 使用。登录失效时可重新浏览器授权或导入文件。</p>
      </template>
      <template v-if="kind==='api'"><label>服务根地址<input v-model="baseUrl" type="url" placeholder="https://api.example.com/v1/" required :disabled="busy"></label><label>API 授权令牌<input v-model="token" type="password" autocomplete="new-password" :required="!resource" :placeholder="resource?'留空保留原授权':''" :disabled="busy"></label><label>提供给脚本的变量名（可选）<input v-model="tokenEnv" placeholder="例如 XAI_API_KEY" :disabled="busy"></label><p>使用该服务发行的 API 凭据。Grok Bot 云登录与通用生图 API 授权用途不同。</p></template>
      <label>名称<input v-model="name" required maxlength="80" placeholder="例如：工作账号" :disabled="busy"></label>
      <label>环境变量 JSON{{resource?'（留空保留原值）':''}}<textarea v-model="values" autocomplete="off" spellcheck="false" placeholder='{"MY_API_KEY":"值"}' :disabled="busy" /></label>
      <fieldset :disabled="busy"><legend>允许使用的 Bot</legend><p v-if="!agents.length">创建 Bot 后可回来授予权限。</p><label v-for="agent in agents" :key="agent.id" class="check"><input v-model="agentIds" type="checkbox" :value="agent.id">{{agent.name}} <small>账号 {{agent.owner}}</small></label></fieldset>
      <p class="hint">登录凭据加密保存在当前服务器；只有勾选的 Bot 可以使用。</p>
      <div class="actions"><button type="submit" :disabled="!canSave">保存授权</button><button type="button" :disabled="busy" @click="close">取消</button></div>
    </form>
  </StandaloneDialog>
</template>

<style scoped>
.resource-editor{display:grid;gap:16px;max-width:640px;margin:auto;font-size:14px}.resource-editor p{margin:0;line-height:1.65;color:var(--text-secondary);overflow-wrap:anywhere}.resource-editor label{display:grid;gap:8px}.resource-editor input,.resource-editor select,.resource-editor textarea,.resource-editor button,.resource-editor a{min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);font:inherit;max-width:100%;box-sizing:border-box}.resource-editor textarea{min-height:90px;resize:vertical;width:100%}.resource-editor button,.resource-editor a,.resource-editor summary{cursor:pointer}.resource-editor a{text-decoration:none;display:inline-flex;align-items:center}.resource-editor :disabled{opacity:.6;cursor:default}.resource-editor :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.resource-editor [role=alert]{color:var(--danger)}.methods,.actions{display:flex;gap:10px;flex-wrap:wrap}.methods button{flex:1}.methods [aria-pressed=true]{border-color:var(--accent);background:var(--surface-soft);font-weight:600}.login-card{display:grid;gap:14px;background:var(--settings-panel);border:1px solid var(--line);border-radius:12px;padding:18px}.device-code{display:grid;gap:8px}.device-code strong{font:600 28px var(--font-mono,monospace);letter-spacing:.08em}.device-code small,.hint{font-size:12px;color:var(--text-secondary)}.resource-editor fieldset{border:1px solid var(--line);border-radius:8px;min-width:0}.resource-editor .check{display:flex;align-items:center;gap:10px;min-height:44px;flex-wrap:wrap}.check input{min-height:20px;width:20px;height:20px}.resource-editor summary{min-height:44px;align-content:center}@media(max-width:600px){.login-card{padding:14px}.methods button{flex-basis:100%}}
</style>
