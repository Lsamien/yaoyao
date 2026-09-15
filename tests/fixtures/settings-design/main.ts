// Browser-only visual fixture. All /api requests stay in memory; no user data is changed.
import {createApp, defineComponent, h, ref} from 'vue'
import {createPinia} from 'pinia'
import BotSettingsDialog from '@/components/workspace/BotSettingsDialog.vue'
import SettingsCenterDialog from '@/components/app/SettingsCenterDialog.vue'
import {useAuthStore} from '@/stores/auth'
import '@/styles/tokens.css'
import '@/styles/global.css'

const query=new URLSearchParams(location.search)
const names=['测试2','竹儿','测试','瑶儿']
const agents=names.map((name,i)=>({id:`00000000-0000-4000-8000-00000000000${i+1}`,name,profile:'default',nodeId:'local',archived:false}))
const conversations=[{id:'group-a',name:'方案分析团队',kind:'group',memberIds:agents.map(a=>a.id),archived:false},{id:'group-b',name:'内容运营组',kind:'group',memberIds:agents.slice(0,3).map(a=>a.id),archived:false}]
const projects=query.has('empty')?[]:[
  {id:'project-a',name:'夭夭产品开发',description:'',memberIds:agents.map(a=>a.id),groupIds:['group-a','group-b'],revision:1,archived:false,createdAt:1,updatedAt:1},
  {id:'project-b',name:'内容运营',description:'',memberIds:agents.slice(0,3).map(a=>a.id),groupIds:['group-b'],revision:1,archived:false,createdAt:1,updatedAt:1},
]
const identity={serverId:'00000000-0000-4000-8000-000000000099',name:'我的工作空间',displayName:'我的工作空间',revision:1}
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
  const opened=ref<'bot'|'personal'|null>(query.get('view')==='appearance'||query.get('view')==='profile'?'personal':'bot')
  return()=>h('main',{style:'min-height:100dvh;background:var(--settings-panel);padding:18px;box-sizing:border-box'},[
    h('div',{style:'display:flex;gap:12px;align-items:center;font:13px var(--font-ui)'},[
      h('span','界面验证 · 示例数据'),h('button',{onClick:()=>opened.value='bot'},'Bot 设置'),h('button',{onClick:()=>opened.value='personal'},'我的设置'),
    ]),
    opened.value==='bot'?h(BotSettingsDialog,{isAdmin:!query.has('member'),onClose:()=>opened.value=null}):null,
    h(SettingsCenterDialog,{open:opened.value==='personal',initialPage:query.get('view')==='profile'?'account-profile':'appearance',isAdmin:!query.has('member'),botMode:true,userName:'samien',theme:theme.value==='dark'?'dark':'light',themePreference:theme.value,profiles:[{name:'default',agentName:'默认机器人',isDefault:true}],activeProfile:{name:'default',agentName:'默认机器人',isDefault:true},onClose:()=>opened.value=null,'onSet-theme':setTheme}),
  ])
}})
createApp(App).use(createPinia()).mount('#app')
