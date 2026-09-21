// Browser-only visual fixture. All /api requests stay in memory; no user data is changed.
import {createApp, defineComponent, h, ref} from 'vue'
import {createPinia} from 'pinia'
import BotSettingsDialog from '@/components/workspace/BotSettingsDialog.vue'
import BotProfileDialog from '@/components/workspace/BotProfileDialog.vue'
import SettingsCenterDialog from '@/components/app/SettingsCenterDialog.vue'
import {useAuthStore} from '@/stores/auth'
import '@/styles/tokens.css'
import '@/styles/global.css'

const query=new URLSearchParams(location.search)
if(query.get('view')==='desktop-mode'){
  let mode:'client'|'server'='client'
  window.yaoyaoDesktop={
    modeState:async()=>({mode,serverURL:mode==='client'?'http://192.168.1.200:15300':'http://127.0.0.1:15300',switching:false}),
    switchMode:async next=>{mode=next;return {ok:true}},openRemoteLogin:async()=>{},
    openComputer:async()=>false,computerClosed:async()=>{},onComputerClose:()=>()=>{},
  }
}
const names=['测试2','竹儿','测试','瑶儿']
const agents=names.map((name,i)=>({id:`00000000-0000-4000-8000-00000000000${i+1}`,name,profile:'default',nodeId:'local',archived:false,avatar:'',instructions:'协助整理项目资料，检查问题并给出清晰、简洁的建议。',execution:'computer',canManageTeam:false,canCollaborate:true,memoryEnabled:true,createdAt:1,updatedAt:1}))
const conversations=[{id:'group-a',name:'方案分析团队',kind:'group',memberIds:agents.map(a=>a.id),archived:false},{id:'group-b',name:'内容运营组',kind:'group',memberIds:agents.slice(0,3).map(a=>a.id),archived:false}]
const projects=query.has('empty')?[]:[
  {id:'project-a',name:'夭夭产品开发',description:'',memberIds:agents.map(a=>a.id),groupIds:['group-a','group-b'],revision:1,archived:false,createdAt:1,updatedAt:1},
  {id:'project-b',name:'内容运营',description:'',memberIds:agents.slice(0,3).map(a=>a.id),groupIds:['group-b'],revision:1,archived:false,createdAt:1,updatedAt:1},
]
const identity={serverId:'00000000-0000-4000-8000-000000000099',name:'我的工作空间',displayName:'我的工作空间',revision:1}
const desktopHosts=[
  {id:'f184922a-713c-4190-9c46-6e200e6c4c01',name:'LSamienacStudio',displayName:'',enabled:true,online:false,createdAt:Date.parse('2026-09-10T09:30:00+08:00')},
  {id:'c791ba30-f185-4734-8e72-549bc02e7e02',name:'LSamienacStudio',displayName:'',enabled:true,online:true,createdAt:Date.parse('2026-09-19T18:05:00+08:00')},
]
let localComputerName=''
const realFetch=window.fetch.bind(window)
window.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href)
  if(!url.pathname.startsWith('/api/'))return realFetch(input,init)
  const body=typeof init?.body==='string'?JSON.parse(init.body):{}
  let data:unknown
  if(url.pathname==='/api/app/capabilities')data={features:['bot-file-memory-v1']}
  else if(url.pathname==='/api/app/bootstrap')data={csrfToken:'fixture-only',userId:'fixture-user',authRequired:true}
  else if(url.pathname==='/api/app/agents')data={agents}
  else if(url.pathname==='/api/app/conversations')data={conversations}
  else if(url.pathname==='/api/app/models')data={provider:'custom',model:'GPT-5.6-terra',providers:[{slug:'custom',name:'Custom endpoint',models:['GPT-5.6-terra'],is_current:true}]}
  else if(url.pathname==='/api/app/admin/legacy-model-services')data={items:[]}
  else if(url.pathname.startsWith('/api/app/admin/model-services'))data={endpoints:[],services:[],current:{provider:'custom',model:'GPT-5.6-terra',base_url:''}}
  else if(url.pathname==='/api/app/workspace/projects'){
    if(init?.method==='POST'){
      const previous=projects.find(p=>p.id===body.id)
      const project={...body,id:body.id??crypto.randomUUID(),revision:(previous?.revision??0)+1,createdAt:1,updatedAt:1}
      if(previous)Object.assign(previous,project);else projects.push(project)
      data={project}
    }else data={projects}
  }else if(url.pathname.includes('/memory-jobs'))data={jobs:[]}
  else if(url.pathname.includes('/memories'))data={memories:[]}
  else if(url.pathname.includes('server-identity'))data=identity
  else if(url.pathname==='/api/app/computers')data={computers:[]}
  else if(url.pathname==='/api/app/settings/host-tools')data={approvalPolicy:'allow',scriptMachine:true,serverComputer:true,vm:true,cloud:true,...body}
  else if(url.pathname==='/api/app/admin/desktop-hosts')data={hosts:desktopHosts,localName:localComputerName}
  else if(url.pathname.startsWith('/api/app/admin/desktop-hosts/')){
    const id=url.pathname.split('/')[5]
    const host=desktopHosts.find(item=>item.id===id)
    if(init?.method==='PUT'&&url.pathname.endsWith('/name')){
      if(id==='local')localComputerName=body.name
      else if(host)host.displayName=body.name
    }else if(init?.method==='DELETE'&&host)host.enabled=false
    data={ok:true}
  }
  else if(url.pathname==='/api/app/admin/local-vm')data={configured:true,enabled:true,mode:'shared',maxInstances:2,idleStopMinutes:0,runtime:'docker',daemonUp:true,image:true,images:[{key:'standard',ready:true},{key:'cursor',ready:true}],instances:[]}
  else return new Response(JSON.stringify({error:{message:'此预览没有连接服务'}}),{status:404,headers:{'content-type':'application/json'}})
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
}
const theme=ref<'light'|'dark'|'system'>(query.get('theme')==='dark'?'dark':'light')
function setTheme(value:'light'|'dark'|'system'){theme.value=value;document.documentElement.classList.toggle('dark',value==='dark')}
setTheme(theme.value)
const App=defineComponent({setup(){
  const auth=useAuthStore()
  auth.user={id:'fixture-user',username:'samien',role:query.has('member')?'member':'admin'} as never
  auth.status='authenticated';auth.serverIdentity=identity
  const opened=ref<'bot'|'personal'|'editor'|null>(query.get('view')==='editor'?'editor':['bubbles','appearance','profile','desktop-mode'].includes(query.get('view')??'')?'personal':'bot')
  return()=>h('main',{style:'min-height:100dvh;background:var(--settings-panel);padding:18px;box-sizing:border-box'},[
    h('div',{style:'display:flex;gap:12px;align-items:center;font:13px var(--font-ui)'},[
      h('span','界面验证 · 示例数据'),h('button',{onClick:()=>opened.value='bot'},'Bot 设置'),h('button',{onClick:()=>opened.value='personal'},'我的设置'),h('button',{onClick:()=>opened.value='editor'},'编辑资料'),
    ]),
    opened.value==='bot'?h(BotSettingsDialog,{isAdmin:!query.has('member'),initialPage:query.get('view')==='computers'?'computers':'projects',onClose:()=>opened.value=null}):null,
    opened.value==='editor'?h(BotProfileDialog,{agent:agents[0],draft:{...agents[0],source:'["local","default"]'},sources:[{nodeId:'local',profile:'default',name:'丫头'}],profiles:[{name:'default',agentName:'丫头',isDefault:true}],agents,conversations,conversationId:'fixture-chat',isAdmin:!query.has('member'),knowledgeEnabled:true,onClose:()=>opened.value=null,onSave:()=>opened.value=null} as never):null,
    h(SettingsCenterDialog,{open:opened.value==='personal',initialPage:query.get('view')==='bubbles'?'chat-appearance':query.get('view')==='desktop-mode'?'desktop-mode':query.get('view')==='profile'?'account-profile':'appearance',isAdmin:!query.has('member'),botMode:true,userName:'samien',theme:theme.value==='dark'?'dark':'light',themePreference:theme.value,profiles:[{name:'default',agentName:'默认机器人',isDefault:true}],activeProfile:{name:'default',agentName:'默认机器人',isDefault:true},onClose:()=>opened.value=null,'onSet-theme':setTheme}),
  ])
}})
createApp(App).use(createPinia()).mount('#app')
