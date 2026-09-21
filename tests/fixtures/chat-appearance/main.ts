// Uses real chat renderers with local sample data only.
import {createApp, defineComponent, h, ref} from 'vue'
import {createPinia} from 'pinia'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import ChatAppearancePanel from '@/components/app/ChatAppearancePanel.vue'
import type {UiMessage} from '@/components/messages/types'
import '@/styles/tokens.css'
import '@/styles/global.css'
const messages: UiMessage[] = [
  {id:'user',role:'user',content:'帮我整理今天的工作重点。',status:'settled'},
  {id:'assistant',role:'assistant',author:'夭夭助手',content:'当然，我们先聚焦三件事。\n\n## 今天的重点\n\n1. **梳理需求**，明确聊天气泡的颜色与样式。\n2. 确认桌面和手机上的阅读体验。\n3. 检查切换预设、恢复默认和重新打开应用。\n\n下面这段代码和说明也应保持清晰：\n\n```typescript\nconst theme = "codex"\nconsole.log(theme)\n```\n\n行内代码 `theme`、[文档链接](https://example.com) 和长段落都保持在同一个助手气泡内。',status:'settled'},
]
const App=defineComponent({setup(){
  const dark=ref(false),settings=ref(false),bot=ref(true)
  return ()=>h('main',{class:{dark:dark.value},style:'height:100dvh;background:var(--surface);color:var(--text-primary);display:flex;flex-direction:column'},[
    h('header',{style:'padding:14px;display:flex;gap:12px;border-bottom:1px solid var(--line)'},[
      h('button',{onClick:()=>settings.value=!settings.value},settings.value?'返回聊天':'聊天气泡设置'),
      h('button',{onClick:()=>{dark.value=!dark.value;document.documentElement.classList.toggle('dark',dark.value)}},dark.value?'切换浅色':'切换深色'),
      h('button',{onClick:()=>bot.value=!bot.value},bot.value?'Bot 模式':'普通聊天'),
    ]),
    settings.value?h('div',{style:'overflow:auto;padding:24px'},[h(ChatAppearancePanel,{theme:dark.value?'dark':'light'})])
    :h(bot.value?WorkspaceMessageTimeline:MessageTimeline,{messages,identity:'bubble-fixture',readOnly:true,title:'气泡样式验证',style:'flex:1;min-height:0'}),
  ])
}})
createApp(App).use(createPinia()).mount('#app')
