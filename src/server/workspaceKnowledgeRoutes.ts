import Router from '@koa/router'
import { z } from 'zod'
import type { LocalAuthStore } from './localAuth.js'
import type { WorkspaceRuntime } from './workspaceRuntime.js'
import { parse } from './workspaceStore.js'
import { memoryForgetInput, memoryQueryInput, memoryScopeInput, memoryWriteInput, projectSaveInput } from './workspaceKnowledgeTools.js'
import { HttpError } from './errors.js'

export function workspaceKnowledgeRouter(runtime: WorkspaceRuntime, auth: LocalAuthStore): Router {
  const router = new Router({ prefix: '/api/app/workspace' }), knowledge = runtime.knowledge
  router.use(async (ctx, next) => { ctx.set('Cache-Control', 'no-store'); await next() })
  router.get('/projects', ctx => { ctx.body = { projects: knowledge.projects(auth.require(ctx).id) } })
  router.post('/projects', ctx => {
    const owner = auth.require(ctx).id, input = parse(projectSaveInput, ctx.request.body)
    for (const id of input.memberIds) runtime.nodes.requireSource(owner, knowledge.agent(owner, id))
    ctx.body = { project: knowledge.saveProject(owner, input) }
  })
  router.get('/memories', ctx => {
    const owner = auth.require(ctx).id, query = parse(memoryQueryInput, ctx.query)
    const memories = knowledge.memories(owner, query).filter(memory => { try { runtime.nodes.requireSource(owner, knowledge.agent(owner, memory.agentId)); return true } catch { return false } })
    ctx.set('Cache-Control', 'no-store'); ctx.body = { memories }
  })
  router.post('/memories', ctx => {
    const owner = auth.require(ctx).id, input = parse(memoryWriteInput, ctx.request.body)
    runtime.nodes.requireSource(owner, knowledge.agent(owner, input.agentId))
    ctx.body = { memory: knowledge.writeMemory(owner, input) }
  })
  router.post('/memories/forget', ctx => {
    const owner = auth.require(ctx).id, input = parse(memoryForgetInput, ctx.request.body)
    runtime.nodes.requireSource(owner, knowledge.agent(owner, input.agentId))
    ctx.body = knowledge.forget(owner, input)
  })
  router.get('/memories/:id/revisions', ctx => {
    const owner = auth.require(ctx).id, scope = parse(memoryScopeInput, ctx.query)
    runtime.nodes.requireSource(owner, knowledge.agent(owner, scope.agentId))
    ctx.body = { revisions: knowledge.revisions(owner, scope, ctx.params.id) }
  })
  router.get('/memory-export', ctx => {
    const owner = auth.require(ctx).id, query = parse(memoryQueryInput, ctx.query), memories = knowledge.memories(owner, query)
    for (const memory of memories) runtime.nodes.requireSource(owner, knowledge.agent(owner, memory.agentId))
    ctx.set('Content-Disposition', 'attachment; filename="bot-memory.md"')
    ctx.type = 'text/markdown; charset=utf-8'
    ctx.body = `# Bot 模式记忆\n\n${memories.map(m => `- (${new Date(m.createdAt).toISOString().slice(0, 10)}) ${m.content}`).join('\n')}\n`
  })
  router.get('/memory-jobs', ctx => {
    const owner = auth.require(ctx).id, input = parse(z.object({ agentId: z.string().uuid().optional() }).strict(), ctx.query)
    if (input.agentId) runtime.nodes.requireSource(owner, knowledge.agent(owner, input.agentId))
    ctx.body = { jobs: knowledge.jobs(owner, input.agentId).slice(0, 200) }
  })
  router.post('/memory-jobs/:id/retry', ctx => {
    const owner = auth.require(ctx).id, job = knowledge.jobs(owner).find(j => j.id === ctx.params.id)
    if (!job) throw new HttpError(404, '提炼记录不存在', 'memory_job_not_found')
    runtime.nodes.requireSource(owner, knowledge.agent(owner, job.agentId))
    if (job.status === 'failed') knowledge.saveJob(owner, { ...job, status: 'pending', attempts: 0, nextAt: Date.now(), error: undefined })
    ctx.body = { ok: true }
  })
  router.get('/collaboration', ctx => {
    const owner = auth.require(ctx).id, query = parse(z.object({ conversationId: z.string().uuid().optional() }).strict(), ctx.query)
    if (query.conversationId) runtime.store.require(owner, 'conversation', query.conversationId)
    ctx.body = { messages: runtime.collaboration.list(owner, query.conversationId) }
  })
  router.post('/collaboration/:id/stop', async ctx => {
    const owner = auth.require(ctx).id, peer = runtime.store.require<import('../shared/workspaceKnowledge.js').WorkspacePeerMessage>(owner, 'peer-message', ctx.params.id)
    await runtime.collaboration.stopFor(owner, chain => chain.id === peer.chainId)
    ctx.body = { ok: true }
  })
  return router
}
