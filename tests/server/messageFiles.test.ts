// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceAssets, type StoredWorkspaceFile } from '../../src/server/workspaceAssets'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceMessage, WorkspaceConversation } from '../../src/shared/workspace'
import { messageFileReferences, nativeMessageFileText } from '../../src/shared/messageFiles'

it('archives only message references and reconciles legacy associations without deleting bytes or logs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-message-files-'))
  const store = new WorkspaceStore(home)
  const request = vi.fn(async (_route: string, _options: { search: URLSearchParams }) => ({ status: 200, body: Buffer.from('report'), headers: new Headers({ 'content-type': 'text/plain' }) }))
  const assets = new WorkspaceAssets(store, { target: () => ({ session: { request } }) } as unknown as WorkspaceNodes, home)
  try {
    const agent = store.createAgent('owner', { name: 'Agent', profile: 'default' })
    const conversation = store.list<WorkspaceConversation>('owner', 'conversation')[0]!
    const message: WorkspaceMessage = {
      id: 'reply', conversationId: conversation.id, agentId: agent.id, seq: 0, role: 'assistant',
      content: '<think>[hidden](/tmp/thinking.pdf)</think>[报告](sandbox:/tmp/report.txt)',
      reasoning: '[思考](/tmp/reasoning.pdf)', tools: [{ arguments: { path: '/tmp/input.pdf' }, result: { path: '/tmp/process.pdf' } }],
      status: 'complete', attachments: [], createdAt: Date.now(),
    }
    store.saveMessage('owner', message)
    await assets.archive('owner', message)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]?.search.get('path')).toBe('/tmp/report.txt')
    // Reproduce an old archive which mixed a tool path into the message.
    await assets.archiveText('owner', '[old](/tmp/process.pdf)', 'local', 'default', conversation.id, message.id)
    const all = store.list<StoredWorkspaceFile>('owner', 'file')
    for (const file of all) {
      delete file.messageFileSource
      store.put('owner', 'file', file.id, file)
    }
    message.attachments = all
    store.saveMessage('owner', message)
    expect(store.messages('owner', conversation.id)[0]?.attachments.map(file => file.name)).toEqual(['report.txt'])
    expect(store.visibleFiles('owner').map(file => file.name)).toEqual(['report.txt'])
    const replay = store.events('owner', 0).filter(event => event.type === 'message.changed').at(-1)!
    expect((replay.data as WorkspaceMessage).attachments.map(file => file.name)).toEqual(['report.txt'])
    expect(store.get<WorkspaceMessage>('owner', 'message', message.id)?.tools).toEqual(message.tools)
    expect(all.every(file => readFileSync(file.path, 'utf8') === 'report')).toBe(true)
    message.content += '\n[交付过程文件](/tmp/process.pdf)'
    store.saveMessage('owner', message)
    expect(store.visibleFiles('owner')).toHaveLength(2)
    expect(store.visibleFiles('another-owner')).toEqual([])
  } finally { assets.close(); store.close(); rmSync(home, { recursive: true, force: true }) }
})

it('does not scan native reasoning, tool data, code examples or unfinished thinking', () => {
  const text = nativeMessageFileText({
    text: '[交付](/tmp/report.pdf)', reasoning: '/tmp/reasoning.pdf',
    tools: [{ result: { path: '/tmp/process.pdf' } }],
    attachments: [{ path: '/tmp/attached.pdf', name: 'attached.pdf' }],
  })
  expect([...messageFileReferences(text)]).toEqual(['/tmp/report.pdf', '/tmp/attached.pdf'])
  expect(nativeMessageFileText({ role: 'tool', content: '[过程](/tmp/process.pdf)' })).toBe('')
  expect([...messageFileReferences('```json\n{"path":"/tmp/process.pdf"}\n```\n<think>![图](/tmp/hidden.png)')]).toEqual([])
})
