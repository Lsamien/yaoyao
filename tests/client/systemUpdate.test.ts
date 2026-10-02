import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applySystemUpdate,
  activateSystemUpdate,
  checkSystemUpdate,
  rollbackSystemUpdate,
  systemUpdateJob,
  systemUpdateStatus,
} from '@/api/systemUpdate'
import { setApiCsrfToken } from '@/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
  setApiCsrfToken('')
})

describe('system update client protocol', () => {
  it('uses authenticated app routes and protects mutations with CSRF', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return new Response(JSON.stringify({
        current: { schemaVersion: 1, releaseVersion: '0.2.0', webVersion: '0.2.0', pluginVersion: '1.7.1', gitTag: 'v0.2.0' },
        versionsMatch: true,
        installationMode: 'source',
        updateAvailable: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    setApiCsrfToken('csrf-system-update')

    await systemUpdateStatus()
    await checkSystemUpdate()
    await applySystemUpdate('0.3.0')
    await systemUpdateJob('11111111-1111-4111-8111-111111111111')
    await rollbackSystemUpdate()
    await activateSystemUpdate('11111111-1111-4111-8111-111111111111')

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/system/update/status',
      '/api/app/system/update/check',
      '/api/app/system/update/apply',
      '/api/app/system/update/jobs/11111111-1111-4111-8111-111111111111',
      '/api/app/system/update/rollback',
      '/api/app/system/update/activate',
    ])
    expect(new Headers(calls[1]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-system-update')
    expect(calls[2]!.init?.body).toBe(JSON.stringify({ targetVersion: '0.3.0' }))
    expect(new Headers(calls[4]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-system-update')
    expect(calls[5]!.init?.body).toBe(JSON.stringify({ jobID: '11111111-1111-4111-8111-111111111111' }))
    expect(new Headers(calls[5]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-system-update')
  })
})
