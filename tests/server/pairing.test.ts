import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { NodePairingStore } from '../../src/server/pairing.js'
import { createAuthenticatedApplication as createApplication } from './authenticatedApplication.js'

const homes: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-pairing-'))
  homes.push(home)
  return home
}

function config(home: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 15300,
    upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(),
    home,
    mediaRoot: join(home, 'media'),
    attachmentsRoot: join(home, 'attachments'),
    imagesRoot: join(home, 'images'),
    mediaOwner: 'tester',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
  }
}

function cookies(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined
  return (values ?? []).map((value) => value.split(';', 1)[0]).join('; ')
}

describe('Hermes node pairing', () => {
  it('stores only encrypted delegated cookies and rejects replayed pairing secrets', () => {
    const home = temporaryHome()
    let now = 1_000
    const store = new NodePairingStore(home, () => now)
    const pairing = store.create('hermes_session_rt=refresh-secret', ['agents.read', 'history.read'])
    const claimed = store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '测试 iPhone',
    })

    expect(store.authorize(claimed.device.id, claimed.token, 'history.read'))
      .toBe('hermes_session_rt=refresh-secret')
    expect(() => store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '重放设备',
    })).toThrowError(/already used/i)
    expect(() => store.authorize(claimed.device.id, claimed.token, 'groups.execute'))
      .toThrowError(/lacks groups.execute/i)

    const persisted = readFileSync(join(home, 'paired-devices.json'), 'utf8')
    expect(persisted).not.toContain('refresh-secret')
    expect(persisted).not.toContain(claimed.token)

    now += 1
    const restored = new NodePairingStore(home, () => now)
    expect(restored.nodeID).toBe(store.nodeID)
    expect(restored.authorize(claimed.device.id, claimed.token, 'agents.read'))
      .toBe('hermes_session_rt=refresh-secret')
  })

  it('expires unclaimed QR secrets after two minutes', () => {
    const home = temporaryHome()
    let now = 10_000
    const store = new NodePairingStore(home, () => now)
    const pairing = store.create('hermes_session_at=access')
    now = pairing.expiresAt + 1
    expect(store.status(pairing.id)).toEqual({ state: 'expired' })
    expect(() => store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '迟到的设备',
    })).toThrowError(/expired/i)
  })

})
