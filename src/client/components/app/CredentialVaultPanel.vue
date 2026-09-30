<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { apiRequest } from '@/api/client'
import type { JsonValue } from '@shared/types'
import type { CredentialSummary, CredentialVaultStatus, CredentialOperation } from '@shared/credentialVault'

interface View extends CredentialVaultStatus {
  tasks: { workId: string; agentId: string; name: string }[]
  requests: { workId: string; agentId: string; credentialRef: string; operation: CredentialOperation }[]
}
const root='/api/app/vault', state=ref<View>(), busy=ref(false), error=ref(''), notice=ref('')
const master=ref(''), confirmation=ref(''), replacement=ref(''), secret=ref(''), passphrase=ref('')
const name=ref(''), username=ref(''), kind=ref<'website'|'ssh'>('website'), origin=ref(''), host=ref(''), port=ref(22), hostKey=ref('')
const editing=ref<CredentialSummary>(), showEditor=ref(false), taskId=ref(''), credentialId=ref(''), operation=ref<CredentialOperation>('website.login')
const configureUse=ref(false),useKind=ref<'ssh.exec'|'sftp.read'|'sftp.write'>('ssh.exec'),command=ref('/usr/bin/uptime'),remotePath=ref(''),contents=ref(''),maxBytes=ref(65536),clearPassphrase=ref(false)
const loginPath=ref('/login'),submitPath=ref('/login'),successPath=ref('/account'),logoutPath=ref(''),formId=ref('login'),usernameName=ref('username'),passwordName=ref('password'),successSelector=ref('#login-success')
let timer:ReturnType<typeof setInterval>|undefined,alive=true
const inflight=new Set<AbortController>()
function clearSecrets(){master.value='';confirmation.value='';replacement.value='';secret.value='';passphrase.value='';contents.value='';clearPassphrase.value=false}
async function request<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',body?:Record<string,JsonValue>){
  const c=new AbortController();inflight.add(c)
  try{return await apiRequest<T>(root+path,{method,...(body?{body}:{}),signal:c.signal,timeoutMs:20000})}
  finally{inflight.delete(c)}
}
async function load(){const value=await request<View>('');if(!alive)return;const wasUnlocked=state.value?.unlocked;state.value=value;if(!value.online||(wasUnlocked&&!value.unlocked)){clearSecrets();showEditor.value=false}}
async function action(work:()=>Promise<void>,message:string){
  if(busy.value)return;busy.value=true;error.value='';notice.value=''
  try{await work();if(alive){notice.value=message;await load()}}
  catch{if(alive)error.value='操作未完成，请检查连接、主密码和本任务授权；秘密不会回显。'}
  finally{clearSecrets();busy.value=false}
}
async function create(){if(master.value!==confirmation.value){error.value='两次主密码不一致';return}await action(async()=>{await request('/initialize','POST',{password:master.value})},'密码库已创建，仍保持锁定')}
async function unlock(){await action(async()=>{await request('/unlock','POST',{password:master.value,seconds:300})},'已手动解锁 5 分钟；任务仍需要逐次授权')}
async function lock(){clearSecrets();showEditor.value=false;await action(async()=>{await request('/lock','POST',{})},'密码库已锁定，任务授权已撤销')}
function edit(entry?:CredentialSummary){
  clearSecrets();editing.value=entry;name.value=entry?.name??'';username.value=entry?.username??'';kind.value=entry?.target.kind??'website'
  origin.value=entry?.target.kind==='website'?entry.target.origin:'';host.value=entry?.target.kind==='ssh'?entry.target.host:''
  port.value=entry?.target.kind==='ssh'?entry.target.port:22;hostKey.value=entry?.target.kind==='ssh'?entry.target.hostKey:''
  configureUse.value=!!entry?.usage;useKind.value=entry?.usage&&entry.usage.kind!=='website.form'?entry.usage.kind:'ssh.exec'
  command.value=entry?.usage?.kind==='ssh.exec'?entry.usage.command:'/usr/bin/uptime';remotePath.value=entry?.usage&&(entry.usage.kind==='sftp.read'||entry.usage.kind==='sftp.write')?entry.usage.remotePath:''
  maxBytes.value=entry?.usage?.kind==='sftp.read'?entry.usage.maxBytes:65536
  const p=entry?.usage?.kind==='website.form'?entry.usage:undefined
  loginPath.value=p?.loginPath??'/login';submitPath.value=p?.submitPath??'/login';successPath.value=p?.successPath??'/account';logoutPath.value=p?.logoutPath??'';formId.value=p?.formId??'login';usernameName.value=p?.usernameName??'username';passwordName.value=p?.passwordName??'password';successSelector.value=p?.successSelector??'#login-success'
  showEditor.value=true
}
async function save(){
  const target:Record<string,JsonValue>=kind.value==='website'?{kind:'website',origin:origin.value}:{kind:'ssh',host:host.value,port:port.value,hostKey:hostKey.value}
  const usage:Record<string,JsonValue>|undefined=!configureUse.value?undefined:kind.value==='website'?{kind:'website.form',loginPath:loginPath.value,submitPath:submitPath.value,successPath:successPath.value,...(logoutPath.value?{logoutPath:logoutPath.value}:{}),formId:formId.value,usernameName:usernameName.value,passwordName:passwordName.value,successSelector:successSelector.value}:useKind.value==='ssh.exec'?{kind:'ssh.exec',command:command.value}:useKind.value==='sftp.read'?{kind:'sftp.read',remotePath:remotePath.value,maxBytes:maxBytes.value}:{kind:'sftp.write',remotePath:remotePath.value,...(contents.value||!editing.value||editing.value.usage?.kind!=='sftp.write'?{contents:contents.value}:{})}
  const body={name:name.value,username:username.value,target,...(usage?{usage}:{}),...(secret.value?{secret:secret.value}:{}),...(clearPassphrase.value?{passphrase:''}:passphrase.value?{passphrase:passphrase.value}:{}),...(editing.value?{revision:editing.value.revision}:{})}
  await action(async()=>{await request(editing.value?'/entries/'+editing.value.id:'/entries',editing.value?'PUT':'POST',body);showEditor.value=false},'凭据已加密保存，密码与私钥不回显')
}
async function remove(entry:CredentialSummary){await action(async()=>{await request('/entries/'+entry.id,'DELETE')},'凭据已删除，相关任务授权已撤销')}
async function grant(){
  const task=state.value?.tasks.find(t=>t.workId===taskId.value);if(!task)return
  await action(async()=>{await request('/leases','POST',{credentialRef:credentialId.value,agentId:task.agentId,workId:task.workId,operation:operation.value,seconds:60})},'已授予此任务 60 秒；只允许已配置的操作，隔离未批准时不会执行')
}
function selectRequest(value:View['requests'][number]){taskId.value=value.workId;credentialId.value=value.credentialRef;operation.value=value.operation}
function describeUse(entry?:CredentialSummary){const p=entry?.usage;if(!p)return '尚未配置，将转人工接管';if(p.kind==='website.form')return '网站表单 '+p.loginPath+' → '+p.submitPath+' → '+p.successPath+(p.logoutPath?' → 退出 '+p.logoutPath:'（远端会话按站点规则到期）');if(p.kind==='ssh.exec')return 'SSH '+p.command+'，固定无参数';return p.kind==='sftp.read'?'SFTP 读取校验 '+p.remotePath+'，最多 '+p.maxBytes+' 字节':'SFTP 创建新文件 '+p.remotePath+'，'+p.bytes+' 字节'}
async function backup(){
  await action(async()=>{
    const data=await request<{archive:string}>('/backup','POST',{});if(!alive)return
    const url=URL.createObjectURL(new Blob([data.archive],{type:'application/json'})),a=document.createElement('a')
    a.href=url;a.download='yaoyao-vault-encrypted-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0)
  },'加密备份已导出；需要导出时的主密码恢复')
}
async function restore(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return
  if(file.size>2*1024*1024){error.value='备份文件超过大小限制';input.value='';return}
  try{await action(async()=>{const archive=await file.text();if(!alive)return;await request('/restore','POST',{archive,password:master.value})},'备份已验证并恢复，仍保持锁定')}
  finally{input.value=''}
}
async function rotate(){await action(async()=>{await request('/rotate','POST',{password:replacement.value})},'主密码与加密密钥已轮换，密码库已锁定；旧备份仍使用旧主密码')}
function abandonAndLock(){
  clearSecrets();showEditor.value=false
  for(const c of inflight)c.abort();inflight.clear()
  if(state.value?.unlocked||busy.value)void apiRequest(root+'/lock',{method:'POST',body:{},timeoutMs:5000}).catch(()=>{})
}
function hidden(){if(document.hidden)abandonAndLock()}
onMounted(async()=>{
  try{await load()}catch{error.value='无法读取执行节点密码库状态'}
  timer=setInterval(()=>{if(alive&&!busy.value)void load().catch(()=>{state.value=undefined;clearSecrets()})},3000)
  document.addEventListener('visibilitychange',hidden)
})
onBeforeUnmount(()=>{
  alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',hidden);abandonAndLock()
  state.value=undefined
})
</script>

<template>
  <section class="credential-vault" :aria-busy="busy">
    <p>秘密只在专用界面录入，加密保存在 Hermes 执行节点；不发送给 Bot。密码库默认锁定，重启或到期需重新手动解锁。</p>
    <p role="status">{{state?.execution==='protected-adapters'?'受控执行器已取得人工部署批准：仅支持配置的标准表单、固定 SSH 命令和指定 SFTP 文件；仍须逐任务授权。':'受控网站与 SSH/SFTP 执行尚未启用。隔离部署批准前，由你人工接管。'}}</p>
    <p v-if="error" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
    <button type="button" :disabled="busy" @click="action(load,'状态已刷新')">刷新状态</button>
    <p v-if="!state?.online">执行节点密码库离线或尚未配置。需要管理员先批准独立服务身份和私有连接；此处不会自动安装或启动服务。</p>
    <template v-else>
      <p>{{state.unlocked?'已解锁':'已锁定'}}<span v-if="state.unlockExpiresAt"> · {{new Date(state.unlockExpiresAt).toLocaleTimeString()}} 到期</span></p>
      <form v-if="!state.initialized" @submit.prevent="create">
        <label>主密码<input v-model="master" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required :disabled="busy" /></label>
        <label>确认主密码<input v-model="confirmation" type="password" autocomplete="new-password" minlength="12" required :disabled="busy" /></label>
        <p>请妥善保存主密码；没有主密码找回功能。备份只能恢复到身份相同、尚未初始化的密码库。</p>
        <button :disabled="busy">创建密码库</button>
        <label>或恢复加密备份<input type="file" accept=".json,application/json" :disabled="busy||master.length<12" @change="restore" /></label>
      </form>
      <form v-else-if="!state.unlocked" @submit.prevent="unlock">
        <label>主密码<input v-model="master" type="password" autocomplete="off" minlength="12" maxlength="1024" required :disabled="busy" /></label>
        <button :disabled="busy">手动解锁 5 分钟</button>
      </form>
      <template v-else>
        <div class="actions"><button type="button" :disabled="busy" @click="lock">立即锁定并撤销授权</button><button type="button" :disabled="busy" @click="edit()">添加凭据</button><button type="button" :disabled="busy" @click="backup">导出加密备份</button></div>
        <ul><li v-for="entry in state.entries" :key="entry.id"><strong>{{entry.name}}</strong><p>{{entry.username}} · {{entry.target.kind==='website'?entry.target.origin:entry.target.host+':'+entry.target.port}}</p><code>{{entry.id}}</code><div class="actions"><button type="button" :disabled="busy" @click="edit(entry)">编辑</button><button type="button" :disabled="busy" @click="remove(entry)">删除并撤权</button></div></li></ul>
        <form v-if="showEditor" @submit.prevent="save">
          <label>名称<input v-model="name" maxlength="120" required :disabled="busy" /></label>
          <label>用户名<input v-model="username" maxlength="256" autocomplete="off" required :disabled="busy" /></label>
          <label>用途<select v-model="kind" :disabled="busy||!!editing"><option value="website">HTTPS 网站</option><option value="ssh">SSH 密钥 / SFTP</option></select></label>
          <label v-if="kind==='website'">准确网站 origin<input v-model="origin" type="url" placeholder="https://example.com" required :disabled="busy" /></label>
          <template v-else><label>SSH 主机<input v-model="host" required :disabled="busy" /></label><label>端口<input v-model.number="port" type="number" min="1" max="65535" required :disabled="busy" /></label><label>已人工确认的 host key 指纹<input v-model="hostKey" placeholder="SHA256:…" required :disabled="busy" /></label></template>
          <label>{{kind==='website'?'密码':'私钥'}}<input v-if="kind==='website'" v-model="secret" type="password" autocomplete="new-password" :required="!editing" maxlength="32768" :disabled="busy" /><textarea v-else v-model="secret" autocomplete="off" :required="!editing" maxlength="32768" :disabled="busy" /><small v-if="editing">留空保留原值；没有秘密读取或回显接口。</small></label>
          <label v-if="kind==='ssh'">私钥口令（可选）<input v-model="passphrase" type="password" autocomplete="new-password" :disabled="busy" /></label>
          <label v-if="kind==='ssh'&&editing"><input v-model="clearPassphrase" type="checkbox" :disabled="busy" />清除原私钥口令（留空输入默认保留）</label>
          <label><input v-model="configureUse" type="checkbox" :disabled="busy||!!editing?.usage" />配置允许 Bot 执行的固定操作</label>
          <template v-if="configureUse&&kind==='website'">
            <p>仅支持主页面的标准 POST 表单。允许跳转仅限此 origin 的成功页；iframe、跨站 SSO、MFA 或验证码转人工。</p>
            <label>登录页路径<input v-model="loginPath" required :disabled="busy" /></label><label>表单提交路径<input v-model="submitPath" required :disabled="busy" /></label><label>登录成功页路径<input v-model="successPath" required :disabled="busy" /></label>
            <label>退出页路径（可选、仅批准的 GET）<input v-model="logoutPath" :disabled="busy" /></label><p>操作后销毁本地 Cookie；未配置退出页时，远端会话仍按站点规则到期。取消时不追加退出请求。</p>
            <label>表单 HTML id<input v-model="formId" required :disabled="busy" /></label><label>用户名 input name<input v-model="usernameName" required :disabled="busy" /></label><label>密码 input name<input v-model="passwordName" required :disabled="busy" /></label><label>成功标记（#id 或 [data-…]）<input v-model="successSelector" required :disabled="busy" /></label>
          </template>
          <template v-if="configureUse&&kind==='ssh'">
            <label>允许操作<select v-model="useKind" :disabled="busy"><option value="ssh.exec">固定 SSH 可执行文件</option><option value="sftp.read">SFTP 指定文件读取校验</option><option value="sftp.write">SFTP 创建指定新文件</option></select></label>
            <label v-if="useKind==='ssh.exec'">批准的绝对可执行路径（无参数、无 shell 拼接）<input v-model="command" required :disabled="busy" /></label>
            <label v-else>批准的远端绝对路径<input v-model="remotePath" required :disabled="busy" /></label>
            <label v-if="useKind==='sftp.read'">最大读取字节数<input v-model.number="maxBytes" type="number" min="1" max="1048576" required :disabled="busy" /></label>
            <label v-if="useKind==='sftp.write'">固定写入正文（加密保存；最多 64 KiB）<textarea v-model="contents" maxlength="65536" autocomplete="off" :disabled="busy" /><small v-if="editing?.usage?.kind==='sftp.write'">留空保留原正文，不回显。写入仅创建新文件，不覆盖；中断需人工核对。</small></label>
            <p>仅密钥认证，固定 host key；不转发 Agent/端口。Bot 只收到退出码或字节数和校验，收不到输出正文、密钥或文件正文。</p>
          </template>
          <div class="actions"><button :disabled="busy">加密保存</button><button type="button" :disabled="busy" @click="showEditor=false;clearSecrets()">取消</button></div>
        </form>
        <form @submit.prevent="grant">
          <h4>本次任务授权</h4><p>仅绑定一个 Bot、当前任务、执行节点和指定操作；最长 60 秒，不建立长期访问权限。</p>
          <ul><li v-for="pending in state.requests" :key="pending.workId+pending.credentialRef">
            {{state.tasks.find(t=>t.workId===pending.workId)?.name??'任务'}} · {{pending.operation}} · {{pending.credentialRef}}
            <button type="button" :disabled="busy||!state.entries.some(e=>e.id===pending.credentialRef)" @click="selectRequest(pending)">选择此请求，核对后授权</button>
          </li></ul>
          <label>凭据<select v-model="credentialId" required :disabled="busy"><option disabled value="">请选择</option><option v-for="e in state.entries" :key="e.id" :value="e.id">{{e.name}}</option></select></label>
          <label>活动任务<select v-model="taskId" required :disabled="busy"><option disabled value="">请选择</option><option v-for="t in state.tasks" :key="t.workId" :value="t.workId">{{t.name}} · {{t.workId.slice(0,8)}}</option></select></label>
          <label>操作<select v-model="operation" :disabled="busy"><option value="website.login">网站登录</option><option value="ssh.exec">SSH 执行</option><option value="sftp.read">SFTP 读取</option><option value="sftp.write">SFTP 写入</option></select></label>
          <p>批准的使用计划：{{describeUse(state.entries.find(e=>e.id===credentialId))}}</p>
          <button :disabled="busy||!state.tasks.length||!state.entries.length">授予本任务 60 秒引用权限</button>
        </form>
        <ul><li v-for="lease in state.leases" :key="lease.id">{{lease.workId.slice(0,8)}} · {{lease.operation}} · {{new Date(lease.expiresAt).toLocaleTimeString()}}<button type="button" :disabled="busy" @click="action(async()=>{await request('/leases/'+lease.id,'DELETE')},'任务授权已撤销')">撤销</button></li></ul>
        <form @submit.prevent="rotate"><label>新的主密码<input v-model="replacement" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required :disabled="busy" /></label><button :disabled="busy">轮换主密码与加密密钥并锁定</button></form>
      </template>
      <p v-if="state.requests.length">有 {{state.requests.length}} 个任务等待人工解锁或授权；不会自动登录。</p>
    </template>
  </section>
</template>

<style scoped>
.credential-vault{display:grid;gap:16px}.credential-vault p{margin:0;color:var(--text-secondary);line-height:1.6}.credential-vault form{display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:12px}.credential-vault label{display:grid;gap:6px}.credential-vault input,.credential-vault textarea,.credential-vault select{width:100%;box-sizing:border-box;min-height:40px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary)}.credential-vault textarea{min-height:120px}.credential-vault button{min-height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);cursor:pointer}.credential-vault button:disabled{opacity:.55;cursor:default}.credential-vault ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}.credential-vault li{padding:12px;border:1px solid var(--line);border-radius:10px}.credential-vault code{overflow-wrap:anywhere}.credential-vault [role=alert]{color:var(--danger)}.actions{display:flex;flex-wrap:wrap;gap:8px}
</style>
