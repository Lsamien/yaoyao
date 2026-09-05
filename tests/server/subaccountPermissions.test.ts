// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore } from '../../src/server/localAuth'

let runtime: ApplicationRuntime, home: string, admin: ReturnType<typeof request.agent>, child: ReturnType<typeof request.agent>
let adminCSRF: string, childCSRF: string, childID: string, upstreamPaths: string[]
const host = '127.0.0.1:15300'
function call(client: ReturnType<typeof request.agent>, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, csrf = '') {
  return client[method](path).set('Host', host).set('Origin', `http://${host}`).set('X-CSRF-Token', csrf)
}
async function signInChild(password = 'child-password') {
  const boot = await call(child, 'get', '/api/app/bootstrap').expect(200)
  const login = await call(child, 'post', '/api/app/login', boot.body.csrfToken).send({ username: 'child', password }).expect(200)
  childCSRF = login.body.csrfToken
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-subaccount-')); upstreamPaths = []
  const config = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_UPSTREAM_URL: 'http://127.0.0.1:1' })
  runtime = createApplication({ config, fetchImpl: (async input => {
    const path = new URL(String(input)).pathname; upstreamPaths.push(path)
    if (path === '/api/status') return Response.json({ auth_required: true })
    if (path === '/api/auth/me') return Response.json({ user_id: 'service' })
    if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'allowed' }, { name: 'private' }] })
    return Response.json({ ok: true })
  }) as typeof fetch })
  vi.spyOn(runtime.workspaceRuntime, 'wake').mockImplementation(() => {})
  admin = request.agent(runtime.app.callback()); child = request.agent(runtime.app.callback())
  const boot = await call(admin, 'get', '/api/app/bootstrap').expect(200)
  const setup = await call(admin, 'post', '/api/app/setup', boot.body.csrfToken).send({ username: 'owner', password: 'owner-password' }).expect(200)
  adminCSRF = setup.body.csrfToken
  const created = await call(admin, 'post', '/api/app/admin/users', adminCSRF).send({ username: 'child', password: 'temporary-password', assignedProfiles: ['allowed'] }).expect(201)
  childID = created.body.id
  await signInChild('temporary-password')
  const changed = await call(child, 'put', '/api/app/account/credentials', childCSRF).send({ currentPassword: 'temporary-password', newPassword: 'child-password' }).expect(200)
  childCSRF = changed.body.csrfToken
})
afterEach(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('subaccount Bot-only security boundary with real login sessions', () => {
  it('persists assignment, filters sources, hides native profiles and rejects unassigned/local-node spoofing', async () => {
    expect((await call(child, 'get', '/api/app/bootstrap')).body.profiles).toEqual([])
    expect((await call(child, 'get', '/api/profiles')).body.profiles).toEqual([])
    const sources = await call(child, 'get', '/api/app/agents/sources').expect(200)
    expect(sources.body.sources.map((s: any) => s.profile)).toEqual(['allowed'])
    expect(new LocalAuthStore(home).canUseSource(childID, 'local', 'allowed')).toBe(true)
    expect(new LocalAuthStore(home).canUseSource(childID, 'local', 'private')).toBe(false)
    const caps = await call(child, 'get', '/api/app/capabilities').expect(200)
    expect(caps.body.features).not.toContain('nodes')
    await call(child, 'post', '/api/app/agents', childCSRF).send({ name: 'mine', profile: 'allowed' }).expect(201)
    for (const input of [{ profile: 'private' }, { profile: 'allowed', nodeId: randomUUID() }, { profile: 'ALLOWED' }]) {
      await call(child, 'post', '/api/app/agents', childCSRF).send({ name: 'forbidden', ...input }).expect(403)
    }
  })

  it('denies native REST, realtime, relay, settings secrets and administration before any upstream request', async () => {
    upstreamPaths.length = 0
    for (const path of ['/Users/test/.hermes/cache/private.png', '/Users/test/.hermes/profiles/private/images/private.png', '/Users/test/Agents/private.txt', '/attachments/private.txt', '/api/sessions', '/api/profiles/sessions', '/api/profile-identities', '/api/files/download?path=/tmp/private', '/api/realtime/capabilities', '/api/app/hermes-bot/local/api/profiles', '/api/app/admin/users', '/api/app/system/push-config', '/api/app/voice/runtime', '/api/app/tts/settings', '/api/app/models', '/api/app/nodes', '/api/app/session-context/test']) {
      await call(child, 'get', path).expect(403)
    }
    for (const path of ['/api/realtime/channels', '/api/app/nodes', '/api/app/agents/remote', '/api/app/agents/remote/', '/api/app/pairings', '/api/app/admin/users']) {
      await call(child, 'post', path, childCSRF).send({ channel: 'chat' }).expect(403)
    }
    expect(upstreamPaths).toEqual([])
  })

  it('keeps agents, conversations, files, runs and interactions isolated by owner', async () => {
    const a = await call(admin, 'post', '/api/app/agents', adminCSRF).send({ name: 'admin bot', profile: 'private' }).expect(201)
    const c = (await call(admin, 'get', '/api/app/conversations')).body.conversations[0]
    expect((await call(child, 'get', '/api/app/agents')).body.agents).toEqual([])
    expect((await call(child, 'get', '/api/app/conversations')).body.conversations).toEqual([])
    for (const path of [`/api/app/conversations/${c.id}`, `/api/app/conversations/${c.id}/messages`, `/api/app/files/${randomUUID()}/download`]) await call(child, 'get', path).expect(404)
    await call(child, 'patch', `/api/app/agents/${a.body.agent.id}`, childCSRF).send({ name: 'stolen' }).expect(404)
    await call(child, 'post', `/api/app/conversations/${c.id}/messages`, childCSRF).send({ requestId: randomUUID(), content: 'stolen' }).expect(404)
    await call(child, 'post', `/api/app/runs/${randomUUID()}/reconcile`, childCSRF).send({}).expect(404)
    await call(child, 'post', `/api/app/interactions/${randomUUID()}/respond`, childCSRF).send({ answer: 'approve' }).expect(404)
  })

  it('invalidates sessions and stops existing work when assignment is revoked, including old agent references', async () => {
    const a = (await call(child, 'post', '/api/app/agents', childCSRF).send({ name: 'mine', profile: 'allowed' }).expect(201)).body.agent
    const c = (await call(child, 'get', '/api/app/conversations')).body.conversations[0]
    await call(child, 'post', `/api/app/conversations/${c.id}/messages`, childCSRF).send({ requestId: randomUUID(), content: 'allowed' }).expect(202)
    const stop = vi.spyOn(runtime.workspaceRuntime, 'stopConversation')
    await call(admin, 'patch', `/api/app/admin/users/${childID}`, adminCSRF).send({ assignedProfiles: [] }).expect(200)
    expect(stop).toHaveBeenCalledWith(childID, c.id)
    await call(child, 'get', '/api/app/agents').expect(401)
    await signInChild()
    expect((await call(child, 'get', '/api/app/agents/sources')).body.sources).toEqual([])
    await call(child, 'post', `/api/app/conversations/${c.id}/messages`, childCSRF).send({ requestId: randomUUID(), content: 'revoked' }).expect(403)
    await call(child, 'patch', `/api/app/agents/${a.id}`, childCSRF).send({ name: 'revoked' }).expect(403)
    await call(child, 'post', '/api/app/conversations', childCSRF).send({ name: 'bypass', memberIds: [a.id], administratorId: a.id }).expect(403)
  })
})
