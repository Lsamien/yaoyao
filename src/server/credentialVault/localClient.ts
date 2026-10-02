import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CredentialVaultClient } from './transport.js'
import { CredentialVaultStore } from './store.js'
import { CredentialVaultBroker } from './broker.js'
import { HttpError } from '../errors.js'
import { acquireServiceInstance } from '../serviceInstance.js'

/** Default encrypted storage. It never supplies an executor or issues Bot leases.
 * Automatic credential use still requires the explicitly configured isolated broker. */
export class LocalCredentialVaultClient extends CredentialVaultClient {
  private readonly controlEpoch = randomUUID()
  private broker?: Promise<CredentialVaultBroker>
  private instance?: ReturnType<typeof acquireServiceInstance>
  private closed = false

  constructor(private readonly home: string) { super() }

  override async call(owner: string, session: string, command: string, value?: unknown): Promise<any> {
    if (this.closed) throw new HttpError(503, '密码保险箱已关闭', 'vault_offline')
    if (['grant', 'execute'].includes(command))
      throw new HttpError(409, '本机保险箱只保存凭据；Bot 自动使用需要连接独立密码库服务', 'vault_executor_not_enabled')
    this.broker ??= CredentialVaultStore.create(join(this.home, 'credential-vault')).then(store => {
      if (this.closed) throw new Error('closed')
      this.instance = acquireServiceInstance(store.root, 'credential-vault-v1')
      const broker = new CredentialVaultBroker(store)
      broker.hello(this.controlEpoch)
      return broker
    }).catch(() => {
      this.instance?.release(); this.instance = undefined
      this.broker = undefined
      throw new HttpError(503, '无法打开本机密码保险箱，请检查数据目录权限或是否已被其他服务使用', 'vault_offline')
    })
    const broker = await this.broker
    if (this.closed) throw new HttpError(503, '密码保险箱已关闭', 'vault_offline')
    try {
      const result = broker.dispatch(this.controlEpoch, owner, session, command, value)
      return ['status', 'initialize', 'unlock', 'restore'].includes(command)
        ? { ...(result as object), storageMode: 'local' }
        : result
    } catch (error) {
      if (error instanceof HttpError) throw error
      broker.disconnect()
      throw new HttpError(409, '密码保险箱操作未完成，请刷新状态后重新解锁', 'vault_request_failed')
    }
  }

  override close(): void {
    this.closed = true
    void this.broker?.then(broker => {
      try { broker.close() } finally { this.instance?.release(); this.instance = undefined }
    }).catch(() => {})
  }
}

export function createCredentialVaultClient(config: ConstructorParameters<typeof CredentialVaultClient>[0], home: string) {
  // An unavailable explicit deployment must never fall back to a different vault.
  return config ? new CredentialVaultClient(config) : new LocalCredentialVaultClient(home)
}
