import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Skill admission for embedded workers (runtime/native_skills.py).
 *
 * Hermes skills live in `<home>/skills/<category>/<name>/SKILL.md` with supporting files. A turn
 * receives a frozen copy of every admitted skill; successful native edits come back as a change set
 * and are written to the owning home. `owner` marks entries the turn may modify.
 */
export interface SkillEntry {
  id: string
  revision: number
  nativePath: string
  content: string
  resources: Record<string, string>
  resourceEncodings: Record<string, 'base64'>
  enabled: boolean
  botId?: string
}
export interface SkillSource { home: string; owner?: string }

const MAX_FILE = 1024 * 1024
const MAX_SKILL = 4 * 1024 * 1024
const MAX_SKILLS = 400

function revision(content: string, resources: Record<string, string>): number {
  return parseInt(createHash('sha256').update(content).update(JSON.stringify(resources)).digest('hex').slice(0, 8), 16)
}

function readSkill(root: string, dir: string, owner: string | undefined, prefix: string): SkillEntry | undefined {
  const nativePath = relative(root, dir).split(sep).join('/')
  const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const resources: Record<string, string> = {}, resourceEncodings: Record<string, 'base64'> = {}
  let total = Buffer.byteLength(content)
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name.startsWith('.') || name === '__pycache__') continue
      const path = join(current, name), info = lstatSync(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { if (!existsSync(join(path, 'SKILL.md'))) walk(path); continue }
      if (!info.isFile() || path === join(dir, 'SKILL.md') || info.size > MAX_FILE || total + info.size > MAX_SKILL) continue
      const bytes = readFileSync(path), key = relative(dir, path).split(sep).join('/')
      const text = bytes.toString('utf8')
      if (Buffer.from(text, 'utf8').equals(bytes)) resources[key] = text
      else { resources[key] = bytes.toString('base64'); resourceEncodings[key] = 'base64' }
      total += info.size
    }
  }
  walk(dir)
  return { id: `${prefix}:${nativePath}`, revision: revision(content, resources), nativePath, content, resources, resourceEncodings, enabled: true, ...(owner ? { botId: owner } : {}) }
}

/** Later sources win for the same native path (a Bot's own skill shadows its Profile's). */
export function collectSkills(sources: SkillSource[]): SkillEntry[] {
  const entries = new Map<string, SkillEntry>()
  for (const [index, source] of sources.entries()) {
    const root = join(source.home, 'skills')
    if (!existsSync(root)) continue
    const visit = (dir: string, depth: number) => {
      if (depth > 4 || entries.size >= MAX_SKILLS) return
      if (existsSync(join(dir, 'SKILL.md')) && dir !== root) {
        try { const entry = readSkill(root, dir, source.owner, `s${index}`); if (entry) entries.set(entry.nativePath, entry) } catch { /* unreadable skill is skipped */ }
        return
      }
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        const path = join(dir, name)
        try { if (lstatSync(path).isDirectory()) visit(path, depth + 1) } catch { /* skip */ }
      }
    }
    visit(root, 0)
  }
  return [...entries.values()]
}

interface SkillChange { nativePath?: unknown; content?: unknown; resources?: unknown; resourceEncodings?: unknown; id?: unknown; expectedRevision?: unknown }

/** Persist one native change set into `home/skills`; returns the committed entries. */
export function commitSkills(home: string, owner: string, changes: unknown): SkillEntry[] {
  if (!Array.isArray(changes)) throw new Error('Invalid skill change set')
  const root = resolve(home, 'skills')
  const committed: SkillEntry[] = []
  for (const raw of changes as SkillChange[]) {
    const nativePath = typeof raw.nativePath === 'string' ? raw.nativePath : ''
    const dir = resolve(root, nativePath)
    if (!nativePath || !dir.startsWith(root + sep) || nativePath.split('/').some(part => !part || part === '..' || part.startsWith('.')))
      throw new Error('Invalid skill path')
    if (raw.content === null || raw.content === undefined) { rmSync(dir, { recursive: true, force: true }); continue }
    if (typeof raw.content !== 'string') throw new Error('Invalid skill content')
    const resources = raw.resources && typeof raw.resources === 'object' ? raw.resources as Record<string, unknown> : {}
    const encodings = raw.resourceEncodings && typeof raw.resourceEncodings === 'object' ? raw.resourceEncodings as Record<string, unknown> : {}
    const staging = `${dir}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    writeFileSync(join(staging, 'SKILL.md'), raw.content)
    for (const [name, value] of Object.entries(resources)) {
      const target = resolve(staging, name)
      if (typeof value !== 'string' || !target.startsWith(staging + sep)) throw new Error('Invalid skill resource')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, encodings[name] === 'base64' ? Buffer.from(value, 'base64') : value)
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    // Rename keeps a half-written skill from ever being visible to a concurrent turn.
    renameSync(staging, dir)
    const entry = readSkill(root, dir, owner, 'local')!
    committed.push({ ...entry, id: typeof raw.id === 'string' ? raw.id : entry.id })
  }
  return committed
}
