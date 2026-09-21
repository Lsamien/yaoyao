import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'

const pathOf = (home: string) => join(home, 'computer-names.json')
const idOk = (id: string) => id === 'local' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)

export function readComputerNames(home: string): Record<string, string> {
  const path = pathOf(home)
  if (!existsSync(path)) return {}
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { names?: Record<string, unknown> }
    const names: Record<string, string> = {}
    for (const [id, name] of Object.entries(value?.names ?? {})) {
      if (idOk(id) && typeof name === 'string' && name.trim()) names[id] = name.trim().slice(0, 64)
    }
    return names
  } catch { return {} }
}

export function saveComputerName(home: string, id: string, name: string): Record<string, string> {
  if (!idOk(id)) throw new HttpError(400, '这台电脑不能改名', 'computer_unknown')
  const trimmed = name.trim()
  if (trimmed.length > 64) throw new HttpError(400, '名字最长 64 个字', 'computer_name_invalid')
  const names = readComputerNames(home)
  if (trimmed) names[id] = trimmed
  else delete names[id]
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = pathOf(home)
  const temporary = path + '.' + randomUUID()
  writeFileSync(temporary, JSON.stringify({ names }, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
  return names
}
