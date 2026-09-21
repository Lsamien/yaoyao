import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import { type WorkspaceApprovalPolicy } from '../shared/workspace.js'
import { FILE_TRANSFER_DEFAULT_MIB, FILE_TRANSFER_MAX_MIB } from '../shared/fileTransfer.js'

export interface HostToolSettings {
  /** Deprecated compatibility field. Hermes tools execute on the server. */
  denyServerTools: boolean
  approvalPolicy: WorkspaceApprovalPolicy
  scriptMachine: boolean
  serverComputer: boolean
  vm: boolean
  cloud: boolean
  fileTransferMaxMiB: number
}
const settingsPath = (home: string) => join(home, 'host-tools.json')
const COMPUTERS_ON = { scriptMachine: true, serverComputer: true, vm: true, cloud: true } as const
const computerFlag = (input: Partial<HostToolSettings>, key: keyof typeof COMPUTERS_ON) =>
  typeof input[key] === 'boolean' ? input[key] : COMPUTERS_ON[key]

export function parseHostTools(value: unknown): HostToolSettings {
  const input = value as Partial<HostToolSettings> | null
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, '电脑设置格式无效', 'invalid_host_tools')
  if (input.approvalPolicy !== undefined && !['ask','allow','deny'].includes(input.approvalPolicy))
    throw new HttpError(400, '审批策略无效', 'invalid_host_tools')
  if (input.fileTransferMaxMiB !== undefined && (!Number.isInteger(input.fileTransferMaxMiB) || input.fileTransferMaxMiB < 1 || input.fileTransferMaxMiB > FILE_TRANSFER_MAX_MIB))
    throw new HttpError(400, '单文件传输上限需要是 1–100 MiB 的整数', 'invalid_file_transfer_limit')
  return {
    denyServerTools: false,
    approvalPolicy: input.approvalPolicy ?? 'ask',
    scriptMachine: computerFlag(input, 'scriptMachine'),
    serverComputer: computerFlag(input, 'serverComputer'),
    vm: computerFlag(input, 'vm'),
    cloud: computerFlag(input, 'cloud'),
    fileTransferMaxMiB: input.fileTransferMaxMiB ?? FILE_TRANSFER_DEFAULT_MIB,
  }
}

export function readHostTools(home: string): HostToolSettings {
  const path = settingsPath(home)
  if (!existsSync(path)) return { denyServerTools: false, approvalPolicy: 'ask', ...COMPUTERS_ON, fileTransferMaxMiB: FILE_TRANSFER_DEFAULT_MIB }
  try { return parseHostTools(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) {
    if (error instanceof HttpError) throw new HttpError(503, '服务端工具设置无法读取，请由管理员重新保存', 'host_tools_configuration_error')
    throw new HttpError(503, '服务端工具设置无法读取，请由管理员重新保存', 'host_tools_configuration_error')
  }
}

/** Retained for old integrations. Native Hermes tools always belong to the server. */
export function deniedHostToolsets(_home: string): string[] { return [] }

export function saveHostTools(home: string, value: unknown): HostToolSettings {
  const previous = (() => { try { return readHostTools(home) } catch { return {} } })()
  const settings = parseHostTools(value && typeof value === 'object' && !Array.isArray(value) ? {...previous,...value} : value)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = settingsPath(home)
  const temporary = path + '.' + randomUUID()
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
  return settings
}
