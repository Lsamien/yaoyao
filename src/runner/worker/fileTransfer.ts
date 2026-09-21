import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source, tsc output, and bundled runner/desktop layouts.
const directory = dirname(fileURLToPath(import.meta.url))
const file = [resolve(directory, '../../../integrations/hermes-bots-bridge/file_transfer.py'), resolve(directory, '../hermes-bots-bridge/file_transfer.py'), resolve(directory, 'hermes-bots-bridge/file_transfer.py')].find(existsSync)
if (!file) throw new Error('缺少虚拟机文件传输模块，请重新构建 Runner')
export const VM_FILE_TRANSFER_SCRIPT = readFileSync(file, 'utf8')
