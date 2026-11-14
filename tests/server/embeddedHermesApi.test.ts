import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmbeddedHermes, type EmbeddedHermes } from '../../src/server/hermes/embedded.js'
import { kernelPaths } from '../../src/server/hermes/paths.js'

const kernel = existsSync(kernelPaths().python)
const env = { ...process.env, YAOVI_HERMES_TEST_OFFLINE: '1' }

describe.skipIf(!kernel)('embedded Hermes dashboard API', () => {
  let home = ''
  let hermes: EmbeddedHermes | undefined
  afterEach(() => { hermes?.close(); hermes = undefined; if (home) rmSync(home, { recursive: true, force: true }) })

  const call = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => {
    const response = await hermes!.api.handle({ method, path, search: new URLSearchParams(query), body })
    return { status: response.status, body: JSON.parse(response.body.toString() || 'null') }
  }

  it('serves native dashboard shapes without any listening Hermes service', async () => {
    home = mkdtempSync(join(tmpdir(), 'yaoyao-hermes-api-'))
    hermes = createEmbeddedHermes(home, { env })
    expect((await call('GET', '/api/status')).body).toMatchObject({ auth_required: false, embedded: true })
    expect((await call('GET', '/api/sessions', { limit: '5' })).body).toMatchObject({ sessions: [], total: 0 })
    const profiles = await call('GET', '/api/profiles')
    expect(profiles.status).toBe(200)
    expect(profiles.body.profiles.map((p: { name: string }) => p.name)).toContain('default')
    const options = await call('GET', '/api/model/options')
    expect(options.status).toBe(200)
    expect(Array.isArray(options.body.providers)).toBe(true)
    expect((await call('GET', '/api/sessions/missing/messages')).status).toBe(404)
    expect((await call('GET', '/api/kanban/boards')).status).toBe(404)
    expect((await call('POST', '/api/auth/ws-ticket')).status).toBe(410)
  }, 120_000)

  it('writes custom model endpoints into the embedded config.yaml', async () => {
    home = mkdtempSync(join(tmpdir(), 'yaoyao-hermes-api-'))
    hermes = createEmbeddedHermes(home, { env })
    const created = await call('POST', '/api/providers/custom-endpoints', {}, {
      name: 'local-test', base_url: 'http://127.0.0.1:9/v1', model: 'test-model', api_key: 'sk-local-test-key-0000',
    })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const listed = await call('GET', '/api/providers/custom-endpoints')
    expect(JSON.stringify(listed.body)).toContain('local-test')
    expect(existsSync(join(home, 'hermes', 'config.yaml'))).toBe(true)
  }, 120_000)
})
