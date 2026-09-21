// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import serve from 'koa-static'
import { WebSocketServer, type WebSocket } from 'ws'
import { chromium, expect as expectPage } from '@playwright/test'
import { loadServerConfig } from '../../src/server/config.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { WorkspaceRun } from '../../src/shared/workspace.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('stops a live browser conversation immediately when the runner never confirms interruption', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-stop-ui-'))
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => gateway.once('listening', resolve))
  const gatewayPort = (gateway.address() as AddressInfo).port
  const prompts: string[] = []
  let interruptCount = 0

  gateway.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready' } }))
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.method === 'session.create' || frame.method === 'session.resume') {
        socket.send(JSON.stringify({
          id: frame.id,
          result: { session_id: randomUUID(), stored_session_id: randomUUID(), running: false, info: { profile_name: 'default' } },
        }))
      } else if (frame.method === 'prompt.submit') {
        prompts.push(frame.params.text)
        socket.send(JSON.stringify({ id: frame.id, result: { status: 'streaming' } }))
      } else if (frame.method === 'session.cwd.set') {
        socket.send(JSON.stringify({ id: frame.id, result: { cwd: frame.params.cwd } }))
      } else if (frame.method === 'session.interrupt') {
        interruptCount++
        // Deliberately never reply: this is the unreachable-runner failure mode.
      } else {
        socket.send(JSON.stringify({ id: frame.id, result: {} }))
      }
    })
  })

  const config = loadServerConfig({
    HERMES_YAOYAO_HOME: home,
    HERMES_YAOYAO_UPSTREAM: `http://127.0.0.1:${gatewayPort}`,
    HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1,localhost',
  })
  const runtime: ApplicationRuntime = createAuthenticatedApplication({
    config,
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname
      const body = path === '/api/config'
        ? { terminal: { cwd: '.' } }
        : path === '/api/profiles'
          ? { profiles: [{ name: 'default', display_name: '基础 Agent' }] }
          : path === '/api/status'
            ? { auth_required: true }
            : path === '/api/auth/me'
              ? { user_id: 'upstream' }
              : { ok: true }
      return new Response(JSON.stringify(body), {
        status: path.includes('/plugins/yaoyao-bot-bridge/') ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  runtime.auth.isUserActive = vi.fn(() => true)
  runtime.auth.pushAuthorizationVersion = vi.fn(() => 0)
  const dist = join(import.meta.dirname, '../../dist')
  runtime.app.use(serve(dist, { index: 'index.html' }))
  runtime.app.use(async ctx => {
    if (ctx.method === 'GET' && ctx.accepts('html')) {
      ctx.type = 'html'
      ctx.body = readFileSync(join(dist, 'index.html'))
    }
  })
  const owner = 'test-admin'
  const nodes = (runtime.workspaceRuntime as unknown as { nodes: { target: (owner: string, nodeId: string) => any; requireSource: () => void } }).nodes
  const target = nodes.target(owner, 'local')
  target.session.webSocketCredential = async () => ({ name: 'ticket', value: 'stop-ui-test' })
  nodes.requireSource = () => {}
  const agent = runtime.workspace.createAgent(owner, { name: '停止验证', profile: 'default' })
  const conversation = runtime.workspace.list<any>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === agent.id)!
  const run = runtime.workspaceRuntime.send(owner, conversation.id, { requestId: randomUUID(), content: '等待停止' })

  const http = await new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    const server = runtime.app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise(done => server.close(done)) })
    })
  })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  cleanups.push(
    async () => { await browser.close() },
    async () => { await http.close() },
    () => runtime.close(),
    () => {
      for (const socket of gateway.clients) socket.terminate()
      gateway.close()
      rmSync(home, { recursive: true, force: true })
    },
  )

  await vi.waitFor(() => {
    const current = runtime.workspace.require<WorkspaceRun>(owner, 'run', run.id)
    expect(prompts, `${current.status}: ${current.error}`).toHaveLength(1)
  })
  await page.goto(`${http.url}/conversations/${conversation.id}`)
  await expectPage(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  await expectPage(page.getByLabel('机器人正在输入')).toBeVisible()

  const stopped = page.waitForResponse(
    response => response.url().endsWith(`/api/app/runs/${run.id}/stop`) && response.request().method() === 'POST',
    { timeout: 2_000 },
  )
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect((await stopped).status()).toBe(200)

  const storedRun = runtime.workspace.require<WorkspaceRun>(owner, 'run', run.id)
  expect(storedRun).toMatchObject({ status: 'interrupted', stopRequested: true })
  expect(runtime.workspace.require<any>(owner, 'conversation', conversation.id).activeRunId).toBeUndefined()
  await expectPage(page.getByLabel('机器人正在输入')).toBeHidden({ timeout: 2_000 })
  expect(interruptCount).toBe(1)
  mkdirSync(join(import.meta.dirname, '../../test-results/workspaceStopUi'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '../../test-results/workspaceStopUi/stopped.png'), fullPage: true })
})
