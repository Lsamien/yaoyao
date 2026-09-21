// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildWorkspacePrompt, workspaceEnvironmentPrompt, type WorkspacePromptEnvironment, type WorkspacePromptInput } from '../../src/server/workspacePrompt'

function environment(): WorkspacePromptEnvironment {
  return {
    open: { computer: true, server: true, vm: true, cloud: true },
    tools: { desktopView: true, desktopFile: true, vm: true, cloud: true, plugins: false },
    version: 1, capturedAt: 1, execution: { nodeId: 'local', profile: 'dev' },
    desktop: { capturedAt: 1, sourceHost: 'mac-id', hosts: [{ id: 'mac-id', target: 'mac-id', name: '工作 Mac', kind: 'computer', source: true, online: true, open: true,
      capabilities: { view: { enabled: true, status: 'ready' }, input: { enabled: true, status: 'ready' }, fileRead: { enabled: true, status: 'ready' }, fileWrite: { enabled: true, status: 'ready' }, shell: { enabled: true, status: 'ready' }, fileTransfer: { enabled: true, status: 'ready' } },
      transfer: { protocol: 'chunked', readMaxMiB: 50, writeMaxMiB: 50 } }] },
    virtual: { vm: { status: 'on_demand', environmentId: 'bot' }, cloud: { status: 'on_demand', cwd: '/workspace' } },
    cwd: '/srv/hermes/project', fileTransferMaxMiB: 50,
  }
}
function input(): WorkspacePromptInput {
  return {
    agent: { id: 'bot', name: '助手', avatar: '', instructions: '规则原文\n保留格式', description: '处理开发任务', job: '开发与验证', voice: 'concise', actBias: 'act_now', nodeId: 'local', profile: 'dev', archived: false, revision: 7, createdAt: 1, updatedAt: 1 },
    conversation: { id: 'chat', kind: 'direct', name: '对话', avatar: '', memberIds: ['bot'], administratorId: 'bot', mode: 'free', instructions: '', autoReplyIds: [], maxReplyRounds: 1, archived: false, pinned: false, readSeq: 0, lastSeq: 0, preview: '', createdAt: 1, updatedAt: 1 },
    members: [{ id: 'bot', name: '助手' }],
    work: { depth: 0, requiredReply: true, replyMode: 'mentioned', messageId: 'message' },
    run: { mentionIds: [] }, environment: environment(),
    memory: '已确认的项目事实', noReply: '[[YAOYAO_NO_REPLY_V1]]', marker: '[yaoyao-run:run:result]',
    content: '读取本机文件\n然后核对结果', contentKind: 'user', attachmentRefs: ['[附件](ref:file)'],
  }
}

describe('Bot environment routing', () => {
  it('describes all mounted environments conditionally without moving the model or the message origin', () => {
    const text = workspaceEnvironmentPrompt(environment())
    expect(text).toContain('模型会话运行在服务端 Hermes')
    expect(text).toContain('「本机」只指本轮消息来源电脑')
    expect(text).toContain('不得切换其他机器代做')
    expect(text).toContain('host="server"')
    expect(text).toContain('desktop_shell')
    expect(text).toContain('computer_shell')
    expect(text).toContain('cloud_computer_*')
    expect(text).toContain('最大 50 MiB')
    expect(text).not.toContain('25 MiB')
    expect(text).not.toContain('当前环境是')
    expect(text).not.toContain('一律用 desktop_*')
    expect(text.match(/工作 Mac/g)).toHaveLength(2) // source and inventory, not one list per environment
    expect(text).toContain('该路径仅属于 Hermes 运行环境')
  })

  it('distinguishes global policy from mounted capabilities and does not promise native tools', () => {
    const env = environment()
    env.tools = { desktopView: false, desktopFile: false, vm: false, cloud: false, plugins: false }
    const text = workspaceEnvironmentPrompt(env)
    expect(text).toContain('开放不等于在线或已授权')
    expect(text).toContain('以本轮实际工具目录为准')
    expect(text).not.toContain('工具均可使用')
    for (const tool of ['desktop_file_copy', 'desktop_environment_view', 'computer_shell', 'cloud_computer_*']) expect(text).not.toContain(tool)
  })

  it('does not require a screenshot for file-only computers', () => {
    const env = environment()
    env.tools.desktopView = false
    const text = workspaceEnvironmentPrompt(env)
    expect(text).toContain('文件与命令操作无需先截图')
    expect(text).not.toContain('desktop_environment_view')
    expect(text).toContain('desktop_file_copy')
    env.tools.desktopFile = false
    env.tools.desktopView = true
    const view = workspaceEnvironmentPrompt(env)
    expect(view).toContain('desktop_environment_view')
    expect(view).not.toContain('电脑文件与命令工具已挂载')
    expect(view).not.toContain('desktop_file_copy')
  })

  it('cannot turn Grok model discussion, old VM text or a follow-up into environment selection', () => {
    const fixture = input()
    fixture.environment.tools.cloud = false
    fixture.environment.tools.vm = false
    const prompts = ['介绍 Grok 模型', '以前使用过虚拟机', '继续'].map(content => buildWorkspacePrompt({ ...fixture, content }))
    const environments = prompts.map(text => text.split('【本轮环境与设备】')[1]!.split('【Bot 记忆与相关事实】')[0])
    expect(new Set(environments).size).toBe(1)
    expect(environments[0]).not.toContain('cloud_computer_*')
    expect(environments[0]).not.toContain('computer_shell')
  })
})

describe('Bot prompt composition', () => {
  it('keeps persona, provenance, user content and attachments in their own sections', () => {
    const fixture = input(), text = buildWorkspacePrompt(fixture)
    expect(text).toContain(`版本 7）：\n${fixture.agent.instructions}`)
    expect(text).toContain('你是 助手。')
    expect(text).toContain('直接行动：合理默认即可开工')
    expect(text).toContain(`【本轮用户消息】\n${fixture.content}`)
    expect(text).toContain('【本轮附件】\n[附件](ref:file)')
    expect(text).toContain(fixture.marker)
    expect(text.indexOf('【Bot 身份与长期规则】')).toBeLessThan(text.indexOf('【本轮任务与协作】'))
    expect(text.indexOf('【本轮环境与设备】')).toBeLessThan(text.indexOf('【Bot 记忆与相关事实】'))
    expect(text.indexOf('【Bot 记忆与相关事实】')).toBeLessThan(text.indexOf('【本轮用户消息】'))
  })

  it('preserves discussion participation, member roles and history boundaries', () => {
    const fixture = input()
    fixture.conversation = { ...fixture.conversation, kind: 'group', memberRoles: { bot: { name: '审核', description: '核实事实' } } }
    fixture.run = { mentionIds: ['bot'], discussion: { memberIds: ['bot'], rounds: 2 }, projectId: 'project' }
    fixture.work.depth = 1
    fixture.contentKind = 'history'
    const text = buildWorkspacePrompt(fixture)
    expect(text).toContain('平等讨论，第 2 轮')
    expect(text).toContain('@助手：审核；核实事实')
    expect(text).toContain('本轮用户指定成员：@助手')
    expect(text).toContain('不要用私信或 @ 再次派发本轮工作')
    expect(text).toContain('【本轮对话上下文】')
    expect(text).toContain('当前项目 ID：project')
  })

  it('preserves automatic silence and does not offer unmounted export tools to a helper', () => {
    const fixture = input()
    fixture.work.requiredReply = false
    fixture.work.replyMode = 'automatic'
    fixture.agent.temporaryGoalId = 'goal'
    fixture.environment.tools.vm = false
    const text = buildWorkspacePrompt(fixture)
    expect(text).toContain('完整答复只能是 [[YAOYAO_NO_REPLY_V1]]')
    expect(text).toContain('不要创建团队或改变自身权限')
    expect(text).not.toContain('computer_export')
  })
})
