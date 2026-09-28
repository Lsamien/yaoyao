import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { APNsRequest, APNsSendResult } from '../../src/server/apns.js'
import type { FCMRequest } from '../../src/server/fcm.js'
import { loadServerConfig, type APNsProviderConfig } from '../../src/server/config.js'
import {
  PushCoordinator,
  type FCMSender,
  type PushSender,
} from '../../src/server/pushCoordinator.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'yaoyao-push-'))
  roots.push(value)
  return value
}

const apns: APNsProviderConfig = {
  keyFile: '/private/not-read-when-provider-is-injected.p8',
  keyId: 'KEY1234567',
  teamId: 'TEAM123456',
  topic: 'cn.samien.yaoyao.hermes',
}

class FakeSender implements PushSender {
  readonly requests: APNsRequest[] = []
  readonly results: APNsSendResult[] = []
  closed = false

  async send(request: APNsRequest): Promise<APNsSendResult> {
    this.requests.push(request)
    return this.results.shift() ?? { disposition: 'success', status: 200 }
  }

  close(): void { this.closed = true }
}

function register(coordinator: PushCoordinator, suffix = '1') {
  return coordinator.registerInstallation({
    userId: 'user-a',
    installationId: `phone-${suffix}`,
    clientAccountId: 'account-a',
    deviceToken: 'ab'.repeat(16 + Number(suffix)),
    environment: 'development',
    appVersion: '1.2.3',
  })
}

describe('push configuration', () => {
  it('delivers once to each device and resets only the opened device badge', async () => {
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender, autoFlush: false })
    register(coordinator, '1')
    register(coordinator, '2')
    expect(coordinator.enqueue({ eventId: 'shared-reply', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })).toBe(2)
    await coordinator.flushDue()
    coordinator.resetBadge('user-a', 'phone-1', 'account-a')
    expect(coordinator.enqueue({ eventId: 'next-reply', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })).toBe(2)
    await coordinator.flushDue()
    const badges = sender.requests.slice(2).map(request => (request.payload.aps as { badge: number }).badge).sort()
    expect(badges).toEqual([1, 2])
    coordinator.close()
  })

  it('replaces an old installation for the same APNs endpoint and delivers one banner after reinstall', async () => {
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender, autoFlush: false })
    const endpoint = { userId: 'user-a', deviceToken: 'bc'.repeat(32), environment: 'production' as const }
    coordinator.registerInstallation({ ...endpoint, installationId: 'old-native', clientAccountId: 'old-account' })
    coordinator.enqueue({ eventId: 'old-pending', userId: 'user-a', kind: 'chat.completed', title: '旧通知', body: '已进入应用' })
    coordinator.registerInstallation({ ...endpoint, installationId: 'expo', clientAccountId: 'new-account' })
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 0 })
    expect(coordinator.enqueue({ eventId: 'reply', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })).toBe(1)
    await coordinator.flushDue()
    expect(sender.requests).toHaveLength(1)
    expect(sender.requests[0]!.payload).toMatchObject({ clientAccountId: 'new-account', aps: { badge: 1 } })
    expect(coordinator.resetBadge('user-a', 'expo', 'new-account')).toBe(0)
    coordinator.close()
  })

  it('does not retire another account, environment, or device when replacing an endpoint', () => {
    const coordinator = new PushCoordinator({ home: root(), apns, provider: new FakeSender(), autoFlush: false })
    const endpoint = { userId: 'user-a', deviceToken: 'bc'.repeat(32), environment: 'production' as const }
    coordinator.registerInstallation({ ...endpoint, installationId: 'phone', clientAccountId: 'a' })
    coordinator.registerInstallation({ ...endpoint, userId: 'user-b', installationId: 'phone', clientAccountId: 'b' })
    coordinator.registerInstallation({ ...endpoint, environment: 'development', installationId: 'debug', clientAccountId: 'a' })
    coordinator.registerInstallation({ ...endpoint, deviceToken: 'de'.repeat(32), installationId: 'other-phone', clientAccountId: 'a' })
    coordinator.registerInstallation({ ...endpoint, installationId: 'new-phone-id', clientAccountId: 'new-a' })
    expect(coordinator.status().registrationCount).toBe(4)
    expect(coordinator.enqueue({ eventId: 'reply', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })).toBe(3)
    coordinator.close()
  })

  it('keeps APNs optional and reports partial configuration without preventing startup', () => {
    const home = root()
    expect(loadServerConfig({ HERMES_YAOYAO_HOME: home }).apns).toBeUndefined()
    const partial = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567' })
    expect(partial.apns).toBeUndefined()
    expect(partial.apnsConfigurationError).toMatch(/absolute local path/)
  })

  it('loads a complete provider configuration and the default topic', () => {
    const directory = root()
    const keyFile = join(directory, 'AuthKey.p8')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const config = loadServerConfig({
      HERMES_YAOYAO_HOME: directory,
      HERMES_YAOYAO_APNS_KEY_FILE: keyFile,
      HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567',
      HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123456',
    })
    expect(config.apns).toEqual({
      keyFile: realpathSync(keyFile),
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      topic: 'cn.samien.yaoyao.hermes',
      environments: ['development', 'production'],
    })
  })

  it('disables an unreadable provider key as a capability error', () => {
    const keyFile = join(root(), 'AuthKey.p8')
    writeFileSync(keyFile, 'not a private key')
    const config = loadServerConfig({
      HERMES_YAOYAO_HOME: dirname(keyFile),
      HERMES_YAOYAO_APNS_KEY_FILE: keyFile,
      HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567',
      HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123456',
    })
    expect(config.apns).toBeUndefined()
    expect(config.apnsConfigurationError).toMatch(/ES256 private key/)
  })
})

describe('PushCoordinator durable state and delivery', () => {
  it('atomically migrates schema 1 APNs state to schema 2 without changing durable recovery data', () => {
    const home = root()
    const directory = join(home, 'push')
    mkdirSync(directory)
    const statePath = join(directory, 'state.json')
    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      installations: [{
        userId: 'user-a', installationId: 'phone-1', clientAccountId: 'account-a',
        deviceToken: 'ab'.repeat(32), environment: 'development', badge: 2, updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      groupSubscriptions: [{
        userId: 'user-a', roomId: 'room-1', enabled: true, updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      outbox: [{
        id: 'outbox-1', eventId: 'pending-event', userId: 'user-a', installationId: 'phone-1',
        clientAccountId: 'account-a', kind: 'chat.completed', title: '完成', body: '正文',
        data: { sessionId: 'session-1' }, createdAt: 1, expiresAt: 4_000_000_000_000,
        attempts: 2, nextAttemptAt: 2_000_000_000_000,
      }],
      processedEvents: { existing: 123 },
      groupWatch: { epoch: 'epoch-1', cursor: 7 },
      chatJobs: [],
      ambiguousChatSessions: { ambiguous: 456 },
      status: { lastSuccessAt: '2026-01-01T00:00:00.000Z' },
    }))

    const coordinator = new PushCoordinator({ home, autoFlush: false })
    const migrated = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, any>
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      installations: [{ platform: 'ios', environment: 'development' }],
      outbox: [{ platform: 'ios', id: 'outbox-1', attempts: 2 }],
      processedEvents: { existing: 123 },
      groupWatch: { epoch: 'epoch-1', cursor: 7 },
      ambiguousChatSessions: { ambiguous: 456 },
      providerStatus: { ios: { lastSuccessAt: '2026-01-01T00:00:00.000Z' }, android: {} },
    })
    expect(migrated).not.toHaveProperty('status')
    coordinator.close()
  })

  it('isolates an unexpected APNs sender exception from the FCM queue and redacts its target', async () => {
    const deviceToken = 'ab'.repeat(32)
    const fcmRequests: FCMRequest[] = []
    const coordinator = new PushCoordinator({
      home: root(),
      apns,
      provider: { send: async () => { throw new Error(`transport leaked ${deviceToken}`) } },
      fcm: {
        serviceAccountFile: '/private/not-read-when-provider-is-injected.json',
        projectId: 'yaoyao-test-project',
        packageName: 'cn.samien.yaoyao.hermes',
      },
      fcmProvider: {
        send: async request => {
          fcmRequests.push(request)
          return { disposition: 'success', status: 200 }
        },
      },
      autoFlush: false,
    })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-ios', clientAccountId: 'account-a',
      deviceToken, environment: 'development',
    })
    coordinator.registerInstallation({
      platform: 'android', userId: 'user-a', installationId: 'phone-android', clientAccountId: 'account-a',
      fid: 'fcm-registration-id-1234567890',
    })
    expect(coordinator.enqueue({
      eventId: 'dual-provider-event', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文',
    })).toBe(2)

    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1, retried: 1 })
    expect(fcmRequests).toHaveLength(1)
    expect(coordinator.status()).toMatchObject({ pendingCount: 1, healthy: false })
    expect(coordinator.status().lastError).not.toContain(deviceToken)
    expect(coordinator.fcmStatus()).toMatchObject({ pendingCount: 0, healthy: true })
    coordinator.close()
  })

  it('keeps Android FIDs private and delivers high-priority FCM data independently of APNs', async () => {
    const requests: FCMRequest[] = []
    const sender: FCMSender = {
      send: async request => {
        requests.push(request)
        return { disposition: 'success', status: 200 }
      },
    }
    const coordinator = new PushCoordinator({
      home: root(),
      fcm: {
        serviceAccountFile: '/private/not-read-when-provider-is-injected.json',
        projectId: 'yaoyao-test-project',
        packageName: 'cn.samien.yaoyao.hermes',
      },
      fcmProvider: sender,
      autoFlush: false,
    })
    const fid = 'fcm-registration-id-1234567890'
    expect(coordinator.registerInstallation({
      platform: 'android', userId: 'user-a', installationId: 'phone-android', clientAccountId: 'account-a',
      fid, appVersion: '1.0.0',
    })).toEqual(expect.objectContaining({ platform: 'android', installationId: 'phone-android' }))
    expect(coordinator.registerInstallation({
      platform: 'android', userId: 'user-a', installationId: 'phone-android', clientAccountId: 'account-a', fid,
    })).not.toHaveProperty('fid')
    expect(coordinator.capabilities()).toMatchObject({
      enabled: false,
      platforms: { ios: { enabled: false }, android: { enabled: true, provider: 'fcm' } },
    })
    expect(coordinator.isAnyProviderEnabled()).toBe(true)
    expect(coordinator.enqueue({
      eventId: 'android-event', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文',
      collapseId: 'chat:1', data: { sessionId: 'session-1' },
    })).toBe(1)
    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1 })
    expect(requests).toEqual([expect.objectContaining({
      fid,
      priority: 'high',
      data: expect.objectContaining({
        eventId: 'android-event', kind: 'chat.completed', title: '完成', body: '正文',
        collapseId: 'chat:1', sessionId: 'session-1',
      }),
    })])
    expect(coordinator.status()).toMatchObject({ configured: false, registrationCount: 0, pendingCount: 0 })
    expect(coordinator.fcmStatus()).toMatchObject({ configured: true, healthy: true, registrationCount: 1, pendingCount: 0 })
    coordinator.close()
  })

  it('hot-swaps during an active flush without closing the in-flight provider early', async () => {
    const home = root()
    let releaseSend!: (value: APNsSendResult) => void
    const oldSender: PushSender & { closed: boolean } = {
      closed: false,
      send: () => new Promise(resolve => { releaseSend = resolve }),
      close() { this.closed = true },
    }
    const replacement = new FakeSender()
    const coordinator = new PushCoordinator({
      home, apns, provider: oldSender, autoFlush: false,
      providerFactory: () => replacement,
    })
    register(coordinator)
    coordinator.enqueue({
      eventId: 'active-flush', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '已完成',
    })
    const flush = coordinator.flushDue()
    const replacementOperation = coordinator.configureAPNs({ ...apns, keyId: 'NEWKEY1234' })
    await replacementOperation
    expect(oldSender.closed).toBe(false)
    expect(coordinator.capabilities().enabled).toBe(true)

    releaseSend({ disposition: 'unregister', status: 400, reason: 'BadDeviceToken' })
    await flush
    await Promise.resolve()
    expect(oldSender.closed).toBe(true)
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 1 })
    await coordinator.flushDue()
    expect(replacement.requests).toHaveLength(1)
    expect(coordinator.status().pendingCount).toBe(0)
  })

  it('hot-enables providers and only queues installations from selected environments', async () => {
    const home = root()
    const senders: FakeSender[] = []
    const coordinator = new PushCoordinator({
      home,
      autoFlush: false,
      providerFactory: () => {
        const sender = new FakeSender()
        senders.push(sender)
        return sender
      },
    })
    const changes: boolean[] = []
    coordinator.onEnabledChange(enabled => { changes.push(enabled) })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-development', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development',
    })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-production', clientAccountId: 'account-a',
      deviceToken: 'cd'.repeat(32), environment: 'production',
    })

    await coordinator.configureAPNs({ ...apns, environments: ['production'] })
    expect(coordinator.capabilities()).toMatchObject({ enabled: true, environments: ['production'] })
    expect(coordinator.enqueue({
      eventId: 'environment-event', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '已完成',
    })).toBe(1)
    await coordinator.flushDue()
    expect(senders[0]!.requests).toHaveLength(1)
    expect(senders[0]!.requests[0]!.environment).toBe('production')

    await coordinator.configureAPNs()
    expect(senders[0]!.closed).toBe(true)
    expect(coordinator.capabilities().enabled).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('persists private registrations, subscriptions, outbox delivery, and badge state', async () => {
    const home = root()
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home, apns, provider: sender, autoFlush: false })
    expect(coordinator.capabilities()).toMatchObject({
      protocolVersion: 1, enabled: true, topic: apns.topic, maxSummaryCharacters: 180,
    })
    expect(register(coordinator)).not.toHaveProperty('deviceToken')
    expect(coordinator.setGroupSubscription('user-a', 'room-1', true)).toMatchObject({ roomId: 'room-1', enabled: true })
    expect(coordinator.isGroupSubscribed('user-a', 'room-1')).toBe(true)
    expect(coordinator.subscribedUserIds('room-1')).toEqual(['user-a'])

    expect(coordinator.enqueue({
      eventId: 'event-1',
      userId: 'user-a',
      kind: 'group.message.completed',
      title: '任务完成',
      body: '好'.repeat(250),
      roomId: 'room-1',
      threadId: 'topic-1',
      collapseId: 'message-1',
      data: { roomId: 'room-1', aps: 'untrusted', version: 99 },
    })).toBe(1)
    expect(coordinator.enqueue({
      eventId: 'event-1', userId: 'user-a', kind: 'group.message.completed', title: '重复', body: '重复',
    })).toBe(0)
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 1, topic: apns.topic })

    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1 })
    expect(sender.requests).toHaveLength(1)
    expect(sender.requests[0]!.payload).toMatchObject({
      version: 1,
      eventId: 'event-1',
      kind: 'group.message.completed',
      clientAccountId: 'account-a',
      aps: { alert: { title: '任务完成' }, badge: 1, 'thread-id': 'topic-1' },
    })
    expect(Array.from(((sender.requests[0]!.payload.aps as { alert: { body: string } }).alert.body))).toHaveLength(180)
    expect(sender.requests[0]!.payload).not.toHaveProperty('userId')
    expect(coordinator.status()).toMatchObject({ healthy: true, pendingCount: 0 })

    const statePath = join(home, 'push', 'state.json')
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    const stored = readFileSync(statePath, 'utf8')
    expect(stored).toContain('ab'.repeat(17))
    expect(stored).not.toContain(apns.keyFile)
    coordinator.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.status()).toMatchObject({ registrationCount: 1, subscriptionCount: 1 })
    expect(restored.listGroupSubscriptions('user-a')).toEqual([
      expect.objectContaining({ roomId: 'room-1', enabled: true }),
    ])
    restored.close()
  })

  it('retries transient failures exponentially and removes invalid registrations', async () => {
    const home = root()
    let now = 1_000_000
    const sender = new FakeSender()
    sender.results.push(
      { disposition: 'retry', status: 503, reason: 'Shutdown' },
      { disposition: 'unregister', status: 410, reason: 'Unregistered' },
    )
    const coordinator = new PushCoordinator({
      home, apns, provider: sender, autoFlush: false, now: () => now, baseRetryMilliseconds: 100,
    })
    register(coordinator)
    coordinator.enqueue({ eventId: 'retry-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })

    await expect(coordinator.flushDue()).resolves.toMatchObject({ retried: 1 })
    expect(coordinator.status()).toMatchObject({ pendingCount: 1, healthy: false })
    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 0, retried: 0 })
    expect(sender.requests).toHaveLength(1)
    now += 100
    await expect(coordinator.flushDue()).resolves.toMatchObject({ removedRegistrations: 1 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, pendingCount: 0 })
    coordinator.close()
  })

  it('does not delete a token that rotated while an APNs request was in flight', async () => {
    let release!: (result: APNsSendResult) => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const first = new Promise<APNsSendResult>(resolve => { release = resolve })
    const requests: APNsRequest[] = []
    const sender: PushSender = {
      send: async request => {
        requests.push(request)
        if (requests.length === 1) {
          started()
          return first
        }
        return { disposition: 'success', status: 200 }
      },
    }
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender, autoFlush: false })
    register(coordinator)
    coordinator.enqueue({ eventId: 'rotated-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })

    const flushing = coordinator.flushDue()
    await began
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-1', clientAccountId: 'account-a',
      deviceToken: 'cd'.repeat(32), environment: 'development', appVersion: '1.2.4',
    })
    release({ disposition: 'unregister', status: 410, reason: 'Unregistered' })
    await expect(flushing).resolves.toMatchObject({ retried: 1, removedRegistrations: 0 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 1 })
    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1 })
    expect(requests[0]!.deviceToken).not.toBe(requests[1]!.deviceToken)
    expect(requests[1]!.deviceToken).toBe('cd'.repeat(32))
    coordinator.close()
  })

  it('fails closed when a user is disabled or their authentication version changes', async () => {
    let active = true
    let authVersion = 1
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({
      home: root(), apns, provider: sender, autoFlush: false,
      isUserActive: () => active,
      userAuthorizationVersion: () => authVersion,
    })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development', authorizationVersion: 1,
    })
    coordinator.enqueue({ eventId: 'version-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })
    authVersion = 2
    await expect(coordinator.flushDue()).resolves.toMatchObject({ failed: 1, delivered: 0 })
    expect(sender.requests).toHaveLength(0)
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, pendingCount: 0 })

    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'cd'.repeat(32), environment: 'development', authorizationVersion: 2,
    })
    active = false
    expect(coordinator.enqueue({
      eventId: 'disabled', userId: 'user-a', kind: 'chat.completed', title: '不应发送', body: '正文',
    })).toBe(0)
    coordinator.close()
  })

  it('cancels pending team notifications on unsubscribe and removes all user-owned state', () => {
    const home = root()
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    register(coordinator)
    coordinator.setGroupSubscription('user-a', 'room-1', true)
    expect(coordinator.enqueueGroupEvent({
      eventID: 'group-1', localUserID: 'user-a', kind: 'group.message.completed',
      title: '团队消息', body: '正文', collapseID: 'group-1', data: {}, roomID: 'room-1',
    })).toBe('enqueued')
    coordinator.setGroupSubscription('user-a', 'room-1', false)
    expect(coordinator.status().pendingCount).toBe(0)

    coordinator.setGroupSubscription('user-a', 'room-2', true)
    const removed = coordinator.removeUser('user-a')
    expect(removed).toMatchObject({ registrations: 1, subscriptions: 1 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, subscriptionCount: 0 })
    expect(coordinator.listGroupSubscriptions('user-a')).toEqual([])
    coordinator.close()
  })

  it('persists the global group cursor and resumable chat jobs in the same state file', () => {
    const home = root()
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(coordinator.resetGroupCursor({ epoch: 'epoch-1', cursor: 10, reason: 'initial' })).toMatchObject({
      epoch: 'epoch-1', cursor: 10,
    })
    coordinator.advanceGroupCursor({ epoch: 'epoch-1', cursor: 11 })
    expect(() => coordinator.advanceGroupCursor({ epoch: 'epoch-1', cursor: 9 })).toThrow(/backwards/)
    coordinator.saveChatJob({
      id: 'job-1', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-1',
      storedSessionID: 'stored-1', requestID: 'request-1', queued: false, phase: 'watching',
      submittedAt: 1, expiresAt: Date.now() + 60_000,
    })
    coordinator.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.groupWatchAnchor()).toMatchObject({ epoch: 'epoch-1', cursor: 11 })
    expect(restored.pendingChatJobs()).toEqual([expect.objectContaining({ id: 'job-1', localUserID: 'user-a' })])
    restored.completeChatJob('job-1')
    expect(restored.pendingChatJobs()).toEqual([])
    restored.close()
  })

  it('fails closed when more than one local user has written the same stored session', () => {
    const coordinator = new PushCoordinator({ home: root(), apns, provider: new FakeSender(), autoFlush: false })
    const job = (id: string, localUserID: string) => ({
      id, localUserID, profile: 'default', runtimeSessionID: `runtime-${id}`, storedSessionID: 'shared',
      requestID: `request-${id}`, queued: false, phase: 'accepted' as const,
      submittedAt: 1, expiresAt: Date.now() + 60_000,
    })
    const first = job('a', 'user-a')
    coordinator.saveChatJob(first)
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(true)
    const second = job('b', 'user-b')
    coordinator.saveChatJob(second)
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(false)
    expect(coordinator.chatJobRecoveryAllowed(second)).toBe(false)
    coordinator.completeChatJob('b')
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(false)
    coordinator.close()
  })

  it('keeps prompt correlation private and stable across restart', () => {
    const home = root()
    const first = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    const digest = first.promptDigest('user-a', '继续执行')
    expect(digest).not.toContain('继续执行')
    expect(first.promptDigest('user-b', '继续执行')).not.toBe(digest)
    first.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.promptDigest('user-a', '继续执行')).toBe(digest)
    expect(statSync(join(home, 'push', 'correlation.key')).mode & 0o777).toBe(0o600)
    restored.close()
  })

  it('automatically flushes newly queued work and closes the injected provider', async () => {
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender })
    register(coordinator)
    coordinator.enqueue({ eventId: 'auto-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })
    await expect.poll(() => sender.requests.length).toBe(1)
    expect(coordinator.status().pendingCount).toBe(0)
    coordinator.close()
    expect(sender.closed).toBe(true)
  })

  it('protects and preserves a malformed existing state file instead of overwriting it', () => {
    const home = root()
    const directory = join(home, 'push')
    const statePath = join(directory, 'state.json')
    mkdirSync(directory)
    writeFileSync(statePath, '{malformed', { mode: 0o644, flag: 'w' })
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })

    expect(coordinator.capabilities()).toMatchObject({ enabled: false })
    expect(coordinator.status().lastError).toMatch(/避免覆盖/)
    expect(() => register(coordinator)).toThrow(/推送状态文件无法读取/)
    expect(readFileSync(statePath, 'utf8')).toBe('{malformed')
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    coordinator.close()
  })
})
