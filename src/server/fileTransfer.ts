import { createHash, randomUUID } from 'node:crypto'
import { FILE_TRANSFER_CHUNK_BYTES, type FileTransferEndpoint } from '../shared/fileTransfer.js'
import { HttpError } from './errors.js'

/** File bytes stay between endpoints and this broker, never in the model transcript. */
export async function copyBetweenEndpoints(source: FileTransferEndpoint, target: FileTransferEndpoint, maxBytes: number, overwrite: boolean, check: () => void) {
  const sourceId = randomUUID(), targetId = randomUUID(), deadline = Date.now() + 10 * 60_000
  const guard = () => { check(); if (Date.now() > deadline) throw new HttpError(504, '文件传输超时，请核对目标文件', 'file_transfer_timeout') }
  const sourceCall = (action: Record<string, unknown>) => { guard(); return source.call({ ...action, transferId: sourceId }) }
  const targetCall = (action: Record<string, unknown>) => { guard(); return target.call({ ...action, transferId: targetId }) }
  let metadata: { size: number; sha256: string }, legacy: Buffer | undefined
  try {
    if (source.chunks) metadata = await sourceCall({ op: 'transfer-read-open', path: source.path, maxBytes })
    else {
      const result = await sourceCall({ op: 'read', path: source.path }).catch(error => {
        if (error instanceof HttpError && error.code === 'desktop_command_failed' && /超过读取上限/.test(error.message)) throw new HttpError(409, '来源电脑仍使用旧版文件读取，请更新夭夭桌面端后传输大文件', 'desktop_transfer_upgrade_required')
        throw error
      })
      if (typeof result?.data !== 'string' || result.data.length > 16 * 1024 * 1024) throw new HttpError(502, '来源电脑返回的文件无效', 'desktop_transfer_invalid')
      legacy = Buffer.from(result.data, 'base64')
      if (result.size !== legacy.length || legacy.toString('base64') !== result.data) throw new HttpError(502, '来源电脑返回的文件不完整', 'desktop_transfer_invalid')
      metadata = { size: legacy.length, sha256: createHash('sha256').update(legacy).digest('hex') }
    }
    guard()
    // Remote read metadata also contains its source path. Never let that path
    // override the explicitly selected destination in a write-open command.
    metadata = { size: metadata.size, sha256: metadata.sha256 }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) throw new HttpError(413, `文件超过传输上限（${maxBytes / 1024 / 1024} MiB）`, 'desktop_transfer_limit')
    if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new HttpError(502, '来源文件校验信息无效', 'desktop_transfer_invalid')
    if ((!source.chunks || !target.chunks) && metadata.size > 10 * 1024 * 1024) throw new HttpError(409, '此电脑仍使用旧版文件传输，请更新夭夭桌面端后传输超过 10 MiB 的文件', 'desktop_transfer_upgrade_required')
    if (target.chunks) await targetCall({ op: 'transfer-write-open', path: target.path, maxBytes, ...metadata, overwrite })
    const sha = createHash('sha256'), oldTarget: Buffer[] = []
    for (let offset = 0; offset < metadata.size; offset += FILE_TRANSFER_CHUNK_BYTES) {
      guard()
      const length = Math.min(FILE_TRANSFER_CHUNK_BYTES, metadata.size - offset)
      const chunk = legacy ? legacy.subarray(offset, offset + length) : await (async () => {
        const result = await sourceCall({ op: 'transfer-read', offset })
        if (result?.offset !== offset || typeof result.data !== 'string' || result.data.length > Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4) throw new HttpError(502, '来源文件分块无效', 'desktop_transfer_invalid')
        const bytes = Buffer.from(result.data, 'base64')
        if (bytes.length !== length || bytes.toString('base64') !== result.data) throw new HttpError(502, '来源文件分块不完整', 'desktop_transfer_invalid')
        return bytes
      })()
      sha.update(chunk)
      if (target.chunks) {
        const result = await targetCall({ op: 'transfer-append', offset, data: chunk.toString('base64') })
        if (result?.received !== offset + chunk.length) throw new HttpError(502, '目标电脑未确认完整分块', 'desktop_transfer_unconfirmed')
      } else oldTarget.push(chunk)
    }
    if (sha.digest('hex') !== metadata.sha256) throw new HttpError(502, '传输内容校验失败，未提交目标文件', 'desktop_transfer_invalid')
    let result: any
    if (target.chunks) {
      try { result = await targetCall({ op: 'transfer-finish' }) }
      catch (error) {
        // Query the receipt, never repeat a possibly committed write.
        const receipt = await targetCall({ op: 'transfer-status' }).catch(() => undefined)
        if (!receipt?.complete) throw error
        result = receipt
      }
    } else {
      try { result = await targetCall({ op: 'receive', path: target.path, data: Buffer.concat(oldTarget).toString('base64'), sha256: metadata.sha256, overwrite }) }
      catch (error) {
        if (error instanceof HttpError && error.code === 'desktop_command_failed' && error.message === '文件操作无效') throw new HttpError(409, '目标电脑尚不支持接收文件，请更新夭夭桌面端', 'desktop_transfer_upgrade_required')
        throw error
      }
    }
    guard()
    if (result?.path !== target.path || result?.size !== metadata.size || result?.sha256 !== metadata.sha256 || (target.chunks && result.complete !== true)) throw new HttpError(502, '目标电脑未确认文件校验成功，请核对文件；不会自动重传', 'desktop_transfer_unconfirmed')
    return { copied: true, source: { host: source.host, name: source.name, path: source.path }, target: { host: target.host, name: target.name, path: target.path }, ...metadata }
  } finally {
    await Promise.allSettled([
      ...(source.chunks ? [Promise.resolve().then(() => source.call({ op: 'transfer-abort', transferId: sourceId }))] : []),
      ...(target.chunks ? [Promise.resolve().then(() => target.call({ op: 'transfer-abort', transferId: targetId }))] : []),
    ])
  }
}
