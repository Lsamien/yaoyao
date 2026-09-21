import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from './errors.js'

export const DEFAULT_OPENVIKING_URL = 'http://127.0.0.1:1933'
export type OpenVikingConfigurationSource = 'none' | 'file' | 'environment'

export interface OpenVikingConfiguration {
  enabled: boolean
  url: string
  accountId: string
  adminKey: string
}

export interface OpenVikingConfigurationSnapshot {
  enabled: boolean
  url: string
  accountId: string
  keyConfigured: boolean
  source: OpenVikingConfigurationSource
  status: 'disabled' | 'ready' | 'error'
  error?: string
}

export type OpenVikingProbe = (config: OpenVikingConfiguration) => Promise<void>

interface StoredConfiguration {
  schemaVersion: 1
  enabled: boolean
  url: string
  accountId: string
  encryptedAdminKey: string
  updatedAt: string
}

interface EncryptedValue {
  iv: Buffer
  tag: Buffer
  value: Buffer
}

export function openVikingConfigurationPath(home: string): string {
  return join(home, 'openviking', 'config.json')
}

export function openVikingKeyPath(home: string): string {
  return join(home, 'openviking', 'master.key')
}

function canonicalInput(value: Partial<OpenVikingConfiguration>): OpenVikingConfiguration {
  const url = new URL(typeof value.url === 'string' && value.url.trim() ? value.url.trim() : DEFAULT_OPENVIKING_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
    throw new HttpError(400, 'OpenViking 服务地址无效', 'invalid_openviking_url')
  }
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(accountId)) throw new HttpError(400, 'OpenViking Account ID 无效', 'invalid_openviking_account')
  const adminKey = typeof value.adminKey === 'string' ? value.adminKey.trim() : ''
  if (!adminKey || adminKey.length > 4096) throw new HttpError(400, 'OpenViking 管理员 Key 无效', 'invalid_openviking_admin_key')
  return { enabled: value.enabled !== false, url: url.toString().replace(/\/$/, ''), accountId, adminKey }
}

function encodeEncrypted(value: EncryptedValue): string {
  return ['v1', value.iv.toString('base64url'), value.tag.toString('base64url'), value.value.toString('base64url')].join('.')
}

function decodeEncrypted(value: string): EncryptedValue {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported ciphertext')
  return { iv: Buffer.from(parts[1]!, 'base64url'), tag: Buffer.from(parts[2]!, 'base64url'), value: Buffer.from(parts[3]!, 'base64url') }
}

function masterKey(path: string): Buffer {
  try {
    const key = readFileSync(path)
    if (key.byteLength === 32) {
      chmodSync(path, 0o600)
      return key
    }
    throw new Error('OpenViking master key must contain 32 bytes')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  const key = randomBytes(32)
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, key)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  return key
}

export function encryptOpenVikingSecret(home: string, plainText: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(openVikingKeyPath(home)), iv)
  const value = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  return encodeEncrypted({ iv, tag: cipher.getAuthTag(), value })
}

export function decryptOpenVikingSecret(home: string, encoded: string): string {
  const parts = decodeEncrypted(encoded)
  const decipher = createDecipheriv('aes-256-gcm', masterKey(openVikingKeyPath(home)), parts.iv)
  decipher.setAuthTag(parts.tag)
  return Buffer.concat([decipher.update(parts.value), decipher.final()]).toString('utf8')
}

function readConfiguration(home: string): StoredConfiguration {
  const path = openVikingConfigurationPath(home)
  const descriptor = openSync(path, 'r')
  try {
    const details = statSync(path)
    if (!details.isFile() || details.size > 64 * 1024) throw new Error('invalid OpenViking configuration file')
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as StoredConfiguration
    if (value.schemaVersion !== 1 || typeof value.encryptedAdminKey !== 'string') throw new Error('invalid OpenViking configuration file')
    chmodSync(path, 0o600)
    return value
  } finally { closeSync(descriptor) }
}

function writeAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, value)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* absent */ }
    throw error
  }
}

function environmentConfiguration(env: NodeJS.ProcessEnv): OpenVikingConfiguration | undefined {
  const url = env.HERMES_YAOYAO_OPENVIKING_URL?.trim()
  const accountId = env.HERMES_YAOYAO_OPENVIKING_ACCOUNT_ID?.trim()
  const adminKey = env.HERMES_YAOYAO_OPENVIKING_ADMIN_KEY?.trim()
  if (!url && !accountId && !adminKey) return undefined
  return canonicalInput({ enabled: true, url, accountId, adminKey })
}

function storedConfiguration(home: string): OpenVikingConfiguration | undefined {
  if (!existsSync(openVikingConfigurationPath(home))) return undefined
  const stored = readConfiguration(home)
  return { enabled: stored.enabled, url: stored.url, accountId: stored.accountId, adminKey: decryptOpenVikingSecret(home, stored.encryptedAdminKey) }
}

function snapshot(config: OpenVikingConfiguration, source: OpenVikingConfigurationSource, error?: string): OpenVikingConfigurationSnapshot {
  return {
    enabled: config.enabled, url: config.url, accountId: config.accountId, keyConfigured: Boolean(config.adminKey),
    source, status: !config.enabled ? 'disabled' : error ? 'error' : 'ready', ...(error ? { error } : {}),
  }
}

export function loadOpenVikingConfiguration(home: string, env: NodeJS.ProcessEnv = process.env): OpenVikingConfigurationSnapshot {
  const fromEnvironment = environmentConfiguration(env)
  if (fromEnvironment) return snapshot(fromEnvironment, 'environment')
  try {
    const stored = storedConfiguration(home)
    return stored ? snapshot(stored, 'file') : { enabled: false, url: DEFAULT_OPENVIKING_URL, accountId: '', keyConfigured: false, source: 'none', status: 'disabled' }
  } catch (cause) {
    return { enabled: false, url: DEFAULT_OPENVIKING_URL, accountId: '', keyConfigured: false, source: 'file', status: 'error', error: cause instanceof Error ? cause.message : 'OpenViking 配置文件无效' }
  }
}

async function defaultProbe(config: OpenVikingConfiguration): Promise<void> {
  const url = new URL(`/api/v1/admin/accounts/${encodeURIComponent(config.accountId)}/users`, config.url)
  url.searchParams.set('limit', '1')
  const response = await fetch(url, {
    headers: { 'X-API-Key': config.adminKey, 'X-OpenViking-Account': config.accountId },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`OpenViking returned HTTP ${response.status}`)
  await response.json()
}

export class OpenVikingConfigurationManager {
  readonly path: string
  #snapshot: OpenVikingConfigurationSnapshot
  #operation = Promise.resolve()
  readonly #probe: OpenVikingProbe
  constructor(private readonly home: string, initial?: OpenVikingConfigurationSnapshot, probe?: OpenVikingProbe) {
    this.path = openVikingConfigurationPath(home)
    this.#snapshot = initial ?? loadOpenVikingConfiguration(home)
    this.#probe = probe ?? defaultProbe
  }
  snapshot(): OpenVikingConfigurationSnapshot { return { ...this.#snapshot } }
  configuration(): OpenVikingConfiguration | undefined {
    const value = this.#snapshot
    if (!value.enabled || value.status !== 'ready') return undefined
    if (value.source === 'environment') return environmentConfiguration(process.env)
    return storedConfiguration(this.home)
  }
  update(input: Partial<OpenVikingConfiguration>, apply?: (config: OpenVikingConfiguration | undefined) => void | Promise<void>): Promise<OpenVikingConfigurationSnapshot> {
    const operation = this.#operation.then(() => this.#update(input, apply))
    this.#operation = operation.then(() => undefined, () => undefined)
    return operation
  }
  async #update(input: Partial<OpenVikingConfiguration>, apply?: (config: OpenVikingConfiguration | undefined) => void | Promise<void>): Promise<OpenVikingConfigurationSnapshot> {
    if (this.#snapshot.source === 'environment') throw new HttpError(409, 'OpenViking 配置由环境变量管理', 'openviking_environment_managed')
    const previousFile = existsSync(this.path) ? readFileSync(this.path) : undefined
    const previous = storedConfiguration(this.home)
    const requested = canonicalInput({
      enabled: input.enabled ?? previous?.enabled ?? false,
      url: input.url ?? previous?.url ?? DEFAULT_OPENVIKING_URL,
      accountId: input.accountId ?? previous?.accountId ?? '',
      adminKey: input.adminKey ?? previous?.adminKey ?? '',
    })
    if (requested.enabled) {
      try { await this.#probe(requested) } catch (cause) {
        throw new HttpError(422, `OpenViking 连接验证失败：${cause instanceof Error ? cause.message : '未知错误'}`, 'openviking_unavailable')
      }
    }
    const stored: StoredConfiguration = {
      schemaVersion: 1, enabled: requested.enabled, url: requested.url, accountId: requested.accountId,
      encryptedAdminKey: encryptOpenVikingSecret(this.home, requested.adminKey), updatedAt: new Date().toISOString(),
    }
    try {
      writeAtomic(this.path, `${JSON.stringify(stored, null, 2)}\n`)
      await apply?.(requested.enabled ? requested : undefined)
    } catch (cause) {
      try {
        if (previousFile) writeAtomic(this.path, previousFile.toString('utf8'))
        else if (existsSync(this.path)) unlinkSync(this.path)
        await apply?.(previous?.enabled ? previous : undefined)
      } catch { /* preserve the original error */ }
      throw cause
    }
    this.#snapshot = snapshot(requested, 'file')
    return this.snapshot()
  }
}
