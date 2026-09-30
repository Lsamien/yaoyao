/** Operator-started foreground service. Never started by Web/Runner or the model.
 * No setup of OS users, permissions, service manager or network rules is performed. */
import { chmodSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { parse } from './schema.js'
import { CredentialVaultStore } from './store.js'
import { CredentialVaultBroker } from './broker.js'
import { serveCredentialVault } from './transport.js'
import { acquireServiceInstance } from '../serviceInstance.js'
import { readPrivateUtf8 } from './privateFiles.js'
import {OperatorIsolationGate} from './isolation.js'
import {ProtectedCredentialExecutor} from './protectedExecutor.js'
try {
  const index = process.argv.indexOf('--config'), path = index < 0 ? undefined : process.argv[index + 1]
  if (!path) throw new Error('用法：node credentialVault/index.js --config /私有路径/vault.json')
  const config = parse(z.object({ home: z.string().refine(isAbsolute), socket: z.string().refine(isAbsolute), tokenFile: z.string().refine(isAbsolute),
    hermesUid: z.number().int().positive(),execution:z.object({approvalFile:z.string().refine(isAbsolute),hermesPid:z.number().int().positive(),home:z.string().refine(isAbsolute)}).strict().optional() }).strict(), JSON.parse(readPrivateUtf8(path,8192)))
  if (!process.getuid || process.getuid() === 0 || process.getuid() === config.hermesUid) throw new Error('密码库需要独立非 root OS 身份，不能与 Hermes 同用户运行')
  const controlToken = readPrivateUtf8(config.tokenFile,4096).trim()
  const store = await CredentialVaultStore.create(config.home)
  process.umask(0o077)
  const instance = acquireServiceInstance(store.root, 'credential-vault-v1')
  const executor=config.execution?new ProtectedCredentialExecutor(config.execution.home,new OperatorIsolationGate(config.execution.approvalFile,config.hermesUid,config.execution.hermesPid)):undefined
  const broker = new CredentialVaultBroker(store,Date.now,executor)
  const server = serveCredentialVault(broker, controlToken)
  process.once('exit', () => { broker.close(); instance.release() })
  server.listen(config.socket, () => {
    try { chmodSync(config.socket, 0o600); process.stdout.write('密码库私有服务已启动，默认锁定；执行能力以专用管理界面状态为准\n') }
    catch { broker.close(); server.close(); process.exitCode = 1 }
  })
  const stop = () => { broker.close(); server.close(() => { instance.release() }); server.closeAllConnections() }
  server.once('error', () => { stop(); process.exitCode = 1; process.stderr.write('密码库私有服务无法监听，请检查路径或已有实例\n') })
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
} catch {
  process.stderr.write('密码库启动失败，请检查私有配置和独立 OS 身份；不会自动修改系统设置\n'); process.exitCode = 1
}
