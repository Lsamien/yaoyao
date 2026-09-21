<script setup lang="ts">
import {computed, onMounted, reactive, ref} from 'vue'
import StandaloneDialog from '@/components/common/StandaloneDialog.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentIdentityPanel from '@/components/app/AgentIdentityPanel.vue'
import ModelServicesPanel from '@/components/app/ModelServicesPanel.vue'
import BotModelSettingsPanel from './BotModelSettingsPanel.vue'
import WorkspaceKnowledgePanel from './WorkspaceKnowledgePanel.vue'
import {apiRequest} from '@/api/client'
import type {WorkspaceAgent, WorkspaceAgentUsage, WorkspaceApprovalPolicy, WorkspaceConversation, WorkspaceSource} from '@shared/workspace'
import type {Profile} from '@shared/types'

interface Draft {name:string;avatar:string;instructions:string;description?:string;job?:string;antiJobs?:string[];voice?:''|'concise'|'casual'|'rigorous'|'custom';voiceCustom?:string;actBias?:''|'ask_first'|'ask_key_then_act'|'act_now';source:string;canManageTeam:boolean;canCollaborate:boolean;memoryEnabled:boolean;approvalPolicy?:WorkspaceApprovalPolicy}
type Page='overview'|'identity'|'rules'|'usage'|'modelSettings'|'models'|'memory'|'permissions'
const props=defineProps<{agent:WorkspaceAgent;draft:Draft;sources:WorkspaceSource[];profiles:Profile[];agents:WorkspaceAgent[];conversations:WorkspaceConversation[];conversationId?:string;isAdmin?:boolean;knowledgeEnabled?:boolean;busy?:boolean;error?:string}>()
const emit=defineEmits<{close:[];save:[draft:Draft & {approvalPolicy:WorkspaceApprovalPolicy}];changed:[]}>()
const draft=reactive({...props.draft,voice:props.draft.voice??'',voiceCustom:props.draft.voiceCustom??'',actBias:props.draft.actBias??'',approvalPolicy:props.draft.approvalPolicy??'ask'})
const page=ref<Page>('overview'),query=ref(''),localError=ref(''),modelDirty=ref(false),modelSaving=ref(false),memoryDirty=ref(false)
const usage=ref<WorkspaceAgentUsage|null>(null),usageLoading=ref(false),usageError=ref('')
const voiceOptions:ReadonlyArray<{value:NonNullable<Draft['voice']>;label:string;description:string}>=[
  {value:'',label:'未指定',description:'由模型根据对话自行判断。'},
  {value:'concise',label:'简洁专业',description:'直接、克制，重点清晰。'},
  {value:'casual',label:'轻松随和',description:'自然亲切，减少正式感。'},
  {value:'rigorous',label:'严谨细致',description:'完整说明依据与边界。'},
  {value:'custom',label:'自定义',description:'使用下方描述的专属语气。'},
]
const actionOptions:ReadonlyArray<{value:NonNullable<Draft['actBias']>;label:string;description:string}>=[
  {value:'',label:'未指定',description:'由模型自行判断。'},
  {value:'ask_first',label:'先问再做',description:'任务不明确先澄清，确认后执行。'},
  {value:'ask_key_then_act',label:'问关键问题即行动',description:'最多问 2–3 个关键问题，职责清楚就开工。'},
  {value:'act_now',label:'直接行动',description:'合理默认即开工，重要分叉才询问。'},
]
const formatTokens=(value:number)=>value.toLocaleString('zh-CN')
onMounted(async()=>{
  usageLoading.value=true
  try{usage.value=await apiRequest<WorkspaceAgentUsage>(`/api/app/agents/${props.agent.id}/usage`)}
  catch{usageError.value='暂时无法读取 Token 用量'}
  finally{usageLoading.value=false}
})
const readOnly=computed(()=>!!props.agent.remoteAgentId)
const antiDraft=ref('')
function addAntiJob(){
 const value=antiDraft.value.trim()
 if(value&&!(draft.antiJobs??[]).includes(value)&&(draft.antiJobs??[]).length<8)draft.antiJobs=[...(draft.antiJobs??[]),value]
 antiDraft.value=''
}
function removeAntiJob(value:string){draft.antiJobs=(draft.antiJobs??[]).filter(item=>item!==value)}
const snapshot=()=>({name:draft.name,avatar:draft.avatar,instructions:draft.instructions,description:draft.description??'',job:draft.job,antiJobs:draft.antiJobs,voice:draft.voice,voiceCustom:draft.voiceCustom,actBias:draft.actBias,source:draft.source,canManageTeam:draft.canManageTeam,canCollaborate:draft.canCollaborate,memoryEnabled:draft.memoryEnabled,approvalPolicy:draft.approvalPolicy})
const baseline=JSON.stringify(snapshot())
const dirty=computed(()=>JSON.stringify(snapshot())!==baseline)
const sourceKey=(source:Pick<WorkspaceSource,'nodeId'|'profile'>)=>JSON.stringify([source.nodeId,source.profile])
const currentSource=computed(()=>props.sources.find(source=>sourceKey(source)===draft.source))
const sourceChanged=computed(()=>draft.source!==sourceKey(props.agent))
const sourceTitle=(source:WorkspaceSource)=>{
  const profile=source.nodeId==='local'?props.profiles.find(profile=>profile.name===source.profile):undefined
  return profile?.agentName||profile?.displayName||source.name
}
const sourceLabel=computed(()=>currentSource.value?sourceTitle(currentSource.value):props.agent.profile)
const sourceProfile=computed(()=>currentSource.value?.profile??props.agent.profile)
const sourceAvatar=computed(()=>currentSource.value?.nodeId==='local'?props.profiles.find(p=>p.name===sourceProfile.value)?.agentAvatar??'':'')
const avatarProfile=computed<Profile>(()=>({name:props.agent.id,agentName:draft.name,displayName:draft.name,agentAvatar:draft.avatar,isDefault:false}))
const allPages=computed(()=>[
  {id:'overview' as const,label:'概览',icon:'panel' as const},
  {id:'identity' as const,label:'身份与头像',icon:'users' as const},
  {id:'rules' as const,label:'角色与规则',icon:'files' as const},
  {id:'usage' as const,label:'Token 用量',icon:'history' as const},
  {id:'modelSettings' as const,label:'模型设置',icon:'model' as const},
  ...(props.isAdmin?[{id:'models' as const,label:'模型与 Provider',icon:'model' as const}]:[]),
  ...(props.knowledgeEnabled&&!readOnly.value?[{id:'memory' as const,label:'记忆',icon:'brain' as const}]:[]),
  {id:'permissions' as const,label:'权限',icon:'settings' as const},
])
const pages=computed(()=>allPages.value.filter(item=>item.label.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const activeTitle=computed(()=>allPages.value.find(item=>item.id===page.value)?.label??'概览')
const environment=computed(()=>'服务端 Hermes · 设备按全局设置开放')
function selectPage(next:Page){
  if(props.busy||modelSaving.value||next===page.value)return
  if(modelDirty.value&&!window.confirm(page.value==='modelSettings'?'放弃当前模型设置未保存的更改？':'放弃当前模型服务未保存的更改？'))return
  if(memoryDirty.value&&!window.confirm('放弃当前记忆未保存的更改？'))return
  modelDirty.value=false;memoryDirty.value=false;localError.value='';page.value=next
}
function beforeClose(){return !props.busy&&!modelSaving.value&&(!(dirty.value||modelDirty.value||memoryDirty.value)||window.confirm('放弃尚未保存的资料更改？'))}
function submit(){
  if(props.busy||modelSaving.value||modelDirty.value||memoryDirty.value)return
  if(!draft.name.trim()){page.value='identity';localError.value='请输入机器人名称';return}
  localError.value='';emit('save',{...snapshot(),name:draft.name.trim()})
}
</script>

<template>
  <StandaloneDialog :title="`编辑资料 · ${agent.name}`" settings :before-close="beforeClose" @close="emit('close')">
    <div class="bot-profile">
      <aside class="bot-profile__sidebar" aria-label="资料分类">
        <label class="profile-search"><AppIcon name="search" :size="16"/><input v-model="query" type="search" aria-label="搜索资料设置" placeholder="搜索设置"/></label>
        <div class="profile-source"><small>基础机器人</small><div class="profile-source__picker"><AgentAvatar :name="sourceLabel" :avatar="sourceAvatar" :size="30"/><span class="profile-source__identity"><strong>{{sourceLabel}}</strong><small>{{sourceProfile}}</small></span><AppIcon name="chevron-down" :size="14"/>
          <select v-model="draft.source" aria-label="基础机器人" :disabled="busy||readOnly||modelDirty||modelSaving"><option v-if="!currentSource" :value="draft.source">{{sourceLabel}} · {{sourceProfile}}</option><option v-for="source in sources" :key="sourceKey(source)" :value="sourceKey(source)">{{sourceTitle(source)}} · {{source.profile}}{{source.nodeId==='local'?'':' · 远端'}}</option></select></div>
        </div>
        <nav aria-label="编辑资料分类"><button v-for="item in pages" :key="item.id" type="button" :aria-current="page===item.id?'page':undefined" :disabled="busy" @click="selectPage(item.id)"><AppIcon :name="item.icon" :size="18"/><span>{{item.label}}</span></button><p v-if="!pages.length">没有匹配的设置</p></nav>
      </aside>
      <main class="bot-profile__main">
        <header class="bot-profile__heading"><h3>{{activeTitle}}</h3><p>正在编辑：{{agent.name}}</p></header>
        <div class="bot-profile__content">
          <p v-if="error||localError" class="profile-error" role="alert">{{error||localError}}</p>
          <p v-if="readOnly" class="profile-note">名称、头像与角色规则由远端管理；审批策略与其他 Bot 一致。</p>
          <template v-if="page==='overview'">
            <section class="profile-card"><div class="profile-who"><AgentAvatar :name="draft.name" :avatar="draft.avatar" :size="52"/><div><h4>{{draft.name}}</h4><p>{{(draft.description??'').trim()||draft.instructions.trim().slice(0,180)||'尚未填写描述。'}}</p></div></div><button type="button" @click="selectPage('identity')">编辑身份与头像</button></section>
            <section class="profile-card"><h4>运行与协作</h4><dl><div><dt>基础机器人</dt><dd>{{sourceLabel}} / {{sourceProfile}}</dd></div><div><dt>执行环境</dt><dd>{{environment}}</dd></div><div><dt>Token 用量</dt><dd>{{usageLoading?'读取中…':usage?`今日 ${formatTokens(usage.todayUsage.total)} · 本月 ${formatTokens(usage.monthUsage.total)}`:'暂无统计'}}</dd></div></dl><button type="button" @click="selectPage('usage')">查看 Token 用量</button></section>
          </template>
          <form v-else-if="page==='identity'" class="profile-form" @submit.prevent="submit"><label>名称<input v-model="draft.name" required maxlength="100" :readonly="readOnly" :disabled="busy"/></label><AgentIdentityPanel v-if="!readOnly" :profile="avatarProfile" embedded :show-name="false" :show-default-model="false" :show-actions="false" :busy="busy" @avatar-change="draft.avatar=$event"/><AgentAvatar v-else :name="draft.name" :avatar="draft.avatar" :size="96"/></form>
          <form v-else-if="page==='rules'" class="profile-form" @submit.prevent="submit">
          <label>描述<textarea v-model="draft.description" rows="3" maxlength="500" :readonly="readOnly" :disabled="busy" placeholder="这个 Bot 是谁、负责什么。每轮都会带上，不替代下面的完整规则。"/></label>
          <label>一句话职责<input v-model="draft.job" maxlength="120" :readonly="readOnly" :disabled="busy" placeholder="这个 Bot 只做的一件事，例如：盯家庭邮箱和日程，表单、账单、RSVP 不漏"/></label>
          <fieldset class="persona-field"><legend>反任务（明确不做的事）</legend>
            <ul v-if="draft.antiJobs?.length" class="anti-list"><li v-for="item in draft.antiJobs" :key="item"><span>{{ item }}</span><button type="button" :disabled="busy||readOnly" @click="removeAntiJob(item)" :aria-label="`移除 ${item}`"><AppIcon name="close" :size="12"/></button></li></ul>
            <div class="anti-input"><input v-model="antiDraft" maxlength="120" :readonly="readOnly" :disabled="busy||(draft.antiJobs?.length??0)>=8" placeholder="例如：绝不直接发送邮件或提交表单" @keydown.enter.prevent="addAntiJob"/><button type="button" :disabled="busy||readOnly||!antiDraft.trim()" @click="addAntiJob">添加</button></div>
          </fieldset>
          <fieldset class="persona-field persona-choice-group"><legend>语气</legend>
            <div class="persona-options">
              <label v-for="option in voiceOptions" :key="option.value" class="radio-row" :class="{selected:draft.voice===option.value}"><input v-model="draft.voice" type="radio" :value="option.value" :disabled="busy||readOnly"/><span><strong>{{option.label}}</strong><small>{{option.description}}</small></span></label>
            </div>
          </fieldset>
          <label v-if="draft.voice==='custom'">自定义语气<textarea v-model="draft.voiceCustom" rows="2" maxlength="200" :readonly="readOnly" :disabled="busy" placeholder="用一句话描述语气，例如：随意一点，像疯狂科学家，多用短句。"/></label>
          <fieldset class="persona-field persona-choice-group"><legend>行动偏好</legend>
            <div class="persona-options">
              <label v-for="option in actionOptions" :key="option.value" class="radio-row" :class="{selected:draft.actBias===option.value}"><input v-model="draft.actBias" type="radio" :value="option.value" :disabled="busy||readOnly"/><span><strong>{{option.label}}</strong><small>{{option.description}}</small></span></label>
            </div>
          </fieldset>
          <details class="persona-advanced"><summary>高级：完整提示词</summary><label>角色提示词与规则<textarea v-model="draft.instructions" rows="10" maxlength="24000" :readonly="readOnly" :disabled="busy" placeholder="描述这个 Bot 的职责、回答方式和工作规则。"/></label><p class="profile-note">结构化规范会自动插入在完整提示词之前；这些规则属于当前 Bot，会在它的单聊和群聊中使用。</p></details>
        </form>
          <template v-else-if="page==='usage'">
            <p v-if="usageError" class="profile-note">{{usageError}}</p>
            <section v-if="usage" class="profile-card">
              <h4>Token 用量</h4>
              <div class="usage-stats">
                <div class="usage-stat"><small>今日（{{usage.today}}）</small><strong>{{formatTokens(usage.todayUsage.total)}}</strong><span>输入 {{formatTokens(usage.todayUsage.input)}} · 输出 {{formatTokens(usage.todayUsage.output)}}</span></div>
                <div class="usage-stat"><small>本月（{{usage.month}}）</small><strong>{{formatTokens(usage.monthUsage.total)}}</strong><span>输入 {{formatTokens(usage.monthUsage.input)}} · 输出 {{formatTokens(usage.monthUsage.output)}}</span></div>
                <div class="usage-stat"><small>累计</small><strong>{{formatTokens(usage.totalUsage.total)}}</strong><span>输入 {{formatTokens(usage.totalUsage.input)}} · 输出 {{formatTokens(usage.totalUsage.output)}}</span></div>
              </div>
            </section>
            <section v-if="usage" class="profile-card">
              <h4>每日明细</h4>
              <p v-if="!usage.daily.length" class="profile-note">还没有记录。与这个 Bot 对话后，这里会按天累计输入和输出的 Token。</p>
              <table v-else class="usage-table"><thead><tr><th>日期</th><th>输入</th><th>输出</th><th>合计</th></tr></thead><tbody><tr v-for="day in usage.daily" :key="day.date"><td>{{day.date}}</td><td>{{formatTokens(day.input)}}</td><td>{{formatTokens(day.output)}}</td><td>{{formatTokens(day.total)}}</td></tr></tbody></table>
            </section>
            <p class="profile-note">用量在每次运行结束时从模型会话统计（输入 + 输出 Token）。从本版本起开始累计；远程 Bot 或个别模型不回报用量时无法统计。</p>
          </template>
          <template v-else-if="page==='modelSettings'">
            <p v-if="readOnly" class="profile-note">该 Bot 的模型设置由远端管理。</p>
            <p v-else-if="sourceChanged" class="profile-note">请先保存基础机器人的变更，再修改模型设置。</p>
            <BotModelSettingsPanel v-else :agent="agent" @dirty-change="modelDirty=$event" @busy-change="modelSaving=$event" @saved="emit('changed')" />
          </template>
          <template v-else-if="page==='models' && isAdmin">
            <p v-if="readOnly||agent.nodeId!=='local'" class="profile-note">模型与 Provider 由远端执行节点管理，请在对应节点配置。</p>
            <p v-else-if="sourceChanged" class="profile-note">请先保存基础机器人的变更，再配置对应的模型与 Provider。</p>
            <template v-else><p class="profile-note">配置来自 {{sourceLabel}} / {{agent.profile}}，使用同一 Profile 的 Bot 共用这些模型服务。</p><ModelServicesPanel :profile="agent.profile" @dirty-change="modelDirty=$event"/></template>
          </template>
          <WorkspaceKnowledgePanel v-else-if="page==='memory' && knowledgeEnabled && !readOnly" :key="agent.id" embedded initial-tab="agent" :selected-agent-id="agent.id" hide-agent-controls :agents="agents" :conversations="conversations" :conversation-id="conversationId" @changed="emit('changed')" @dirty-change="memoryDirty=$event"/>
          <template v-else-if="page==='permissions'">
            <section class="profile-card profile-approval">
              <h4>权限审批</h4>
              <p class="profile-note">所有 Bot 共用全局电脑权限和审批策略。请在应用设置的「电脑与服务端工具」中统一修改。</p>
              <p>当前审批策略：{{ agent.approvalPolicy === 'allow' ? '自动允许' : agent.approvalPolicy === 'deny' ? '自动拒绝' : '询问我' }}</p>
            </section>
            <section v-if="knowledgeEnabled" class="profile-card profile-permissions"><h4>记忆</h4><label><input v-model="draft.memoryEnabled" type="checkbox" :disabled="busy||readOnly"/><span>自动记录长期事实<small>保存到当前 Bot 的独立记忆。组队、建 Bot 和看见同伴默认可用，不需要单独开启。</small></span></label></section>
          </template>
        </div>
        <footer class="bot-profile__footer"><span v-if="modelDirty||memoryDirty">请先保存或取消当前编辑</span><span v-else-if="dirty">有未保存的更改</span><button type="button" :disabled="busy||modelSaving" @click="beforeClose()&&emit('close')">关闭</button><button type="button" class="profile-save" :disabled="busy||modelSaving||!dirty||modelDirty||memoryDirty" @click="submit">{{busy?'正在保存…':'保存更改'}}</button></footer>
      </main>
    </div>
  </StandaloneDialog>
</template>

<style scoped>
.profile-approval{gap:12px}.profile-approval .profile-note{margin:0}.profile-approval>label{display:flex;align-items:flex-start;gap:10px;padding:10px 0;font-size:14px;cursor:pointer}.profile-approval input{width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)}.profile-approval small{display:block;margin-top:4px;font-size:12px;line-height:1.6;color:var(--text-secondary)}
.bot-profile{display:grid;grid-template-columns:208px minmax(0,1fr);height:100%;min-height:0;color:var(--text-primary)}.bot-profile__sidebar{min-height:0;overflow:auto;padding:16px 12px;background:var(--settings-sidebar);border-right:1px solid var(--line)}.profile-search{display:flex;gap:8px;align-items:center;background:var(--settings-panel);border:1px solid var(--line);border-radius:8px;padding:0 10px;height:38px}.profile-search input{width:100%;min-width:0;border:0;background:transparent;outline:0;color:inherit;font:13px var(--font-ui)}.profile-search:focus-within{outline:2px solid var(--accent);outline-offset:2px}.profile-source{margin:16px 0;padding-bottom:16px;border-bottom:1px solid var(--line)}.profile-source>small{display:block;margin-bottom:8px;color:var(--text-muted);font-size:11px}.profile-source>div{display:flex;align-items:center;gap:9px;margin-bottom:10px}.profile-source span{display:grid;gap:2px;min-width:0}.profile-source strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}.profile-source small{font-size:11px;color:var(--text-secondary)}.profile-source select{width:100%;min-height:36px;padding:6px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:inherit;font:12px var(--font-ui)}nav{display:grid;gap:4px}nav button{display:flex;align-items:center;gap:12px;min-height:44px;padding:9px 12px;border:0;border-radius:8px;background:transparent;text-align:left;color:inherit;font:500 13px var(--font-ui);cursor:pointer}nav button[aria-current=page]{background:var(--settings-selected);font-weight:600}nav button:hover{background:var(--surface-hover)}nav p{font-size:13px;color:var(--text-secondary)}.bot-profile__main{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0;min-height:0}.bot-profile__heading{padding:20px 24px 16px}.bot-profile h3{margin:0;font-size:17px}.bot-profile__heading p{margin:5px 0 0;color:var(--text-secondary);font-size:12px}.bot-profile__content{min-height:0;overflow:auto;padding:0 24px 24px;overscroll-behavior:contain}.profile-card{display:grid;gap:16px;padding:20px;margin-bottom:16px;background:var(--settings-panel);border-radius:12px}.profile-card h4{margin:0;font-size:15px;font-weight:600}.profile-who{display:flex;align-items:flex-start;gap:16px}.profile-who>div{min-width:0}.profile-who p{margin:6px 0 0;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.profile-card>button{justify-self:start}.profile-card dl{margin:0}.profile-card dl>div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:12px;padding:10px 0;border-top:1px solid var(--line);font-size:13px}.profile-card dt{color:var(--text-secondary)}.profile-card dd{margin:0;overflow-wrap:anywhere}.profile-form{display:grid;gap:20px}.profile-form>label{display:grid;gap:8px;font-size:14px}.profile-form input,.profile-form textarea{box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;color:inherit;background:var(--surface);font:14px var(--font-ui)}.profile-form textarea{resize:vertical;line-height:1.7}.profile-note{font-size:13px;line-height:1.7;color:var(--text-secondary);margin:0 0 16px}.profile-error{padding:12px;border-radius:9px;color:var(--danger);background:var(--settings-panel);font-size:13px;line-height:1.6}.profile-permissions>label{display:flex;align-items:flex-start;gap:10px;padding:12px 0;border-top:1px solid var(--line);font-size:14px}.profile-permissions input{width:18px;height:18px;accent-color:var(--accent);flex-shrink:0}.profile-permissions small{display:block;margin-top:6px;color:var(--text-secondary);font-size:12px;line-height:1.6}.bot-profile__footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 24px;border-top:1px solid var(--line)}.bot-profile__footer>span{flex:1;font-size:12px;color:var(--text-muted)}.bot-profile__footer button,.profile-card>button{min-height:38px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;color:inherit;background:var(--surface);font:13px var(--font-ui);cursor:pointer}.bot-profile__footer .profile-save{background:var(--accent);color:var(--text-on-solid);border:0}.bot-profile button:disabled{cursor:default;opacity:.45}.bot-profile button:focus-visible,.bot-profile input:focus-visible,.bot-profile select:focus-visible,.bot-profile textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:600px){.bot-profile{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.bot-profile__sidebar{padding:10px 12px;border-right:0;border-bottom:1px solid var(--line);overflow:visible}.profile-search{display:none}.profile-source{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:8px;margin:0 0 10px;padding:0;border:0}.profile-source>small{display:none}.profile-source>div{margin:0}.bot-profile nav{display:flex;overflow:auto;gap:4px}.bot-profile nav button{white-space:nowrap;flex-shrink:0;gap:6px;min-height:44px;padding-inline:10px}.bot-profile__heading{padding:16px 20px}.bot-profile__content{padding:0 20px 20px}.bot-profile__footer{padding:12px 20px}.bot-profile__footer>span{display:none}}
</style>
<style scoped>
.bot-profile__sidebar{min-width:0}@media(max-width:600px){.bot-profile{grid-template-columns:minmax(0,1fr)}}
.usage-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.usage-stat{display:grid;gap:6px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.usage-stat small{color:var(--text-muted);font-size:11px}.usage-stat strong{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}.usage-stat span{color:var(--text-secondary);font-size:11px}.usage-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}.usage-table th{color:var(--text-muted);font-weight:500;text-align:right;padding:6px 4px;border-bottom:1px solid var(--line)}.usage-table th:first-child,.usage-table td:first-child{text-align:left}.usage-table td{padding:7px 4px;border-bottom:1px solid var(--line);text-align:right}.usage-table td:first-child{color:var(--text-secondary)}
.profile-source .profile-source__picker{position:relative;min-height:48px;padding:6px 8px;margin:0;border:1px solid var(--line);border-radius:8px;background:var(--settings-panel);box-sizing:border-box}.profile-source__identity{flex:1}.profile-source__picker>select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.profile-source__picker:focus-within{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:600px){.profile-source{display:block}.profile-source .profile-source__picker{max-width:100%}}
.persona-field{display:grid;gap:8px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0}
.persona-field legend{font-size:12.5px;color:var(--text-secondary);padding:0 4px}
.anti-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.anti-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface-soft)}
.anti-list li button{border:0;background:transparent;min-height:24px;padding:2px;cursor:pointer;color:var(--text-muted)}
.anti-input{display:flex;gap:8px}
.anti-input input{flex:1}
.persona-choice-group{gap:10px;padding:12px;background:color-mix(in srgb,var(--surface-soft) 55%,transparent)}
.persona-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.radio-row{display:flex;align-items:flex-start;gap:10px;min-width:0;min-height:66px;padding:11px 12px;box-sizing:border-box;border:1px solid var(--line);border-radius:9px;background:var(--surface);cursor:pointer;transition:border-color 140ms ease,background-color 140ms ease,box-shadow 140ms ease}
.radio-row:hover:not(:has(input:disabled)){border-color:var(--line-strong);background:var(--surface-raised)}
.radio-row.selected{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 7%,var(--surface));box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 16%,transparent)}
.radio-row:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}.radio-row input:focus-visible{outline:none}
.radio-row:has(input:disabled){cursor:default;opacity:.55}
.radio-row input{width:16px;height:16px;min-height:16px;margin:2px 0 0;padding:0;accent-color:var(--accent);flex:none}
.radio-row span{display:grid;gap:4px;min-width:0}
.radio-row strong{font-size:13px;line-height:1.35;font-weight:600;color:var(--text-primary)}
.radio-row small{font-size:11.5px;line-height:1.5;color:var(--text-muted)}
.persona-advanced summary{cursor:pointer;font-size:13px;color:var(--text-secondary);margin-bottom:8px}
@media(max-width:600px){.persona-options{grid-template-columns:1fr}.radio-row{min-height:60px}}
@media(prefers-reduced-motion:reduce){.radio-row{transition:none}}
</style>
