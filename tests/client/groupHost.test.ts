import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { GroupAgent, GroupMessage, GroupRoomSummary } from '@shared/types'
import CreateGroupDialog from '@/components/groups/CreateGroupDialog.vue'
import GroupManager from '@/components/groups/GroupManager.vue'
import { TEAM_PRESETS } from '@/components/groups/teamPresets'
import { groupMessageToUi, roomSidebarItem } from '@/components/workspace/viewModels'
import { fallbackTeamAnimalAvatar } from '@/utils/teamAvatar'

const profiles = (...names: string[]) => names.map(name => ({
  id: `local|${name}`, profile: name, displayName: name, nodeId: 'local', nodeLabel: '当前 Hermes',
}))

function agent(id: string, profile: string, displayName: string, isHost: boolean, replyWithoutMention: boolean): GroupAgent {
  return {
    id, roomId: 'room-1', profile, nodeId: 'local', nodeLabel: '', displayName, description: `${displayName} 的职责`, storedSessionId: null,
    lastContextMessageSeq: 0, enabled: true, replyWithoutMention, isHost,
    model: null, provider: null, reasoningEffort: null, fastMode: null,
    createdAt: 1, updatedAt: 1, status: 'idle',
  }
}

describe('group host controls', () => {
  it('uses the shared stable animal mapping for legacy empty avatars', () => {
    expect(fallbackTeamAnimalAvatar('22222222-2222-4222-8222-222222222222').id).toBe('bear')
  })

  it('provides office and development presets with unique roles within the Agent limit', () => {
    expect(TEAM_PRESETS.map(preset => preset.name)).toEqual([
      '信息收集团队', '产品设计团队', '软件开发团队', '文案书写团队',
      '项目管理团队', '数据分析团队', '会议协作团队', '运维保障团队',
    ])
    for (const preset of TEAM_PRESETS) {
      expect(preset.roles.length).toBeGreaterThanOrEqual(4)
      expect(preset.roles.length).toBeLessThanOrEqual(8)
      expect(new Set(preset.roles.map(role => role.name)).size).toBe(preset.roles.length)
      expect(preset.roles.filter(role => role.host)).toHaveLength(1)
    }
  })

  it('maps preset roles onto existing Agents and submits their role descriptions', async () => {
    const choices = profiles('yaoyao', 'yaoer', 'reviewer', 'writer')
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: {
        open: true,
        profiles: choices,
        hostEnabled: true,
        hostFlowEnabled: true,
        roomInstructionsEnabled: true,
      },
      global: { stubs: { teleport: true } },
    })
    await wrapper.get('button[aria-label^="信息收集团队"]').trigger('click')
    expect(wrapper.get<HTMLInputElement>('input[placeholder="例如：产品评审"]').element.value).toBe('信息收集团队')
    expect(wrapper.findAll('.role-mapping select')).toHaveLength(4)
    await wrapper.get<HTMLSelectElement>('select[aria-label="信息检索对应的机器人"]').setValue('local|yaoyao')
    await wrapper.get<HTMLSelectElement>('select[aria-label="信息检索对应的机器人"]').setValue('local|reviewer')
    await wrapper.get('.solid-button').trigger('click')

    const payload = wrapper.emitted('create')?.[0]?.[0] as { members: Array<{ profile: string; displayName: string; description: string }>; hostProfile: string; autoReply: boolean; orchestrationMode: string; instructions: string }
    expect(payload.members.map(member => [member.profile, member.displayName])).toEqual([
      ['yaoer', '调研负责人'],
      ['reviewer', '信息检索'],
      ['yaoyao', '事实核验'],
      ['writer', '资料整理'],
    ])
    expect(payload.members.every(member => member.description.length > 0)).toBe(true)
    expect(payload.hostProfile).toBe('local|yaoer')
    expect(payload.autoReply).toBe(false)
    expect(payload.orchestrationMode).toBe('host')
    expect(payload.instructions).toContain('交叉核验')
    wrapper.unmount()
  })

  it('disables presets when the current Agent count is insufficient', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: profiles('yaoyao', 'yaoer', 'reviewer', 'writer') },
      global: { stubs: { teleport: true } },
    })
    const softwarePreset = wrapper.get<HTMLButtonElement>('button[aria-label^="软件开发团队"]')
    expect(softwarePreset.element.disabled).toBe(true)
    expect(softwarePreset.text()).toContain('还缺 1 人')
    await softwarePreset.trigger('click')
    expect(wrapper.find('.role-mapping').exists()).toBe(false)
    wrapper.unmount()
  })

  it('resolves a local team avatar by display name when an old room stored an internal Profile alias', () => {
    const room = {
      id: 'room-1', name: '头像团队', cwd: '', instructions: '', avatar: '', createdAt: 1, updatedAt: 1,
      archived: false, agentCount: 2, lastMessage: null, unreadCount: 0, activeRunCount: 0, maxReplyRounds: 3, orchestrationMode: 'free',
      avatarMembers: [
        { profile: 'legacy:default', nodeId: 'local', displayName: '丫头' },
        { profile: 'default', nodeId: 'remote-node', displayName: '远端丫头' },
      ],
    } satisfies GroupRoomSummary
    const item = roomSidebarItem(room, { default: 'data:image/png;base64,LOCAL==' }, { 丫头: 'data:image/png;base64,LOCAL==' })
    expect(item.avatarFallbackKey).toBe(room.id)
    expect(item.avatarMembers).toEqual([
      { name: '丫头', avatar: 'data:image/png;base64,LOCAL==' },
      { name: '远端丫头', avatar: undefined },
    ])
  })

  it('keeps same-name Profiles distinct across paired Hermes nodes', async () => {
    const local = profiles('default')[0]!
    const remote = {
      id: '11111111-1111-4111-8111-111111111111|default',
      profile: 'default',
      displayName: '远端夭夭',
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeLabel: 'MacBook Pro',
    }
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: [local, remote], hostEnabled: true },
      global: { stubs: { teleport: true } },
    })
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('跨节点群')
    await wrapper.findAll('.agent-picker > button')[1]!.trigger('click')
    await wrapper.get('.solid-button').trigger('click')
    expect(wrapper.emitted('create')?.[0]?.[0]).toMatchObject({
      members: [local, remote],
      hostProfile: local.id,
    })
    wrapper.unmount()
  })

  it('adds an Agent from a paired node to an existing group', async () => {
    const local = agent('agent-local', 'default', '本机机器人', true, true)
    const remote = {
      id: '11111111-1111-4111-8111-111111111111|reviewer',
      profile: 'reviewer',
      displayName: '远端评审',
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeLabel: '工作室 Mac',
    }
    const wrapper = mount(GroupManager, {
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [local.id], replyRounds: 3 },
        agents: [local],
        availableProfiles: [remote],
      },
    })

    await wrapper.get<HTMLSelectElement>('select[aria-label="选择要添加的机器人"]').setValue(remote.id)
    expect(wrapper.emitted('addAgent')?.at(-1)).toEqual([remote.id])
    wrapper.unmount()
  })

  it('keeps one independent host selection when creating a v5 room', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: profiles('yaoyao', 'yaoer'), hostEnabled: true },
      global: { stubs: { teleport: true } },
    })
    await nextTick()
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('管理员验收')
    const profileButtons = wrapper.findAll('.agent-picker > button')
    await profileButtons[1]!.trigger('click')
    const host = wrapper.get<HTMLSelectElement>('select[aria-label="管理员"]')
    await host.setValue('local|yaoer')
    await profileButtons[1]!.trigger('click')
    expect(host.element.value).toBe('local|yaoyao')
    await profileButtons[1]!.trigger('click')
    await host.setValue('local|yaoer')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="所有成员无需 @ 也回复"]').element.checked).toBe(true)
    await wrapper.get('.solid-button').trigger('click')

    expect(wrapper.emitted('create')?.[0]?.[0]).toEqual({
      name: '管理员验收', members: profiles('yaoyao', 'yaoer'), hostProfile: 'local|yaoer', autoReply: true, replyRounds: 3,
    })
    wrapper.unmount()
  })

  it('keeps the legacy v4 create UI and payload free of host fields', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: profiles('yaoyao'), hostEnabled: false },
      global: { stubs: { teleport: true } },
    })
    await nextTick()
    expect(wrapper.find('select[aria-label="管理员"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="启用自动回复"]').exists()).toBe(true)
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('v4 房间')
    await wrapper.get('.solid-button').trigger('click')
    expect(wrapper.emitted('create')?.[0]?.[0]).not.toHaveProperty('hostProfile')
    expect(wrapper.emitted('create')?.[0]?.[0]).not.toHaveProperty('orchestrationMode')
    expect(wrapper.emitted('create')?.[0]?.[0]).not.toHaveProperty('instructions')
    wrapper.unmount()
  })

  it('offers host flow only when the server advertises the capability', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: {
        open: true,
        profiles: profiles('yaoyao', 'yaoer'),
        hostEnabled: true,
        hostFlowEnabled: true,
        roomInstructionsEnabled: true,
      },
      global: { stubs: { teleport: true } },
    })
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('顺序协作')
    await wrapper.get<HTMLTextAreaElement>('textarea').setValue('先核对事实，再输出中文结论。')
    await wrapper.get<HTMLSelectElement>('select[aria-label="协作模式"]').setValue('host')
    await wrapper.get('.solid-button').trigger('click')
    expect(wrapper.emitted('create')?.[0]?.[0]).toMatchObject({
      name: '顺序协作',
      instructions: '先核对事实，再输出中文结论。',
      orchestrationMode: 'host',
    })
    wrapper.unmount()
  })

  it('builds a team avatar from member mascots without persisting a legacy animal', async () => {
    const choices = profiles('yaoyao', 'yaoer').map((profile, index) => ({
      ...profile,
      ...(index === 0 ? { avatar: 'data:image/png;base64,AA==' } : {}),
    }))
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: choices, avatarEnabled: true },
      global: { stubs: { teleport: true } },
    })
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('头像团队')
    await wrapper.findAll('.agent-picker > button')[1]!.trigger('click')
    expect(wrapper.findAll('.avatar-picker .team-avatar__member')).toHaveLength(choices.length)
    expect(wrapper.get('.avatar-picker').text()).toContain('由成员的动态角色自动组成')
    expect(wrapper.findAll('.avatar-picker .agent-avatar--image')).toHaveLength(1)
    await wrapper.get('.solid-button').trigger('click')
    expect(wrapper.emitted('create')?.[0]?.[0]).toMatchObject({
      name: '头像团队',
      members: choices,
    })
    expect((wrapper.emitted('create')?.[0]?.[0] as { avatar?: string }).avatar).toBeUndefined()
    wrapper.unmount()
  })

  it('emits one host promotion and explains the independent auto-reply setting', async () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, true)
    const second = agent('agent-2', 'yaoer', '瑶儿', false, false)
    const wrapper = mount(GroupManager, {
      attachTo: document.body,
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [first.id, second.id], replyRounds: 3 },
        agents: [first, second],
        hostEnabled: true,
      },
    })
    const selector = wrapper.get<HTMLSelectElement>('select[aria-label="管理员"]')
    expect(selector.element.value).toBe('agent-1')
    expect(wrapper.findAll('.host-badge')).toHaveLength(1)
    await selector.setValue('agent-2')
    expect(wrapper.emitted('updateAgent')?.[0]).toEqual(['agent-2', { isHost: true }])

    await wrapper.setProps({ agents: [{ ...first, isHost: false }, { ...second, isHost: true }] })
    await wrapper.get('button[aria-label="设置瑶儿"]').trigger('click')
    await nextTick()
    const dialog = document.querySelector('[role="dialog"][aria-label="瑶儿机器人设置"]')
    expect(dialog?.textContent).toContain('管理员始终处理用户无 @ 消息')
    expect(dialog?.querySelector('input[aria-label="无需 @ 也回复"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('blocks removing a host when no enabled replacement exists and shows manager errors', () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, true)
    const second = { ...agent('agent-2', 'yaoer', '瑶儿', false, false), enabled: false }
    const wrapper = mount(GroupManager, {
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [first.id, second.id], replyRounds: 3 },
        agents: [first, second],
        hostEnabled: true,
        managerError: '需要另一位已启用成员',
      },
    })

    const removeHost = wrapper.get<HTMLButtonElement>('button[aria-label="移除夭夭"]')
    expect(removeHost.element.disabled).toBe(true)
    expect(removeHost.attributes('title')).toContain('已启用成员')
    expect(wrapper.get('[role="alert"]').text()).toBe('需要另一位已启用成员')
  })

  it('emits a room update when switching collaboration mode', async () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, false)
    const wrapper = mount(GroupManager, {
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [first.id], replyRounds: 3, orchestrationMode: 'free' },
        agents: [first],
        hostEnabled: true,
        hostFlowEnabled: true,
      },
    })
    await wrapper.get<HTMLSelectElement>('select[aria-label="协作模式"]').setValue('host')
    expect(wrapper.emitted('updateRoom')?.[0]?.[0]).toEqual({
      name: '群聊',
      replyRounds: 3,
      orchestrationMode: 'host',
    })
  })

  it('edits room instructions when the capability is available', async () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, false)
    const wrapper = mount(GroupManager, {
      props: {
        room: {
          id: 'room-1', name: '群聊', memberIds: [first.id], replyRounds: 3,
          orchestrationMode: 'free', instructions: '旧规则',
        },
        agents: [first],
        hostEnabled: true,
        hostFlowEnabled: true,
        roomInstructionsEnabled: true,
      },
    })
    const instructions = wrapper.get<HTMLTextAreaElement>('textarea[aria-label="团队说明"]')
    await instructions.setValue('新规则\n输出中文')
    await instructions.trigger('change')
    expect(wrapper.emitted('updateRoom')?.at(-1)?.[0]).toMatchObject({
      instructions: '新规则\n输出中文',
    })
  })

  it('only allows remote Agents to rename themselves within the room', async () => {
    const local = agent('agent-1', 'yaoyao', '夭夭', false, false)
    const remote = {
      ...agent('agent-2', 'yaoer', '远端夭夭', false, false),
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeLabel: '工作室 Mac',
    }
    const wrapper = mount(GroupManager, {
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [local.id, remote.id], replyRounds: 3 },
        agents: [local, remote],
        remoteServerAddresses: { [remote.nodeId]: '192.168.1.20:9119' },
      },
      global: { stubs: { teleport: true } },
    })

    await wrapper.get('button[aria-label="设置远端夭夭"]').trigger('click')
    const remoteName = wrapper.get<HTMLInputElement>('input[aria-label="群内名称"]')
    await remoteName.setValue('群内审查员')
    await wrapper.get('.save-agent').trigger('click')
    expect(wrapper.emitted('updateAgent')?.at(-1)).toEqual([
      remote.id,
      { displayName: '群内审查员' },
    ])
    expect(wrapper.text()).toContain('192.168.1.20:9119')

    await wrapper.get('button[aria-label="设置夭夭"]').trigger('click')
    expect(wrapper.find('input[aria-label="群内名称"]').exists()).toBe(false)
  })

  it('uses the synced remote Agent name and marks its topic message', () => {
    const remote = {
      ...agent('agent-remote', 'reviewer', '群内审查员', false, false),
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeLabel: '工作室 Mac',
    }
    const message: GroupMessage = {
      seq: 1,
      id: 'message-1',
      roomId: 'room-1',
      senderKind: 'agent',
      senderId: remote.id,
      senderName: '旧名称',
      rootMessageId: 'message-1',
      content: '已完成',
      reasoning: '',
      toolState: [],
      status: 'completed',
      error: '',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(groupMessageToUi(message, [remote])).toMatchObject({
      author: '群内审查员',
      isRemoteAgent: true,
    })
  })
})
