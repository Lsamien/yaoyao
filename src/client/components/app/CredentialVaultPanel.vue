<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { apiRequest } from '@/api/client'
import type { JsonValue } from '@shared/types'
import type { CredentialSummary, CredentialVaultStatus, CredentialOperation } from '@shared/credentialVault'

interface View extends CredentialVaultStatus {
  bots?:{id:string;name:string}[]
  tasks: { workId: string; agentId: string; name: string }[]
  requests: { workId: string; agentId: string; credentialRef: string; operation: CredentialOperation }[]
}
const root='/api/app/vault', state=ref<View>(), busy=ref(false), error=ref(''), notice=ref('')
const master=ref(''), confirmation=ref(''), replacement=ref(''), secret=ref(''), passphrase=ref('')
const name=ref(''), username=ref(''), kind=ref<'website'|'ssh'>('website'), origin=ref(''), host=ref(''), port=ref(22), hostKey=ref('')
const editing=ref<CredentialSummary>(), showEditor=ref(false), taskId=ref(''), credentialId=ref(''), operation=ref<CredentialOperation>('website.login')
const sshAuth=ref<'privateKey'|'password'>('password')
const botId=ref('')
const saveBotId=ref('')
function approvedBots(id:string){return (state.value?.botGrants??[]).filter(g=>g.credentialRef===id).map(g=>state.value?.bots?.find(b=>b.id===g.agentId)?.name??'Bot').join('、')}
const authenticationChanged=computed(()=>editing.value?.target.kind==='ssh'&&kind.value==='ssh'&&sshAuth.value!==(editing.value.target.auth??'privateKey'))
const secretRequired=computed(()=>!editing.value||authenticationChanged.value)
const selectedCredential=computed(()=>state.value?.entries.find(entry=>entry.id===credentialId.value))
const firstSshUse=computed(()=>selectedCredential.value?.target.kind==='ssh'&&!selectedCredential.value.target.hostKey)
const configureUse=ref(false),useKind=ref<'ssh.exec'|'sftp.read'|'sftp.write'>('ssh.exec'),command=ref('/usr/bin/uptime'),remotePath=ref(''),contents=ref(''),maxBytes=ref(65536),clearPassphrase=ref(false)
const loginPath=ref('/login'),submitPath=ref('/login'),successPath=ref('/account'),logoutPath=ref(''),formId=ref('login'),usernameName=ref('username'),passwordName=ref('password'),successSelector=ref('#login-success')
let timer:ReturnType<typeof setInterval>|undefined,alive=true
const inflight=new Set<AbortController>()
function clearSecrets(){master.value='';confirmation.value='';replacement.value='';secret.value='';passphrase.value='';contents.value='';clearPassphrase.value=false}
function failure(cause:unknown){
  const code=cause&&typeof cause==='object'&&'code' in cause?String(cause.code):''
  return ({vault_saved_but_not_granted:'凭据已保存，但 Bot 授权未完成。请刷新后选择 Bot 重新授权。',vault_offline:'密码保险箱连接不可用，请刷新状态或检查数据目录权限。',vault_locked:'密码保险箱已锁定，请重新手动解锁后添加凭据。',vault_unlock_failed:'主密码错误或密码库已损坏，请核对主密码。',vault_invalid_request:'请检查填写内容：主密码至少 12 位，网站使用 HTTPS 地址，SSH 地址和端口需有效。手填指纹时请使用 SHA256 格式。',vault_auth_secret_required:'更换 SSH 认证方式后，请重新填写密码或私钥。',vault_executor_not_enabled:'凭据执行器暂时不可用，请刷新状态或检查服务。',vault_host_probe_failed:'无法连接 SSH 服务器；已保存的密码不受影响，请检查主机地址和端口后重试授权。',vault_host_key_required:'首次使用时请选择确认服务器并授权任务。',vault_host_key_rejected:'服务器身份已改变，已停止连接。请核对服务器后再修改高级设置中的指纹。'} as Record<string,string>)[code]??'操作未完成，请检查连接和主密码；秘密不会回显。'
}
async function request<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',body?:Record<string,JsonValue>){
  const c=new AbortController();inflight.add(c)
  try{return await apiRequest<T>(root+path,{method,...(body?{body}:{}),signal:c.signal,timeoutMs:20000,notifyUnauthorized:false})}
  finally{inflight.delete(c)}
}
async function load(){const value=await request<View>('');if(!alive)return;const wasUnlocked=state.value?.unlocked;state.value=value;if(!value.online||(wasUnlocked&&!value.unlocked)){clearSecrets();showEditor.value=false}}
async function action(work:()=>Promise<void>,message:string){
  if(busy.value)return;busy.value=true;error.value='';notice.value=''
  try{await work();if(alive){notice.value=message;await load()}}
  catch(cause){if(alive){notice.value='';error.value=failure(cause)}}
  finally{clearSecrets();busy.value=false}
}
async function create(){if(master.value!==confirmation.value){error.value='两次主密码不一致';return}await action(async()=>{await request('/initialize','POST',{password:master.value})},'密码库已创建，仍保持锁定')}
async function unlock(){await action(async()=>{await request('/unlock','POST',{password:master.value,seconds:300})},state.value?.storageMode==='local'?'已解锁管理 5 分钟；已授权 Bot 的使用不受此期限影响。':'已手动解锁 5 分钟；Bot 使用凭据仍需要逐任务授权。')}
async function lock(){clearSecrets();showEditor.value=false;await action(async()=>{await request('/lock','POST',{})},state.value?.storageMode==='local'?'管理界面已锁定；已授权 Bot 仍可使用。':'密码库已锁定，任务授权已撤销')}
function edit(entry?:CredentialSummary){
  saveBotId.value=''
  clearSecrets();editing.value=entry;name.value=entry?.name??'';username.value=entry?.username??'';kind.value=entry?.target.kind??'website'
  origin.value=entry?.target.kind==='website'?entry.target.origin:'';host.value=entry?.target.kind==='ssh'?entry.target.host:''
  port.value=entry?.target.kind==='ssh'?entry.target.port:22;hostKey.value=entry?.target.kind==='ssh'?entry.target.hostKey??'':''
  sshAuth.value=entry?.target.kind==='ssh'?entry.target.auth??'privateKey':'password'
  configureUse.value=!!entry?.usage;useKind.value=entry?.usage&&entry.usage.kind!=='website.form'?entry.usage.kind:'ssh.exec'
  command.value=entry?.usage?.kind==='ssh.exec'?entry.usage.command:'/usr/bin/uptime';remotePath.value=entry?.usage&&(entry.usage.kind==='sftp.read'||entry.usage.kind==='sftp.write')?entry.usage.remotePath:''
  maxBytes.value=entry?.usage?.kind==='sftp.read'?entry.usage.maxBytes:65536
  const p=entry?.usage?.kind==='website.form'?entry.usage:undefined
  loginPath.value=p?.loginPath??'/login';submitPath.value=p?.submitPath??'/login';successPath.value=p?.successPath??'/account';logoutPath.value=p?.logoutPath??'';formId.value=p?.formId??'login';usernameName.value=p?.usernameName??'username';passwordName.value=p?.passwordName??'password';successSelector.value=p?.successSelector??'#login-success'
  showEditor.value=true
}
function changeSshAuth(){secret.value='';passphrase.value='';clearPassphrase.value=false}
async function save(){
  if(secretRequired.value&&!secret.value){error.value=authenticationChanged.value?'更换 SSH 认证方式后，请重新填写密码或私钥。':'请填写密码或私钥。';return}
  const target:Record<string,JsonValue>=kind.value==='website'?{kind:'website',origin:origin.value}:{kind:'ssh',host:host.value,port:port.value,...(hostKey.value.trim()?{hostKey:hostKey.value.trim()}:{}),...(sshAuth.value==='password'?{auth:'password'}:{})}
  const usage:Record<string,JsonValue>|undefined=!configureUse.value?undefined:kind.value==='website'?{kind:'website.form',loginPath:loginPath.value,submitPath:submitPath.value,successPath:successPath.value,...(logoutPath.value?{logoutPath:logoutPath.value}:{}),formId:formId.value,usernameName:usernameName.value,passwordName:passwordName.value,successSelector:successSelector.value}:useKind.value==='ssh.exec'?{kind:'ssh.exec',command:command.value}:useKind.value==='sftp.read'?{kind:'sftp.read',remotePath:remotePath.value,maxBytes:maxBytes.value}:{kind:'sftp.write',remotePath:remotePath.value,...(contents.value||!editing.value||editing.value.usage?.kind!=='sftp.write'?{contents:contents.value}:{})}
  const body={name:name.value,username:username.value,target,...(usage?{usage}:{}),...(secret.value?{secret:secret.value}:{}),...(kind.value==='ssh'&&sshAuth.value==='privateKey'?(clearPassphrase.value?{passphrase:''}:passphrase.value?{passphrase:passphrase.value}:{}):{}),...(editing.value?{revision:editing.value.revision}:{})}
  const selectedBot=state.value?.storageMode==='local'&&(configureUse.value||kind.value==='ssh')?saveBotId.value:''
  await action(async()=>{
    const saved=await request<CredentialSummary>(editing.value?'/entries/'+editing.value.id:'/entries',editing.value?'PUT':'POST',body)
    showEditor.value=false
    if(selectedBot){try{await request('/bot-grant','POST',{credentialRef:saved.id,agentId:selectedBot})}catch{throw {code:'vault_saved_but_not_granted'}}}
  },selectedBot?'凭据已加密保存并授权所选 Bot，返回聊天即可使用。':editing.value&&state.value?.storageMode==='local'?'凭据已保存；已授权 Bot 自动使用最新配置。':'凭据已加密保存，密码与私钥不回显')
}
async function remove(entry:CredentialSummary){await action(async()=>{await request('/entries/'+entry.id,'DELETE')},'凭据已删除，相关任务授权已撤销')}
async function grant(){
  const task=state.value?.tasks.find(t=>t.workId===taskId.value);if(!task)return
  await action(async()=>{await request('/leases','POST',{credentialRef:credentialId.value,agentId:task.agentId,workId:task.workId,operation:operation.value,seconds:60})},'已授予此任务 60 秒；只执行已配置的操作，密码与执行正文不回显。')
}
async function grantBot(){await action(async()=>{await request('/bot-grant','POST',{credentialRef:credentialId.value,agentId:botId.value})},'此 Bot 已获持续授权；返回聊天即可使用，直到你撤销。')}
function selectCredential(){const plan=selectedCredential.value?.usage;if(plan)operation.value=plan.kind==='website.form'?'website.login':plan.kind}
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
    <p>秘密只在专用界面录入并加密保存，不发送给 Bot。主密码用于添加、修改凭据和管理授权。</p>
    <p v-if="state?.storageMode==='local'" role="status">选择凭据和 Bot，授权一次即可使用，直到你撤销。关闭管理页、到期或重启服务不会撤销 Bot 授权；操作在夭夭服务器执行，密码不交给模型。</p>
    <p v-else role="status">{{state?.execution==='protected-adapters'?'受控执行器已取得人工部署批准：仅支持配置的标准表单、固定 SSH 命令和指定 SFTP 文件；仍须逐任务授权。':'受控网站与 SSH/SFTP 执行尚未启用。隔离部署批准前，由你人工接管。'}}</p>
    <p v-if="error" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
    <button type="button" :disabled="busy" @click="action(load,'状态已刷新')">刷新状态</button>
    <p v-if="!state?.online">密码保险箱暂时不可用，请检查夭夭数据目录权限；已配置独立密码库时，请检查该服务的私有连接。此处不会自动安装或启动服务。</p>
    <template v-else>
      <p>{{state.unlocked?'已解锁':'已锁定'}}<span v-if="state.unlockExpiresAt"> · {{new Date(state.unlockExpiresAt).toLocaleTimeString()}} 到期</span></p>
      <div v-if="state.storageMode==='local'" class="bot-approvals">
        <p v-if="!state.botGrants?.length">尚未授权任何 Bot。解锁后编辑凭据，选择允许使用的 Bot 并保存。</p>
        <ul v-else><li v-for="g in state.botGrants" :key="g.credentialRef+g.agentId">{{g.name}} → {{state.bots?.find(b=>b.id===g.agentId)?.name??'Bot'}} · 已持续授权<span v-if="g.operation==='ssh.exec'"> · SSH 全部命令</span><button type="button" :disabled="busy||!state.unlocked" @click="action(async()=>{await request('/bot-revoke','POST',{credentialRef:g.credentialRef,agentId:g.agentId})},'Bot 授权已撤销')">撤销 Bot 授权</button></li></ul>
      </div>
      <form v-if="!state.initialized" @submit.prevent="create">
        <label>主密码<input v-model="master" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required :disabled="busy" /></label>
        <label>确认主密码<input v-model="confirmation" type="password" autocomplete="new-password" minlength="12" required :disabled="busy" /></label>
        <p>请妥善保存主密码；没有主密码找回功能。备份只能恢复到身份相同、尚未初始化的密码库。</p>
        <button :disabled="busy">创建密码库</button>
        <label>或恢复加密备份<input type="file" accept=".json,application/json" :disabled="busy||master.length<12" @change="restore" /></label>
      </form>
      <form v-else-if="!state.unlocked" @submit.prevent="unlock">
        <label>主密码<input v-model="master" type="password" autocomplete="off" minlength="12" maxlength="1024" required :disabled="busy" /></label>
        <p>先输入主密码解锁，即可添加和编辑凭据。</p><button :disabled="busy">手动解锁 5 分钟</button>
      </form>
      <template v-else>
        <div class="actions"><button type="button" :disabled="busy" @click="lock">{{state.storageMode==='local'?'锁定管理界面':'立即锁定并撤销授权'}}</button><button type="button" :disabled="busy" @click="edit()">添加凭据</button><button type="button" :disabled="busy" @click="backup">导出加密备份</button></div>
        <ul><li v-for="entry in state.entries" :key="entry.id"><strong>{{entry.name}}</strong><p>{{entry.username}} · {{entry.target.kind==='website'?entry.target.origin:entry.target.host+':'+entry.target.port}}<span v-if="entry.target.kind==='ssh'"> · {{entry.target.auth==='password'?'密码登录':'私钥登录'}}</span></p><p v-if="state.storageMode==='local'">{{approvedBots(entry.id)?'已持续授权：'+approvedBots(entry.id):'未授权给 Bot'}}</p><code>{{entry.id}}</code><div class="actions"><button type="button" :disabled="busy" @click="edit(entry)">编辑</button><button type="button" :disabled="busy" @click="remove(entry)">删除并撤权</button></div></li></ul>
        <form v-if="showEditor" @submit.prevent="save">
          <label>名称<input v-model="name" maxlength="120" required :disabled="busy" /></label>
          <label>用户名<input v-model="username" maxlength="256" autocomplete="off" required :disabled="busy" /></label>
          <label>用途<select v-model="kind" :disabled="busy||!!editing" @change="changeSshAuth"><option value="website">HTTPS 网站</option><option value="ssh">SSH / SFTP</option></select></label>
          <label v-if="kind==='website'">准确网站 origin<input v-model="origin" type="url" placeholder="https://example.com" required :disabled="busy" /></label>
          <label v-else>SSH 主机<input v-model="host" placeholder="IP 地址或域名" required :disabled="busy" /></label>
          <label v-if="kind==='ssh'">SSH 认证方式<select v-model="sshAuth" :disabled="busy" @change="changeSshAuth"><option value="privateKey">私钥登录</option><option value="password">密码登录</option></select></label>
          <label>{{kind==='website'?'密码':sshAuth==='password'?'SSH 登录密码':'私钥'}}<input v-if="kind==='website'||sshAuth==='password'" v-model="secret" type="password" autocomplete="new-password" :required="secretRequired" maxlength="32768" :disabled="busy" /><textarea v-else v-model="secret" autocomplete="off" :required="secretRequired" maxlength="32768" :disabled="busy" /><small v-if="authenticationChanged">认证方式已更换，需要填写新的{{sshAuth==='password'?'登录密码':'私钥'}}。</small><small v-else-if="editing">留空保留原值；没有秘密读取或回显接口。</small></label>
          <label v-if="kind==='ssh'&&sshAuth==='privateKey'">私钥口令（可选）<input v-model="passphrase" type="password" autocomplete="new-password" :disabled="busy" /></label>
          <label v-if="kind==='ssh'&&sshAuth==='privateKey'&&editing" class="checkbox-field"><input v-model="clearPassphrase" type="checkbox" :disabled="busy" />清除原私钥口令（留空输入默认保留）</label>
          <p v-if="kind==='ssh'&&state.storageMode==='local'">授权 Bot 后，允许全部远程 SSH 命令并读取输出，不需要预先填写命令。权限由 SSH 账号决定。</p>
          <details v-if="kind==='ssh'" class="advanced-connection">
            <summary>高级连接设置（可选）</summary>
            <label>端口<input v-model.number="port" type="number" min="1" max="65535" required :disabled="busy" /></label>
            <label>服务器指纹（可选）<input v-model="hostKey" placeholder="SHA256:…" :disabled="busy" /><small>留空即可保存。首次使用会自动获取并记住服务器指纹；已有指纹会继续校验。</small></label>
          </details>
          <label v-if="kind!=='ssh'||state.storageMode!=='local'" class="checkbox-field"><input v-model="configureUse" type="checkbox" :disabled="busy||!!editing?.usage" />配置允许 Bot 执行的固定操作</label>
          <template v-if="configureUse&&kind==='website'">
            <p>仅支持主页面的标准 POST 表单。允许跳转仅限此 origin 的成功页；iframe、跨站 SSO、MFA 或验证码转人工。</p>
            <label>登录页路径<input v-model="loginPath" required :disabled="busy" /></label><label>表单提交路径<input v-model="submitPath" required :disabled="busy" /></label><label>登录成功页路径<input v-model="successPath" required :disabled="busy" /></label>
            <label>退出页路径（可选、仅批准的 GET）<input v-model="logoutPath" :disabled="busy" /></label><p>操作后销毁本地 Cookie；未配置退出页时，远端会话仍按站点规则到期。取消时不追加退出请求。</p>
            <label>表单 HTML id<input v-model="formId" required :disabled="busy" /></label><label>用户名 input name<input v-model="usernameName" required :disabled="busy" /></label><label>密码 input name<input v-model="passwordName" required :disabled="busy" /></label><label>成功标记（#id 或 [data-…]）<input v-model="successSelector" required :disabled="busy" /></label>
          </template>
          <template v-if="configureUse&&kind==='ssh'&&state.storageMode!=='local'">
            <label>允许操作<select v-model="useKind" :disabled="busy"><option value="ssh.exec">固定 SSH 可执行文件</option><option value="sftp.read">SFTP 指定文件读取校验</option><option value="sftp.write">SFTP 创建指定新文件</option></select></label>
            <label v-if="useKind==='ssh.exec'">批准的绝对可执行路径（无参数、无 shell 拼接）<input v-model="command" required :disabled="busy" /></label>
            <label v-else>批准的远端绝对路径<input v-model="remotePath" required :disabled="busy" /></label>
            <label v-if="useKind==='sftp.read'">最大读取字节数<input v-model.number="maxBytes" type="number" min="1" max="1048576" required :disabled="busy" /></label>
            <label v-if="useKind==='sftp.write'">固定写入正文（加密保存；最多 64 KiB）<textarea v-model="contents" maxlength="65536" autocomplete="off" :disabled="busy" /><small v-if="editing?.usage?.kind==='sftp.write'">留空保留原正文，不回显。写入仅创建新文件，不覆盖；中断需人工核对。</small></label>
            <p>首次使用会记住服务器，以后身份改变就停止连接。Bot 只收到退出码或字节数和校验，收不到密码、密钥、输出正文或文件正文。</p>
          </template>
          <template v-if="state.storageMode==='local'&&(configureUse||kind==='ssh')">
            <p v-if="editing&&approvedBots(editing.id)">已持续授权：{{approvedBots(editing.id)}}。修改后继续可用，无需重新授权。</p>
            <label>授权给 Bot<select v-model="saveBotId" :disabled="busy"><option value="">{{editing&&approvedBots(editing.id)?'保留已有授权':'暂不授权'}}</option><option v-for="bot in state.bots??[]" :key="bot.id" :value="bot.id">{{bot.name}}</option></select><small>选择 Bot 后保存即授权，直到你撤销。</small></label>
          </template>
          <div class="actions"><button :disabled="busy">{{saveBotId&&(configureUse||kind==='ssh')?'保存并授权 Bot':'加密保存'}}</button><button type="button" :disabled="busy" @click="showEditor=false;clearSecrets()">取消</button></div>
        </form>
        <form v-if="state.storageMode==='local'" @submit.prevent="grantBot">
          <h4>授权 Bot 使用</h4><p>授权一次，之后直接使用；管理界面锁定、修改凭据或重启服务都不影响授权。</p>
          <label>凭据<select v-model="credentialId" required :disabled="busy" @change="selectCredential"><option disabled value="">请选择</option><option v-for="e in state.entries" :key="e.id" :value="e.id">{{e.name}}</option></select></label>
          <label>Bot<select v-model="botId" required :disabled="busy"><option disabled value="">请选择</option><option v-for="bot in state.bots??[]" :key="bot.id" :value="bot.id">{{bot.name}}</option></select></label>
          <p>{{selectedCredential?.target.kind==='ssh'?'允许全部 SSH 命令并返回输出，Bot 可根据运维任务自行操作；权限由 SSH 账号决定。':'允许操作：'+describeUse(selectedCredential)}}</p>
          <p v-if="firstSshUse">首次使用会自动记住服务器指纹，授权时无需服务器在线。</p>
          <button :disabled="busy||!botId||(!selectedCredential?.usage&&selectedCredential?.target.kind!=='ssh')">授权此 Bot 使用</button>
        </form>
        <form v-else @submit.prevent="grant">
          <h4>本次任务授权</h4><p>先为凭据配置允许 Bot 执行的固定操作，再授权活动任务。每次只绑定一个 Bot、当前任务、执行节点和指定操作；最长 60 秒，不建立长期访问权限。</p>
          <ul><li v-for="pending in state.requests" :key="pending.workId+pending.credentialRef">
            {{state.tasks.find(t=>t.workId===pending.workId)?.name??'任务'}} · {{pending.operation}} · {{pending.credentialRef}}
            <button type="button" :disabled="busy||!state.entries.some(e=>e.id===pending.credentialRef)" @click="selectRequest(pending)">选择此请求，核对后授权</button>
          </li></ul>
          <label>凭据<select v-model="credentialId" required :disabled="busy" @change="selectCredential"><option disabled value="">请选择</option><option v-for="e in state.entries" :key="e.id" :value="e.id">{{e.name}}</option></select></label>
          <label>活动任务<select v-model="taskId" required :disabled="busy"><option disabled value="">请选择</option><option v-for="t in state.tasks" :key="t.workId" :value="t.workId">{{t.name}} · {{t.workId.slice(0,8)}}</option></select></label>
          <label>操作<select v-model="operation" :disabled="busy"><option value="website.login">网站登录</option><option value="ssh.exec">SSH 执行</option><option value="sftp.read">SFTP 读取</option><option value="sftp.write">SFTP 写入</option></select></label>
          <p>批准的使用计划：{{describeUse(selectedCredential)}}</p>
          <p v-if="firstSshUse">首次连接将自动记住这台服务器，之后身份变化会停止连接；无需手填指纹。</p>
          <button :disabled="busy||!state.tasks.length||!selectedCredential?.usage">{{firstSshUse?'确认服务器并授权本任务 60 秒':'授予本任务 60 秒引用权限'}}</button>
        </form>
        <ul><li v-for="lease in state.leases" :key="lease.id">{{lease.workId.slice(0,8)}} · {{lease.operation}} · {{new Date(lease.expiresAt).toLocaleTimeString()}}<button type="button" :disabled="busy" @click="action(async()=>{await request('/leases/'+lease.id,'DELETE')},'任务授权已撤销')">撤销</button></li></ul>
        <form @submit.prevent="rotate"><label>新的主密码<input v-model="replacement" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required :disabled="busy" /></label><button :disabled="busy">轮换主密码与加密密钥并锁定</button></form>
      </template>
      <p v-if="state.requests.length">有 {{state.requests.length}} 个任务等待{{state.storageMode==='local'?'你授权 Bot':'人工解锁或授权'}}。</p>
    </template>
  </section>
</template>

<style scoped>
.advanced-connection{display:grid;gap:12px}.advanced-connection summary{min-height:40px;padding:10px 0;box-sizing:border-box;cursor:pointer;color:var(--text-secondary)}.advanced-connection:not([open])>label{display:none}
.credential-vault label.checkbox-field{display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer}.credential-vault .checkbox-field input{width:18px;min-height:18px;height:18px;flex:0 0 18px;margin:0;padding:0;cursor:inherit}
.credential-vault{display:grid;gap:16px}.credential-vault p{margin:0;color:var(--text-secondary);line-height:1.6}.credential-vault form{display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:12px}.credential-vault label{display:grid;gap:6px}.credential-vault input,.credential-vault textarea,.credential-vault select{width:100%;box-sizing:border-box;min-height:40px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary)}.credential-vault textarea{min-height:120px}.credential-vault button{min-height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text-primary);cursor:pointer}.credential-vault button:disabled{opacity:.55;cursor:default}.credential-vault ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}.credential-vault li{padding:12px;border:1px solid var(--line);border-radius:10px}.credential-vault code{overflow-wrap:anywhere}.credential-vault [role=alert]{color:var(--danger)}.actions{display:flex;flex-wrap:wrap;gap:8px}
</style>
