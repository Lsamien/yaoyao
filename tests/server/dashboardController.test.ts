// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { ServerDashboardController } from '../../src/server/dashboardController'

const origin = new URL('http://127.0.0.1:9119')
const target = 'gui/501/com.samien.hermes.dashboard.local'

function fixture(options: { upstream?: URL; platform?: NodeJS.Platform; label?: string; command?: string; owned?: { canRestart: boolean; restart(): Promise<void>; suspendChecks?(): () => void } } = {}) {
  let pid = 1043, listener = 1043, replacement = 2043, available = true, health = true
  const service = options.label ? `gui/501/${options.label}` : target
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === '/bin/launchctl' && args[0] === 'print') {
      if (!available || args[1] !== service) throw new Error('job not found')
      return `${service} = {\n\targuments = {\n\t\t${options.command ?? '/server/.hermes/venv/bin/python\n\t\t/server/.hermes/hermes-agent/hermes\n\t\tdashboard'}\n\t\t--host\n\t\t127.0.0.1\n\t}\n\tpid = ${pid}\n}`
    }
    if (command === '/usr/sbin/lsof') return `p${listener}\n`
    if (command === '/bin/launchctl' && args[0] === 'kickstart') { pid = replacement; listener = replacement; return '' }
    throw new Error('unexpected command')
  })
  const healthy = vi.fn(async () => health)
  const controller = new ServerDashboardController(options.upstream ?? origin, options.owned, {
    platform: options.platform ?? 'darwin', uid: 501, run, healthy, readyTimeoutMs: 15, pollIntervalMs: 1,
  })
  const mutations = () => run.mock.calls.filter(([, args]) => args[0] === 'kickstart')
  return { controller, run, healthy, mutations, set: (state: { available?: boolean; listener?: number; replacement?: number; healthy?: boolean }) => {
    if (state.available !== undefined) available = state.available
    if (state.listener !== undefined) listener = state.listener
    if (state.replacement !== undefined) replacement = state.replacement
    if (state.healthy !== undefined) health = state.healthy
  } }
}

it('discovers and restarts the server LaunchAgent, then verifies a new listener and HTTP health', async () => {
  const f = fixture()
  expect(f.controller.canRestart).toBe(false)
  await f.controller.refresh()
  expect(f.controller.canRestart).toBe(true)
  expect(f.mutations()).toEqual([])
  await f.controller.restart()
  expect(f.mutations()).toEqual([['/bin/launchctl', ['kickstart', '-k', target]]])
  expect(f.healthy).toHaveBeenCalledWith('http://127.0.0.1:9119')
  expect(f.controller.canRestart).toBe(true)
})

it('supports the standard Hermes LaunchAgent only when it owns the configured listener', async () => {
  const f = fixture({ label: 'ai.hermes.dashboard', command: '/server/.local/bin/hermes\n\t\tdashboard' })
  await f.controller.refresh(); await f.controller.restart()
  expect(f.mutations()[0]?.[1]).toEqual(['kickstart', '-k', 'gui/501/ai.hermes.dashboard'])
})

it.each([
  new URL('https://hermes.example'), new URL('http://192.168.1.5:9119'), new URL('http://127.0.0.1:9120'),
])('never runs local commands for an upstream on another server or port: %s', async upstream => {
  const owned = { canRestart: true, restart: vi.fn(async () => {}) }
  const f = fixture({ upstream, owned })
  await f.controller.refresh()
  expect(f.controller.canRestart).toBe(false)
  await expect(f.controller.restart()).rejects.toThrow('所在节点')
  expect(f.run).not.toHaveBeenCalled(); expect(owned.restart).not.toHaveBeenCalled()
})

it('does not run launchctl on an unsupported server OS', async () => {
  const f = fixture({ platform: 'linux' })
  await f.controller.refresh()
  await expect(f.controller.restart()).rejects.toThrow('尚未支持')
  expect(f.run).not.toHaveBeenCalled()
})

it.each(['missing', 'other-listener', 'other-command', 'multiple-listeners'])('refuses an unverified service: %s', async mode => {
  const f = fixture(mode === 'other-command' ? { command: '/usr/bin/node\n\t\tdashboard' } : {})
  if (mode === 'missing') f.set({ available: false })
  if (mode === 'other-listener') f.set({ listener: 999 })
  if (mode === 'multiple-listeners') {
    const original = f.run.getMockImplementation()!
    f.run.mockImplementation(async (command, args) => command === '/usr/sbin/lsof' ? 'p1043\np999\n' : original(command, args))
  }
  await f.controller.refresh()
  expect(f.controller.canRestart).toBe(false)
  await expect(f.controller.restart()).rejects.toThrow('未识别到')
  expect(f.mutations()).toEqual([])
})

it('revalidates ownership immediately before restarting, regardless of an earlier available status', async () => {
  const f = fixture()
  await f.controller.refresh(); expect(f.controller.canRestart).toBe(true)
  f.set({ listener: 999 })
  await expect(f.controller.restart()).rejects.toThrow('未识别到')
  expect(f.mutations()).toEqual([])
  expect(f.controller.canRestart).toBe(false)
})

it.each(['same-pid', 'unhealthy'])('does not report success until replacement is verified: %s', async mode => {
  const f = fixture()
  f.set(mode === 'same-pid' ? { replacement: 1043 } : { healthy: false })
  await expect(f.controller.restart()).rejects.toThrow('未恢复健康')
  expect(f.controller.canRestart).toBe(false)
  f.set({ replacement: 3043, healthy: true })
  await f.controller.restart()
  expect(f.controller.canRestart).toBe(true)
})

it('preserves owned-child restart support and never touches a system service in that case', async () => {
  const owned = { canRestart: true, restart: vi.fn(async () => {}) }
  const f = fixture({ owned })
  await f.controller.refresh(); await f.controller.restart()
  expect(owned.restart).toHaveBeenCalledTimes(1)
  expect(f.run).not.toHaveBeenCalled()
  expect(f.healthy).toHaveBeenCalledWith(origin.origin)
})

it.each([true, false])('suspends automatic starts during a system restart and releases them on success=%s', async success => {
  const resume = vi.fn()
  const owned = { canRestart: false, restart: vi.fn(async () => {}), suspendChecks: vi.fn(() => resume) }
  const f = fixture({ owned })
  f.healthy.mockImplementation(async () => {
    expect(owned.suspendChecks).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    return success
  })
  if (success) await f.controller.restart()
  else await expect(f.controller.restart()).rejects.toThrow('未恢复健康')
  expect(owned.restart).not.toHaveBeenCalled()
  expect(resume).toHaveBeenCalledTimes(1)
})

it('serializes restarts and stops verification when the server shuts down', async () => {
  let release!: () => void
  const owned = { canRestart: true, restart: vi.fn(() => new Promise<void>(done => { release = done })) }
  const f = fixture({ owned })
  const pending = f.controller.restart()
  await expect(f.controller.restart()).rejects.toThrow('正在重启')
  f.controller.stop(); release()
  await expect(pending).rejects.toThrow('未恢复健康')
  expect(f.controller.canRestart).toBe(false)
  expect(f.run).not.toHaveBeenCalled()
})
