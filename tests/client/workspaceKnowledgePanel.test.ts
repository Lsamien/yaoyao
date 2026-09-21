import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import WorkspaceKnowledgePanel from '@/components/workspace/WorkspaceKnowledgePanel.vue'
import { apiRequest } from '@/api/client'
import type { WorkspaceAgent } from '@shared/workspace'
import type { WorkspaceMemoryJob, WorkspaceMemoryJobResult } from '@shared/workspaceKnowledge'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))
afterEach(() => vi.restoreAllMocks())
const counts = (values: Partial<WorkspaceMemoryJobResult> = {}): WorkspaceMemoryJobResult => ({
  extractedCount: 0, writtenCount: 0, duplicateCount: 0, replayedCount: 0, skippedReasons: {}, ...values,
})

it('distinguishes saved, empty, filtered, duplicate, failed and historical extraction jobs', async () => {
  const variants: Partial<WorkspaceMemoryJob>[] = [
    { result: counts({ extractedCount: 2, writtenCount: 2 }) },
    { result: counts() },
    { result: counts({ extractedCount: 2, skippedReasons: { quote_mismatch: 1, project_unbound: 1 } }) },
    { result: counts({ extractedCount: 1, duplicateCount: 1 }) },
    { result: counts({ extractedCount: 1, replayedCount: 1 }) },
    { status: 'failed', error: '连接失败', result: counts({ extractedCount: 2, writtenCount: 1 }) },
    {},
  ]
  const jobs = variants.map((variant, index) => ({ id: `job-${index}`, status: 'complete', createdAt: 1, ...variant }))
  vi.mocked(apiRequest).mockImplementation(async path => {
    if (path === '/api/app/workspace/projects') return { projects: [] } as never
    if (String(path).includes('/memory-jobs')) return { jobs } as never
    if (String(path).includes('/memories')) return { memories: [] } as never
    throw new Error(String(path))
  })
  const view = mount(WorkspaceKnowledgePanel, {
    props: { agents: [{ id: 'bot-a', name: '测试 Bot' } as WorkspaceAgent], conversations: [], embedded: true, initialTab: 'agent', selectedAgentId: 'bot-a' },
    global: { stubs: { AppIcon: true, AgentAvatar: true } },
  })
  try {
    await flushPromises()
    const text = view.text()
    for (const expected of ['已保存 2 条记忆', '本轮没有可记录内容', '候选记忆均未保存', '引用与原文不一致：1 条', '项目记忆缺少关联项目：1 条', '未新增记忆，已有相同内容', '重试已确认 1 条记录', '连接失败', '旧记录未统计保存结果']) expect(text).toContain(expected)
    expect(view.findAll('button').filter(button => button.text() === '重试')).toHaveLength(1)
    expect(text).toContain('本次提炼 2 条 · 新增保存 1 条')
  } finally { view.unmount() }
})
