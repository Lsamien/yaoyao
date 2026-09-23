// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNodeServer } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { PushCoordinator } from '../../src/server/pushCoordinator'
import { WorkspaceMemorySynthesis } from '../../src/server/workspaceMemorySynthesis'
import { OpenVikingSessionSync } from '../../src/server/openVikingSessionSync'
import { createAuthenticatedApplication } from './authenticatedApplication'

afterEach(() => vi.restoreAllMocks())

function fixture(deferBackground: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-background-activation-'))
  const memory = vi.spyOn(WorkspaceMemorySynthesis.prototype, 'start').mockImplementation(() => {})
  const memorySync = vi.spyOn(OpenVikingSessionSync.prototype, 'start').mockImplementation(() => {})
  const push = new PushCoordinator({ home, autoFlush: false,
    fcmProviderFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }) })
  const runtime = createAuthenticatedApplication({ deferBackground, push,
    config: loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1' }) })
  const starts = {
    memory, memorySync,
    workspace: vi.spyOn(runtime.workspaceRuntime, 'start').mockImplementation(() => {}),
    routines: vi.spyOn(runtime.workspaceRoutines, 'start').mockImplementation(() => {}),
    grok: vi.spyOn(runtime.grokAuth, 'start').mockImplementation(() => {}),
  }
  const localVm = vi.spyOn(runtime.localVm, 'start').mockResolvedValue(undefined)
  const chatStart = vi.spyOn(runtime.chatPushJobs, 'start').mockImplementation(() => {})
  const chatStop = vi.spyOn(runtime.chatPushJobs, 'stop').mockImplementation(() => {})
  const node = createNodeServer(runtime, { deferBackground })
  const listen = () => new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve))
  const close = async () => { try { await node.close() } finally { rmSync(home, { recursive: true, force: true }) } }
  return { runtime, push, node, starts, localVm, chatStart, chatStop, listen, close }
}

it('keeps environment detection idle after listening and starts all background work once on activation', async () => {
  const f = fixture(true)
  try {
    await f.listen()
    for (const start of Object.values(f.starts)) expect(start).not.toHaveBeenCalled()
    expect(f.localVm).not.toHaveBeenCalled()
    expect(f.chatStart).not.toHaveBeenCalled()
    expect(f.chatStop).not.toHaveBeenCalled()
    await f.push.configureFCM({ serviceAccountFile: '/private/unused.json', projectId: 'fixture', packageName: 'cn.samien.yaoyao.hermes' })
    expect(f.chatStart).not.toHaveBeenCalled()

    f.node.startBackground()
    f.node.startBackground()
    for (const start of Object.values(f.starts)) expect(start).toHaveBeenCalledTimes(1)
    expect(f.localVm).toHaveBeenCalledTimes(1)
    const address = f.node.server.address()
    expect(f.localVm).toHaveBeenCalledWith(`http://127.0.0.1:${typeof address === 'object' && address?.port}`)
    expect(f.chatStart).toHaveBeenCalledTimes(1)
    await f.push.configureFCM()
    expect(f.chatStop).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
  f.node.startBackground()
  f.runtime.startBackground()
  for (const start of Object.values(f.starts)) expect(start).toHaveBeenCalledTimes(1)
})

it('holds local VM startup until listening when activated before the HTTP server is ready', async () => {
  const f = fixture(true)
  try {
    f.node.startBackground()
    f.node.startBackground()
    for (const start of Object.values(f.starts)) expect(start).toHaveBeenCalledTimes(1)
    expect(f.localVm).not.toHaveBeenCalled()
    await f.listen()
    expect(f.localVm).toHaveBeenCalledTimes(1)
    f.node.startBackground()
    expect(f.localVm).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('preserves automatic background startup for ordinary servers', async () => {
  const f = fixture(false)
  try {
    for (const start of Object.values(f.starts)) expect(start).toHaveBeenCalledTimes(1)
    expect(f.chatStop).toHaveBeenCalledTimes(1)
    expect(f.localVm).not.toHaveBeenCalled()
    await f.listen()
    expect(f.localVm).toHaveBeenCalledTimes(1)
    f.node.startBackground()
    for (const start of Object.values(f.starts)) expect(start).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})
