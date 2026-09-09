import { describe, expect, it, vi } from 'vitest'
import { configuredWorkingDirectory, applyWorkingDirectory } from '../../src/server/sessionWorkingDirectory.js'

describe('profile working directory', () => {
  it.each(['/remote/agent work', '~/Agents', '.'])('leaves %s to Hermes to resolve on its own host', async cwd => {
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify({ terminal: { cwd } })) }))
    expect(await configuredWorkingDirectory(request, 'work')).toBe(cwd)
    expect(request).toHaveBeenCalledWith('/api/config', { search: new URLSearchParams({ profile: 'work' }), cache: 'reload' })
    const rpc = vi.fn(async () => ({ cwd: '/resolved/on/hermes' }))
    expect(await applyWorkingDirectory(rpc, 'session', cwd)).toEqual({ configured: cwd, resolved: '/resolved/on/hermes' })
    expect(rpc).toHaveBeenCalledWith('session.cwd.set', { session_id: 'session', cwd })
  })

  it('fails closed on unreadable configuration or unconfirmed cwd', async () => {
    await expect(configuredWorkingDirectory(async () => ({ status: 403, headers: new Headers(), body: Buffer.from('{}') }), 'work'))
      .rejects.toMatchObject({ code: 'working_directory_unavailable' })
    await expect(applyWorkingDirectory(async () => ({}), 'session', '/configured'))
      .rejects.toMatchObject({ code: 'working_directory_unconfirmed' })
  })
})
