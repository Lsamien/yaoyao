import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './errors.js'

const PAIRING_TTL_MS = 2 * 60 * 1_000
const MAX_PENDING_PAIRINGS = 32
const MAX_PAIRED_DEVICES = 64
const TOKEN_BYTES = 32

export const NODE_PAIRING_PROTOCOL_VERSION = 1
export const DEFAULT_NODE_SCOPES = [
  'agents.read',
  'history.read',
  'sessions.execute',
  'groups.read',
  'groups.execute',
] as const

export type NodeScope = typeof DEFAULT_NODE_SCOPES[number]

interface PersistedDevice {
  id: string
  name: string
  tokenHash: string
  encryptedCookie: string
  workspaceOwner?: string
  scopes: NodeScope[]
  createdAt: number
  lastUsedAt: number
}

interface PersistedPairingState {
  version: 1
  nodeID: string
  devices: PersistedDevice[]
}

interface PendingPairing {
  id: string
  secretHash: Buffer
  cookieHeader: string
  workspaceOwner?: string
  scopes: NodeScope[]
  createdAt: number
  expiresAt: number
  claimedDeviceID?: string
}

export interface PairingSession {
  id: string
  secret: string
  nodeID: string
  fingerprint: string
  scopes: NodeScope[]
  createdAt: number
  expiresAt: number
}

export interface PairedDeviceSummary {
  id: string
  name: string
  scopes: NodeScope[]
  createdAt: number
  lastUsedAt: number
}

export interface PairingClaim {
  existingDeviceID?: string
  existingToken?: string
  pairingID: string
  secret: string
  deviceName: string
}

export interface PairingClaimResult {
  device: PairedDeviceSummary
  token: string
  nodeID: string
  fingerprint: string
  scopes: NodeScope[]
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function canonicalDeviceName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, 'Device name is invalid', 'invalid_device_name')
  }
  return normalized
}

function canonicalPairingID(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, 'Pairing ID is invalid', 'invalid_pairing')
  }
  return normalized
}

function canonicalDeviceID(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, 'Device ID is invalid', 'invalid_device')
  }
  return normalized
}

function parseScopes(value: readonly string[] | undefined): NodeScope[] {
  const requested = value ?? [...DEFAULT_NODE_SCOPES]
  const allowed = new Set<string>(DEFAULT_NODE_SCOPES)
  const result: NodeScope[] = []
  for (const scope of requested) {
    if (!allowed.has(scope)) {
      throw new HttpError(400, `Unsupported node scope: ${scope}`, 'invalid_scope')
    }
    if (!result.includes(scope as NodeScope)) result.push(scope as NodeScope)
  }
  if (result.length === 0) throw new HttpError(400, 'At least one node scope is required', 'invalid_scope')
  return result
}

function persistentSecret(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'node-pairing-secret.bin')
  try {
    const existing = readFileSync(path)
    if (existing.byteLength !== 32) throw new Error('Node pairing secret has an invalid length')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const generated = randomBytes(32)
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path)
    throw error
  }
}

export class NodePairingStore {
  readonly #home: string
  readonly #secret: Buffer
  readonly #statePath: string
  readonly #clock: () => number
  readonly #pending = new Map<string, PendingPairing>()
  #state: PersistedPairingState

  constructor(home: string, clock: () => number = Date.now) {
    this.#home = home
    this.#secret = persistentSecret(home)
    this.#statePath = join(home, 'paired-devices.json')
    this.#clock = clock
    this.#state = this.#load()
  }

  get nodeID(): string { return this.#state.nodeID }

  get fingerprint(): string {
    return createHash('sha256')
      .update(this.#state.nodeID, 'utf8')
      .update(this.#secret)
      .digest('base64url')
  }

  create(cookieHeader: string | undefined, requestedScopes?: readonly string[], workspaceOwner?: string): PairingSession {
    const cookies = cookieHeader?.trim() ?? ''
    if (!cookies) {
      throw new HttpError(401, 'An authenticated Hermes session is required', 'authentication_required')
    }
    this.#prunePending()
    while (this.#pending.size >= MAX_PENDING_PAIRINGS) {
      const oldest = this.#pending.keys().next().value as string | undefined
      if (!oldest) break
      this.#pending.delete(oldest)
    }
    const id = randomUUID().toLowerCase()
    const secret = randomBytes(TOKEN_BYTES).toString('base64url')
    const now = this.#clock()
    const pending: PendingPairing = {
      id,
      secretHash: hashSecret(`${id}:${secret}`),
      cookieHeader: cookies,
      workspaceOwner,
      scopes: parseScopes(requestedScopes),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    }
    this.#pending.set(id, pending)
    return {
      id,
      secret,
      nodeID: this.nodeID,
      fingerprint: this.fingerprint,
      scopes: [...pending.scopes],
      createdAt: now,
      expiresAt: pending.expiresAt,
    }
  }

  status(pairingID: string): { state: 'pending' | 'claimed' | 'expired'; deviceID?: string } {
    const id = canonicalPairingID(pairingID)
    const pending = this.#pending.get(id)
    if (!pending || pending.expiresAt <= this.#clock()) {
      this.#pending.delete(id)
      return { state: 'expired' }
    }
    return pending.claimedDeviceID
      ? { state: 'claimed', deviceID: pending.claimedDeviceID }
      : { state: 'pending' }
  }

  claim(input: PairingClaim): PairingClaimResult {
    this.#prunePending()
    const id = canonicalPairingID(input.pairingID)
    const pending = this.#pending.get(id)
    if (!pending || pending.expiresAt <= this.#clock()) {
      this.#pending.delete(id)
      throw new HttpError(410, 'Pairing code expired', 'pairing_expired')
    }
    if (pending.claimedDeviceID) {
      throw new HttpError(409, 'Pairing code was already used', 'pairing_already_used')
    }
    const supplied = hashSecret(`${id}:${input.secret}`)
    if (supplied.byteLength !== pending.secretHash.byteLength
      || !timingSafeEqual(supplied, pending.secretHash)) {
      throw new HttpError(401, 'Pairing secret is invalid', 'invalid_pairing_secret')
    }
    const existing = input.existingDeviceID
      ? (this.authorize(input.existingDeviceID,input.existingToken ?? ''), this.#state.devices.find(d=>d.id===input.existingDeviceID)) : undefined
    if (!existing && this.#state.devices.length >= MAX_PAIRED_DEVICES) {
      throw new HttpError(409, 'Paired device limit reached', 'paired_device_limit')
    }
    const now = this.#clock()
    const token = existing ? input.existingToken! : randomBytes(TOKEN_BYTES).toString('base64url')
    const device: PersistedDevice = {
      id: existing?.id ?? randomUUID().toLowerCase(),
      name: canonicalDeviceName(input.deviceName),
      tokenHash: hashSecret(token).toString('base64url'),
      encryptedCookie: this.#encrypt(pending.cookieHeader),
      workspaceOwner: pending.workspaceOwner,
      scopes: [...pending.scopes],
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    }
    if (existing) Object.assign(existing,device)
    else this.#state.devices.push(device)
    pending.claimedDeviceID = device.id
    pending.cookieHeader = ''
    this.#save()
    return {
      device: this.#summary(device),
      token,
      nodeID: this.nodeID,
      fingerprint: this.fingerprint,
      scopes: [...device.scopes],
    }
  }

  list(): PairedDeviceSummary[] {
    return this.#state.devices
      .map((device) => this.#summary(device))
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  }

  hasDevice(deviceID: string): boolean {
    try {
      const id = canonicalDeviceID(deviceID)
      return this.#state.devices.some((device) => device.id === id)
    } catch {
      return false
    }
  }

  delegatedCookies(deviceID: string): string {
    const id = canonicalDeviceID(deviceID)
    const device = this.#state.devices.find((candidate) => candidate.id === id)
    if (!device) throw new HttpError(404, 'Paired device was not found', 'paired_device_not_found')
    return this.#decrypt(device.encryptedCookie)
  }

  revoke(deviceID: string): boolean {
    const id = canonicalDeviceID(deviceID)
    const before = this.#state.devices.length
    this.#state.devices = this.#state.devices.filter((device) => device.id !== id)
    if (this.#state.devices.length === before) return false
    this.#save()
    return true
  }

  authorize(deviceID: string, token: string, requiredScope?: NodeScope): string {
    const id = canonicalDeviceID(deviceID)
    const normalizedToken = token.trim()
    if (!normalizedToken || normalizedToken.length > 512) {
      throw new HttpError(401, 'Paired device token is missing', 'paired_device_unauthorized')
    }
    const device = this.#state.devices.find((candidate) => candidate.id === id)
    if (!device) throw new HttpError(401, 'Paired device is not recognized', 'paired_device_unauthorized')
    const expected = Buffer.from(device.tokenHash, 'base64url')
    const supplied = hashSecret(normalizedToken)
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
      throw new HttpError(401, 'Paired device token is invalid', 'paired_device_unauthorized')
    }
    if (requiredScope && !device.scopes.includes(requiredScope)) {
      throw new HttpError(403, `Paired device lacks ${requiredScope}`, 'paired_device_forbidden')
    }
    device.lastUsedAt = this.#clock()
    this.#save()
    return this.#decrypt(device.encryptedCookie)
  }

  workspaceOwner(deviceID: string, token: string, scope: NodeScope): string {
    this.authorize(deviceID, token, scope)
    const owner = this.#state.devices.find(device => device.id === deviceID)?.workspaceOwner
    if (!owner) throw new HttpError(403, '请升级远端并重新扫码授权，以读取远端 Bot 模式 Agent', 'workspace_agent_pairing_required')
    return owner
  }

  updateCookies(deviceID: string, cookieHeader: string | undefined): void {
    const id = canonicalDeviceID(deviceID)
    const device = this.#state.devices.find((candidate) => candidate.id === id)
    if (!device || !cookieHeader?.trim()) return
    device.encryptedCookie = this.#encrypt(cookieHeader.trim())
    device.lastUsedAt = this.#clock()
    this.#save()
  }

  #summary(device: PersistedDevice): PairedDeviceSummary {
    return {
      id: device.id,
      name: device.name,
      scopes: [...device.scopes],
      createdAt: device.createdAt,
      lastUsedAt: device.lastUsedAt,
    }
  }

  #prunePending(): void {
    const now = this.#clock()
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(id)
    }
  }

  #encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#secret, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
  }

  #decrypt(value: string): string {
    try {
      const encoded = Buffer.from(value, 'base64url')
      if (encoded.byteLength < 29) throw new Error('encrypted cookie is truncated')
      const iv = encoded.subarray(0, 12)
      const tag = encoded.subarray(12, 28)
      const ciphertext = encoded.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', this.#secret, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      throw new HttpError(401, 'Paired device credentials are unavailable', 'paired_device_credentials_invalid')
    }
  }

  #load(): PersistedPairingState {
    try {
      const parsed = JSON.parse(readFileSync(this.#statePath, 'utf8')) as Partial<PersistedPairingState>
      if (parsed.version !== 1
        || typeof parsed.nodeID !== 'string'
        || !Array.isArray(parsed.devices)) {
        throw new Error('paired device state is invalid')
      }
      return {
        version: 1,
        nodeID: canonicalDeviceID(parsed.nodeID),
        devices: parsed.devices as PersistedDevice[],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const state: PersistedPairingState = {
        version: 1,
        nodeID: randomUUID().toLowerCase(),
        devices: [],
      }
      this.#state = state
      this.#save()
      return state
    }
  }

  #save(): void {
    mkdirSync(this.#home, { recursive: true, mode: 0o700 })
    const temporary = `${this.#statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, this.#statePath)
  }
}

export function bearerToken(value: string | undefined): string {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/)
  if (!match) throw new HttpError(401, 'Paired device bearer token is required', 'paired_device_unauthorized')
  return match[1]!
}
