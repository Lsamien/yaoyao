import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { consoleClient } from './consoleClient.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'
import {
  APNsConfigurationManager,
  apnsConfigurationPath,
  validateAPNsConfiguration,
} from '../../src/server/apnsConfiguration.js'
import {
  FCMConfigurationManager,
  fcmConfigurationPath,
} from '../../src/server/fcmConfiguration.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('iOS push routes', () => {
  it('configures FCM independently and registers Android FIDs without returning them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-fcm-web-config-'))
    roots.push(home)
    const serviceAccountFile = join(home, 'firebase-service-account.json')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(serviceAccountFile, JSON.stringify({
      type: 'service_account',
      project_id: 'yaoyao-test-project',
      client_email: 'push@yaoyao-test-project.iam.gserviceaccount.com',
      private_key: privateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    }), { mode: 0o600 })
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const push = new PushCoordinator({
      home,
      autoFlush: false,
      fcmProviderFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
    })
    const fcmConfiguration = new FCMConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe: async () => undefined },
    )
    const runtime = createAuthenticatedApplication({ config, push, fcmConfiguration })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    const admin = await consoleClient(runtime)
    const mutation = () => admin.agent.put('/api/app/system/push-config/fcm')
      .set('Host', admin.host)
      .set('Origin', admin.origin)
      .send({
        serviceAccountFile,
        projectId: 'yaoyao-test-project',
        packageName: 'cn.samien.yaoyao.hermes',
      })

    await mutation().expect(403)
    const saved = await mutation().set('X-CSRF-Token', admin.csrf()).expect(200)
    expect(saved.body).toMatchObject({
      configured: false,
      providers: {
        apns: { configured: false },
        fcm: {
          configured: true,
          healthy: true,
          source: 'file',
          editable: true,
          serviceAccountFile: realpathSync(serviceAccountFile),
          projectId: 'yaoyao-test-project',
          packageName: 'cn.samien.yaoyao.hermes',
        },
      },
    })
    expect(statSync(fcmConfigurationPath(home)).mode & 0o777).toBe(0o600)
    expect(readFileSync(fcmConfigurationPath(home), 'utf8')).not.toContain('private_key')

    const installationID = '11111111-1111-4111-8111-111111111111'
    const accountID = '22222222-2222-4222-8222-222222222222'
    const fid = 'fcm-registration-id-1234567890'
    const registered = await agent.put(`/api/push/v1/installations/${installationID}/accounts/${accountID}`)
      .set('Host', '127.0.0.1:15300')
      .set('Origin', 'http://127.0.0.1:15300')
      .send({ platform: 'android', fid, appVersion: '1.0.0' })
      .expect(200)
    expect(registered.body.installation).toMatchObject({
      platform: 'android', installationId: installationID, clientAccountId: accountID,
    })
    expect(JSON.stringify(registered.body)).not.toContain(fid)
    expect(push.fcmStatus()).toMatchObject({ registrationCount: 1 })

    const capabilities = await agent.get('/api/push/v1/capabilities')
      .set('Host', '127.0.0.1:15300')
      .expect(200)
    expect(capabilities.body).toMatchObject({
      enabled: false,
      platforms: { ios: { enabled: false }, android: { enabled: true, packageName: 'cn.samien.yaoyao.hermes' } },
    })
  })

  it('validates and enables a server-local APNs key path without blocking broad permissions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-web-config-'))
    roots.push(home)
    const keyFile = join(home, 'AuthKey_TEST.p8')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(keyFile, privateKey, { mode: 0o644 })
    chmodSync(keyFile, 0o644)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const push = new PushCoordinator({
      home,
      autoFlush: false,
      providerFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
    })
    const apnsConfiguration = new APNsConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe: async () => undefined },
    )
    const runtime = createAuthenticatedApplication({ config, push, apnsConfiguration })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    const admin = await consoleClient(runtime)
    const mutation = () => admin.agent.put('/api/app/system/push-config')
      .set('Host', admin.host)
      .set('Origin', admin.origin)
      .send({
        keyFile,
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        topic: 'cn.samien.yaoyao.hermes',
        environments: ['development', 'production'],
      })

    await mutation().expect(403)
    const saved = await mutation().set('X-CSRF-Token', admin.csrf()).expect(200)
    expect(saved.body).toMatchObject({
      configured: true,
      healthy: true,
      source: 'file',
      editable: true,
      keyFile: realpathSync(keyFile),
      environments: ['development', 'production'],
      warnings: [{ code: 'apns_key_permissions', actualMode: '0644', recommendedMode: '0600' }],
    })
    expect(statSync(apnsConfigurationPath(home)).mode & 0o777).toBe(0o600)
    await admin.call('get', '/api/app/system/push-status')
      .expect(200, /"source":"file"/)
  })

  it('keeps environment-managed APNs configuration read-only through the admin API', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-env-managed-'))
    roots.push(home)
    const keyFile = join(home, 'AuthKey_TEST.p8')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(keyFile, privateKey, { mode: 0o600 })
    const validated = validateAPNsConfiguration({
      keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'cn.samien.yaoyao.hermes',
      environments: ['development'],
    })
    const initial = { ...validated, source: 'environment' as const, editable: false }
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      apns: validated.config,
      apnsSettings: initial,
    }
    const push = new PushCoordinator({
      home, apns: validated.config,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
      autoFlush: false,
    })
    const apnsConfiguration = new APNsConfigurationManager(home, initial, { probe: async () => undefined })
    const runtime = createAuthenticatedApplication({ config, push, apnsConfiguration })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)

    const admin = await consoleClient(runtime)
    const response = await admin.call('put', '/api/app/system/push-config')
      .send({
        keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'cn.samien.yaoyao.hermes',
        environments: ['development'],
      })
      .expect(409)
    expect(response.body).toMatchObject({ code: 'apns_environment_managed' })
  })

  it('registers an installation, manages team subscriptions, badge, and admin status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-routes-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      apns: { keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes' },
    }
    const push = new PushCoordinator({
      home,
      apns: config.apns,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
      autoFlush: false,
    })
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      if (path.endsWith('/messages')) return Response.json({ items: [{ id: 'baseline', seq: 12 }] })
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createAuthenticatedApplication({ config, push, fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const host = (value: request.Test) => value.set('Host', '127.0.0.1:15300')
      .set('Origin', 'http://127.0.0.1:15300')
    const installationID = '11111111-1111-4111-8111-111111111111'
    const accountID = '22222222-2222-4222-8222-222222222222'
    const a = runtime.workspace.createAgent('test-admin', {name:'甲',profile:'default'})
    const b = runtime.workspace.createAgent('test-admin', {name:'乙',profile:'default'})
    const roomID = runtime.workspace.createGroup('test-admin', {name:'通知测试',memberIds:[a.id,b.id],administratorId:a.id}).id
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)

    const capabilities = await host(agent.get('/api/push/v1/capabilities')).expect(200)
    expect(capabilities.body).toMatchObject({
      protocolVersion: 1,
      enabled: true,
      topic: 'cn.samien.yaoyao.hermes',
      maximumSummaryCharacters: 180,
    })
    await agent.get('/api/app/push/v1/capabilities').set('Host', '127.0.0.1:15300').expect(200)

    const registered = await host(agent.put(`/api/push/v1/installations/${installationID}/accounts/${accountID}`))
      .send({ token: 'ab'.repeat(32), environment: 'development', appVersion: '1.2 (139)' })
      .expect(200)
    expect(registered.body.installation).toMatchObject({
      installationId: installationID,
      clientAccountId: accountID,
      environment: 'development',
    })

    await host(agent.put(`/api/app/push/v1/group-subscriptions/${roomID}`))
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ enabled: true })
      .expect(200, /"enabled":true/)
    const subscriptions = await host(agent.get('/api/app/push/v1/group-subscriptions')).expect(200)
    expect(subscriptions.body.roomIds).toEqual([roomID])

    await host(agent.post(`/api/push/v1/installations/${installationID}/accounts/${accountID}/badge-reset`))
      .send({})
      .expect(200, { badge: 0 })
    const status = await (await consoleClient(runtime)).call('get', '/api/app/system/push-status').expect(200)
    expect(status.body).toMatchObject({ configured: true, healthy: true, registrationCount: 1, topic: 'cn.samien.yaoyao.hermes' })

    await host(agent.delete(`/api/push/v1/installations/${installationID}/accounts/${accountID}`))
      .expect(200, /"removed":true/)
    expect(push.status().registrationCount).toBe(0)
  })

  it('rejects malformed registration and subscription input', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-validation-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const runtime = createAuthenticatedApplication({ config })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const headers = (value: request.Test) => value
      .set('Host', '127.0.0.1:15300')
      .set('Origin', 'http://127.0.0.1:15300')

    await headers(agent.put('/api/push/v1/installations/11111111-1111-4111-8111-111111111111/accounts/22222222-2222-4222-8222-222222222222'))
      .send({ token: 'not-a-token', environment: 'unknown' })
      .expect(400, /environment must be development or production/)
    await headers(agent.put('/api/push/v1/group-subscriptions/33333333-3333-4333-8333-333333333333'))
      .send({ enabled: 'yes' })
      .expect(400, /enabled must be a boolean/)
  })
})
