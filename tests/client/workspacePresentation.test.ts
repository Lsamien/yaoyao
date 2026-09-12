import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuid } from '@/utils/id'
import { workspaceMessagesToUi } from '@/components/workspace/viewModels'

afterEach(() => vi.unstubAllGlobals())
describe('workspace chat uses the established presentation', () => {
  it('creates valid request ids on LAN HTTP without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { for (let i=0;i<bytes.length;i++) bytes[i]=i; return bytes } })
    expect(createUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('preserves role identity, reasoning, files and tools for MessageTimeline', () => {
    const [message] = workspaceMessagesToUi([{id:'m',conversationId:'c',seq:1,role:'assistant',agentId:'a',agentName:'编辑',content:'[报告](/tmp/report.txt)',reasoning:'检查资料',status:'complete',createdAt:10,attachments:[{id:'f',name:'report.txt',mimeType:'text/plain',size:4,createdAt:10,sender:'agent',sourcePath:'/tmp/report.txt'}],tools:[{id:'t',name:'read_file',status:'tool.complete',result:'ok'}]}])
    expect(message).toMatchObject({profile:'a',author:'编辑',reasoning:'检查资料',status:'settled',content:'[报告](/api/app/files/f/download)'})
    expect(message?.tools?.[0]).toMatchObject({name:'read_file',status:'success',output:'ok'})
    expect(message?.attachments?.[0]?.url).toBe('/api/app/files/f/download')
  })
})

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConversationList from '@/components/workspace/ConversationList.vue'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import type { WorkspaceAgent, WorkspaceConversation } from '../../src/shared/workspace'

it('renders Bot unread as a dot and treats explicit false as authoritative over legacy counts', async () => {
  const conversation: WorkspaceConversation = { id: 'dot', kind: 'direct', name: '未读测试', avatar: '', memberIds: [], instructions: '', administratorId: '', mode: 'host', autoReplyIds: [], maxReplyRounds: 1, archived: false, pinned: false, readSeq: 0, lastSeq: 999, unreadCount: 999, unread: true, preview: '完成', createdAt: 1, updatedAt: 1 }
  const wrapper = mount(ConversationList, { props: { conversations: [conversation], agents: [] } })
  expect(wrapper.find('[aria-label="未读"]').exists()).toBe(true)
  expect(wrapper.find('.sidebar-item__row b').exists()).toBe(false)
  await wrapper.setProps({ conversations: [{ ...conversation, unread: false }] })
  expect(wrapper.find('[aria-label="未读"]').exists()).toBe(false)
  await wrapper.setProps({ conversations: [{ ...conversation, unread: undefined }] })
  expect(wrapper.find('[aria-label="未读"]').exists()).toBe(true)
  wrapper.unmount()
})

it('composes real member avatars and refreshes them without changing group membership', async () => {
  const agents: WorkspaceAgent[] = ['first','second'].map((id,index) => ({id,name:id,avatar:`yaoyao-mascot:v1:${index ? 'square' : 'circle'}:377fe6:friendly`,instructions:'',nodeId:'local',profile:'default',archived:false,revision:1,createdAt:1,updatedAt:1}))
  const c: WorkspaceConversation = {id:'g',kind:'group',name:'群聊',avatar:'data:image/png;base64,AA==',memberIds:['second','first'],instructions:'',administratorId:'first',mode:'host',autoReplyIds:[],maxReplyRounds:1,archived:false,pinned:false,readSeq:0,lastSeq:0,preview:'',createdAt:Date.now(),updatedAt:Date.now(),lastMessageAt:Date.now()}
  const wrapper = mount(ConversationList, {props:{conversations:[c],agents}})
  expect(wrapper.getComponent(TeamAvatar).props('members')!.map((m: {name:string}) => m.name)).toEqual(['second','first'])
  expect(wrapper.findAll('.team-avatar__member')).toHaveLength(2)
  expect(wrapper.find('.team-avatar__image').exists()).toBe(false)
  expect(wrapper.find('.sidebar-item__row small').text()).toMatch(/\d{2}:\d{2}/)
  await wrapper.setProps({agents:agents.map(a=>a.id==='first'?{...a,avatar:'yaoyao-mascot:v1:triangle:d94b52:curious'}:a)})
  expect(wrapper.getComponent(TeamAvatar).props('members')![1]!.avatar).toBe('yaoyao-mascot:v1:triangle:d94b52:curious')
  await wrapper.setProps({conversations:[{...c,activeRunId:'run',activeAgentId:'second',activeRunStatus:'running'}]})
  expect(wrapper.findAll('.team-avatar__member.agent-avatar--working')).toHaveLength(1)
  expect(wrapper.find('.team-avatar__member--1').classes()).toContain('agent-avatar--working')
  await wrapper.setProps({conversations:[{...c,activeRunId:'run',activeAgentId:'second',activeRunStatus:'waiting'}]})
  expect(wrapper.findAll('.team-avatar__member.agent-avatar--waiting')).toHaveLength(1)
  await wrapper.setProps({conversations:[c]})
  expect(wrapper.findAll('.team-avatar__member.agent-avatar--working')).toHaveLength(0)
  expect(wrapper.findAll('.team-avatar__member.agent-avatar--waiting')).toHaveLength(0)
  await wrapper.setProps({conversations:[{...c,kind:'direct',memberIds:['first'],activeRunId:'direct-run',activeAgentId:'first',activeRunStatus:'running'}]})
  expect(wrapper.find('.sidebar-item__icon .agent-avatar').exists() || wrapper.find('.sidebar-item .agent-avatar').exists()).toBe(true)
  expect(wrapper.find('.sidebar-item .agent-avatar--working').exists()).toBe(true)
  await wrapper.setProps({conversations:[{...c,kind:'direct',memberIds:['first'],activeRunId:'direct-run',activeAgentId:'first',activeRunStatus:'waiting'}]})
  expect(wrapper.find('.sidebar-item .agent-avatar--waiting').exists()).toBe(true)
  wrapper.unmount()
})

it.each([
  ['direct', '机器人设置'],
  ['group', '群聊设置'],
] as const)('opens settings for a %s conversation from its actions menu', async (kind, label) => {
  const conversation: WorkspaceConversation = {
    id: kind,
    kind,
    name: kind === 'direct' ? '机器人' : '群聊',
    avatar: '',
    memberIds: [],
    instructions: '',
    administratorId: '',
    mode: 'host',
    autoReplyIds: [],
    maxReplyRounds: 1,
    archived: false,
    pinned: false,
    readSeq: 0,
    lastSeq: 0,
    preview: '',
    createdAt: 1,
    updatedAt: 1,
  }
  const wrapper = mount(ConversationList, { attachTo: document.body, props: { conversations: [conversation] } })
  wrapper.getComponent(ResourceSidebar).vm.$emit('more', conversation.id, new MouseEvent('click', { clientX: 100, clientY: 100 }))
  await nextTick()
  const menu = document.body.querySelector<HTMLElement>('[aria-label="聊天操作"]')!
  const view = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
  view.click()
  await nextTick()
  expect(wrapper.emitted('settings')).toEqual([[conversation.id]])
  expect(wrapper.emitted('select')).toBeUndefined()
  expect(document.body.querySelector('[aria-label="聊天操作"]')).toBeNull()
  wrapper.unmount()
})


it('keeps inline thinking in the process trace and its media out of the message body', () => {
  const messages = workspaceMessagesToUi([{
    id: 'inline-thinking', conversationId: 'chat', seq: 1, role: 'assistant',
    content: '<think>![过程图](/tmp/process.png)</think>[报告](/tmp/report.pdf)',
    reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: 1,
  }])
  expect(messages[0].content).toBe('[报告](/tmp/report.pdf)')
  expect(messages[0].reasoning).toBe('![过程图](/tmp/process.png)')
})


it('keeps a Bot busy across group replies until its final active conversation finishes', async () => {
  const base: WorkspaceConversation = { id: 'direct', kind: 'direct', name: 'Bot', avatar: '', memberIds: ['a'], instructions: '', administratorId: 'a', mode: 'host', autoReplyIds: [], maxReplyRounds: 1, archived: false, pinned: false, readSeq: 0, lastSeq: 0, preview: '', createdAt: 1, updatedAt: 1 }
  const group: WorkspaceConversation = { ...base, id: 'group', kind: 'group', memberIds: ['a', 'b'], activeRunId: 'g-run', activeAgentStates: { a: 'running', b: 'waiting' } }
  const other: WorkspaceConversation = { ...group, id: 'other', activeRunId: 'other-run', activeAgentStates: { a: 'waiting' } }
  const wrapper = mount(ConversationList, { props: { conversations: [base, group, other, { ...base, id: 'unrelated', memberIds: ['unrelated'] }] } })
  const bot = () => wrapper.get('[data-sidebar-id="direct"]')
  expect(bot().find('.agent-avatar--working').exists()).toBe(true)
  expect(bot().find('.presence--working').exists()).toBe(true)
  expect(wrapper.get('[data-sidebar-id="unrelated"]').find('.agent-avatar--working').exists()).toBe(false)
  await wrapper.setProps({ conversations: [base, { ...group, activeRunId: undefined, activeAgentStates: {}, avatarSignals: { a: { id: 'done', state: 'success', at: Date.now() } } }, other] })
  expect(bot().find('.agent-avatar--waiting').exists()).toBe(true)
  await wrapper.setProps({ conversations: [base, { ...other, activeAgentStates: { a: 'queued' } }] })
  expect(bot().find('.agent-avatar--loading').exists()).toBe(true)
  await wrapper.setProps({ conversations: [base] })
  expect(bot().find('.agent-avatar--idle').exists()).toBe(true)
  expect(bot().find('.presence--working').exists()).toBe(false)
  wrapper.unmount()
})
