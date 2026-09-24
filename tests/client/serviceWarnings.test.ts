import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import WorkspaceTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import { workspaceMessagesToUi } from '@/components/workspace/viewModels'
import { WorkspaceTranscriptStore } from '@/components/workspace/transcriptStore'
import { buildMessageTimelineRows } from '@/utils/turnTrace'
import type { WorkspaceMessage } from '@shared/workspace'

const warning={code:'plugin_unavailable',service:'天气服务',message:'连接暂不可用，本次任务继续使用其他能力。'}
const message:WorkspaceMessage={id:'warning-message',conversationId:'chat',agentId:'bot',agentName:'竹儿',role:'assistant',content:'',reasoning:'',status:'complete',seq:1,createdAt:1,tools:[{id:'tool',name:'天气服务',status:'tool.complete'}],attachments:[],serviceWarnings:[warning]}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

it('keeps warning-only messages visible independently of tool trace aggregation and model text',()=>{
  const [ui]=workspaceMessagesToUi([JSON.parse(JSON.stringify(message))])
  expect(ui?.serviceWarnings).toEqual([warning])
  expect(ui?.status).toBe('settled')
  expect(ui?.error).toBeUndefined()
  const rows=buildMessageTimelineRows([ui!])
  expect(rows.map(row=>row.kind)).toEqual(['trace','message'])
  expect(rows[1]?.kind==='message'&&rows[1].message.serviceWarnings).toEqual([warning])
  const [textOnly]=workspaceMessagesToUi([{...message,serviceWarnings:undefined,content:JSON.stringify({serviceWarnings:[warning]})}])
  expect(textOnly?.serviceWarnings).toBeUndefined()
})

it.each(['workspace','session'])('shows non-blocking, escaped service notices with tools hidden in the %s timeline',async(timeline)=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}})
  const scrollTo=HTMLElement.prototype.scrollTo
  HTMLElement.prototype.scrollTo=vi.fn()
  const unsafe={code:'plugin_unavailable',service:'<img src=x onerror="alert(1)">',message:'<script>alert(2)</script> [修复](javascript:alert(3))'}
  const messages=workspaceMessagesToUi([{...message,serviceWarnings:[warning,unsafe]}])
  const wrapper=mount(timeline==='workspace'?WorkspaceTimeline:MessageTimeline,{props:{identity:'chat',messages,showTools:false},global:{plugins:[createPinia()],stubs:{AppIcon:true,AgentAvatar:true,MarkdownContent:{props:['content'],template:'<div class="fixture-content">{{content}}</div>'}}}})
  try{
    await flushPromises()
    const notices=wrapper.get('[aria-label="服务状态提示"]')
    expect(notices.findAll('[role="status"]')).toHaveLength(2)
    expect(notices.text()).toContain(`${warning.service}：${warning.message}`)
    expect(notices.text()).toContain(`${unsafe.service}：${unsafe.message}`)
    expect(notices.find('img,script,a,[role="alert"],details').exists()).toBe(false)
    expect(wrapper.find('.turn-trace').exists()).toBe(false)
    expect(wrapper.find('.message-failure').exists()).toBe(false)
    await wrapper.setProps({messages:workspaceMessagesToUi([{...message,status:'streaming',content:'正在继续处理任务。'}])})
    expect(wrapper.text()).toContain('正在继续处理任务。')
    expect(wrapper.get('[aria-label="服务状态提示"]').text()).toContain(warning.message)
  }finally{wrapper.unmount();HTMLElement.prototype.scrollTo=scrollTo}
})

it('retains service warnings from live transcript events through a history reload',()=>{
  const conversation={id:'chat',kind:'direct',memberIds:['bot'],lastSeq:1} as any
  const store=new WorkspaceTranscriptStore()
  store.hydrate({agents:[],conversations:[conversation],details:[{conversation,messages:[],cursor:0,hasOlder:false,run:null,interactions:[],context:null}],cursor:0})
  store.apply({type:'message.changed',seq:1,conversationId:'chat',data:message})
  expect(workspaceMessagesToUi(store.get('chat')!.messages)[0]?.serviceWarnings).toEqual([warning])
  const refreshed=new WorkspaceTranscriptStore()
  refreshed.hydrate({agents:[],conversations:[conversation],details:[JSON.parse(JSON.stringify(store.get('chat')))],cursor:1})
  const messages=workspaceMessagesToUi(refreshed.get('chat')!.messages)
  expect(messages[0]?.serviceWarnings).toEqual([warning])
  expect(buildMessageTimelineRows(messages).some(row=>row.kind==='message'&&row.message.id===message.id)).toBe(true)
})
