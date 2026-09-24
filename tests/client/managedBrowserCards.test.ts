import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import Card from '@/components/messages/ManagedBrowserCard.vue'
import Timeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import { workspaceMessagesToUi } from '@/components/workspace/viewModels'
import { WorkspaceTranscriptStore } from '@/components/workspace/transcriptStore'
import { buildMessageTimelineRows } from '@/utils/turnTrace'
import type { ManagedBrowserCard } from '@shared/managedBrowser'
import type { WorkspaceMessage } from '@shared/workspace'

const card:ManagedBrowserCard={id:'browser-session',agentId:'bot',agentName:'竹儿',status:'active',title:'真实网页标题',url:'https://example.com/path',updatedAt:1}
const message:WorkspaceMessage={id:'browser-message',conversationId:'chat',agentId:'bot',agentName:'竹儿',role:'assistant',content:'',reasoning:'',status:'complete',seq:1,createdAt:1,tools:[{id:'tool',name:'managed_browser_open',status:'tool.complete'}],attachments:[],browserCard:card}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

it('preserves a structured browser card through history serialization and trace aggregation',()=>{
  const restored=JSON.parse(JSON.stringify(message)) as WorkspaceMessage
  const [ui]=workspaceMessagesToUi([restored])
  expect(ui?.browserCard).toEqual(card)
  const rows=buildMessageTimelineRows([ui!])
  expect(rows.map(row=>row.kind)).toEqual(['trace','message'])
  expect(rows[1]?.kind==='message'&&rows[1].message.browserCard).toEqual(card)
  expect(workspaceMessagesToUi([{...message,browserCard:undefined,content:JSON.stringify({browserCard:card})}])[0]?.browserCard).toBeUndefined()
})

it('renders browser cards with tools hidden and emits only their structured control target',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}})
  const wrapper=mount(Timeline,{props:{identity:'chat',messages:workspaceMessagesToUi([message]),showTools:false},global:{plugins:[createPinia()],stubs:{AppIcon:true,AgentAvatar:true,MarkdownContent:true}}})
  try{
    await flushPromises()
    expect(wrapper.text()).toContain('真实网页标题')
    expect(wrapper.text()).toContain('https://example.com/path')
    expect(wrapper.find('.turn-trace').exists()).toBe(false)
    await wrapper.get('.managed-browser-card button').trigger('click')
    expect(wrapper.emitted('browserControl')).toEqual([[card]])
    const finished={...message,browserCard:{...card,status:'closed' as const,updatedAt:2}}
    await wrapper.setProps({messages:workspaceMessagesToUi([finished])})
    expect(wrapper.text()).toContain('会话已结束')
    expect(wrapper.get('.managed-browser-card button').text()).toBe('打开此 Bot 的浏览器')
    expect(wrapper.text()).toContain('已关闭或回收的页面不会自动恢复')
    await wrapper.get('.managed-browser-card button').trigger('click')
    expect(wrapper.emitted('browserControl')?.at(-1)).toEqual([finished.browserCard])
  }finally{wrapper.unmount()}
})

it('keeps idle browser cards actionable across tasks and respects read-only history',async()=>{
  const idle={...card,status:'idle' as const}
  const wrapper=mount(Card,{props:{card:idle},global:{stubs:{AppIcon:true}}})
  try{
    expect(wrapper.text()).toContain('页面已保留')
    expect(wrapper.text()).toContain('页面可跨任务继续使用')
    expect(wrapper.text()).toContain('真实网页标题')
    expect(wrapper.text()).toContain('https://example.com/path')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[idle]])
    await wrapper.setProps({readOnly:true})
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.setProps({card:{...card,status:'closed'}})
    expect(wrapper.find('button').exists()).toBe(false)
  }finally{wrapper.unmount()}
})

it('updates a card from server events and preserves it across a fresh transcript snapshot',()=>{
  const conversation={id:'chat',kind:'direct',memberIds:['bot'],lastSeq:1} as any
  const store=new WorkspaceTranscriptStore()
  store.hydrate({agents:[],conversations:[conversation],details:[{conversation,messages:[message],cursor:1,hasOlder:false,run:null,interactions:[],context:null}],cursor:1})
  const changed={...message,browserCard:{...card,status:'preparing' as const,installation:{status:'installing' as const,message:'下载中 60%',progress:60,updatedAt:2},updatedAt:2}}
  store.apply({type:'message.changed',seq:2,conversationId:'chat',data:changed})
  expect(workspaceMessagesToUi(store.get('chat')!.messages)[0]?.browserCard).toEqual(changed.browserCard)
  const snapshot=JSON.parse(JSON.stringify(store.get('chat')))
  const refreshed=new WorkspaceTranscriptStore()
  refreshed.hydrate({agents:[],conversations:[conversation],details:[snapshot],cursor:2})
  expect(workspaceMessagesToUi(refreshed.get('chat')!.messages)[0]?.browserCard?.installation?.progress).toBe(60)
})

it('shows real installation progress, errors and a keyboard-accessible retry',async()=>{
  const wrapper=mount(Card,{props:{card:{...card,status:'preparing',installation:{status:'installing',message:'下载中 45%',progress:45,updatedAt:1}}},global:{stubs:{AppIcon:true}}})
  try{
    expect(wrapper.get('progress').attributes('value')).toBe('45')
    expect(wrapper.get('[role="status"]').text()).toBe('下载中 45%')
    await wrapper.setProps({card:{...card,status:'failed',installation:{status:'failed',message:'安装失败',error:'空间不足',updatedAt:2}}})
    expect(wrapper.get('[role="alert"]').text()).toBe('空间不足')
    expect(wrapper.get('button').text()).toBe('重试并接管浏览器')
    await wrapper.setProps({readOnly:true})
    expect(wrapper.find('button').exists()).toBe(false)
  }finally{wrapper.unmount()}
})
