import { hostname } from 'node:os'
import type { WorkspaceStore } from './workspaceStore.js'
import type { ServerIdentity } from '../shared/serverIdentity.js'
import { HttpError } from './errors.js'

export function readServerIdentity(store: WorkspaceStore): ServerIdentity {
  const row = store.db.prepare('SELECT * FROM server_identity WHERE singleton=1').get()!
  const name = String(row.name)
  return { serverId: String(row.server_id), name, displayName: name || hostname(), revision: Number(row.revision) }
}

export function updateServerIdentity(store: WorkspaceStore, input: Record<string, unknown>): ServerIdentity {
  if (typeof input.name !== 'string' || Object.keys(input).some(key => !['name', 'expectedRevision', 'expectedServerId'].includes(key))) {
    throw new HttpError(400, '请输入服务器名称', 'invalid_server_name')
  }
  const name = input.name.trim()
  if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, '服务器名称最多 100 个字符，不能包含换行或控制字符', 'invalid_server_name')
  }
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) {
    throw new HttpError(400, '服务器配置版本无效', 'invalid_server_revision')
  }
  return store.atomic(() => {
    const current = readServerIdentity(store)
    if (input.expectedServerId !== undefined && input.expectedServerId !== current.serverId) {
      throw new HttpError(409, '服务器连接已切换，请重新载入后再保存', 'server_identity_target_changed')
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new HttpError(409, '服务器名称已在其他端更新，请重新载入后再保存', 'server_identity_conflict')
    }
    if (name !== current.name) store.db.prepare('UPDATE server_identity SET name=?,revision=revision+1 WHERE singleton=1').run(name)
    return readServerIdentity(store)
  })
}
