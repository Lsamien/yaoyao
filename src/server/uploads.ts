import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync, chmodSync, lstatSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Busboy from 'busboy'
import { HttpError } from './errors.js'
import { normalizeUploadName } from '../shared/uploadNames.js'

export const MAX_UPLOAD_FILE_BYTES = 25 * 1_024 * 1_024
export const MAX_UPLOAD_REQUEST_BYTES = 50 * 1_024 * 1_024
export const MAX_UPLOAD_FILES = 8
export const MAX_UPLOAD_QUOTA_BYTES = 2 * 1_024 * 1_024 * 1_024

export interface UploadReference {
  id: string
  name: string
  mimeType: string
  size: number
}

export interface UploadRecord extends UploadReference {
  path: string
  accountKey: string
  referenced: boolean
}

interface StagedUpload extends UploadRecord {
  tempPath: string
}

function cleanName(value: string): string {
  const safe = basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 240)
  return safe || 'attachment'
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ''
}

function within(root: string, path: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  return normalizedPath.startsWith(`${normalizedRoot}${sep}`)
}

export class UploadStore {
  readonly uploadRoot: string
  readonly #database: DatabaseSync

  constructor(
    home: string,
    readonly quotaBytes = MAX_UPLOAD_QUOTA_BYTES,
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    this.uploadRoot = join(home, 'uploads')
    mkdirSync(this.uploadRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.uploadRoot, 0o700)
    this.#database = new DatabaseSync(join(home, 'uploads.sqlite3'))
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        path TEXT NOT NULL UNIQUE,
        referenced INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_account_created
        ON uploads(account_key, created_at);
    `)
  }

  close(): void {
    this.#database.close()
  }

  commit(staged: readonly StagedUpload[]): UploadReference[] {
    if (staged.length === 0) throw new HttpError(400, 'At least one file is required', 'missing_files')
    const addedBytes = staged.reduce((sum, file) => sum + file.size, 0)
    const usage = this.#database.prepare(
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM uploads',
    ).get() as { bytes: number }
    if (Number(usage.bytes) + addedBytes > this.quotaBytes) {
      this.discard(staged)
      throw new HttpError(413, 'Upload quota exceeded', 'upload_quota_exceeded')
    }

    const insert = this.#database.prepare(`
      INSERT INTO uploads(id, account_key, name, mime_type, size, path, referenced, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `)
    const moved: string[] = []
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const file of staged) {
        if (!within(this.uploadRoot, file.path) || !within(this.uploadRoot, file.tempPath)) {
          throw new HttpError(500, 'Invalid upload destination')
        }
        renameSync(file.tempPath, file.path)
        chmodSync(file.path, 0o600)
        moved.push(file.path)
        insert.run(
          file.id,
          file.accountKey,
          file.name,
          file.mimeType,
          file.size,
          file.path,
          Date.now(),
        )
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      this.discard(staged)
      for (const path of moved) rmSync(path, { force: true })
      throw error
    }
    return staged.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
  }

  records(ids: readonly string[], accountKey: string): UploadRecord[] {
    if (ids.length > MAX_UPLOAD_FILES) {
      throw new HttpError(400, `At most ${MAX_UPLOAD_FILES} uploads may be referenced`, 'too_many_uploads')
    }
    const unique = [...new Set(ids)]
    const lookup = this.#database.prepare(`
      SELECT id, account_key, name, mime_type, size, path, referenced
      FROM uploads WHERE id = ? AND account_key = ?
    `)
    const records = unique.map((id) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) {
        throw new HttpError(400, 'Invalid upload reference', 'invalid_upload')
      }
      const row = lookup.get(id, accountKey) as {
        id: string
        account_key: string
        name: string
        mime_type: string
        size: number
        path: string
        referenced: number
      } | undefined
      if (!row || !within(this.uploadRoot, row.path)) {
        throw new HttpError(404, 'Upload reference not found', 'upload_not_found')
      }
      const stat = lstatSync(row.path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new HttpError(409, 'Upload reference is no longer safe', 'unsafe_upload')
      }
      return {
        id: row.id,
        accountKey: row.account_key,
        name: normalizeUploadName(row.name),
        mimeType: row.mime_type,
        size: Number(row.size),
        path: row.path,
        referenced: Boolean(row.referenced),
      }
    })
    return records
  }

  markReferenced(ids: readonly string[], accountKey: string): void {
    const statement = this.#database.prepare(
      'UPDATE uploads SET referenced = 1 WHERE id = ? AND account_key = ?',
    )
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const id of new Set(ids)) statement.run(id, accountKey)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  cleanupUncommitted(maxAgeMs = 24 * 60 * 60 * 1_000): number {
    const rows = this.#database.prepare(
      'SELECT id, path FROM uploads WHERE referenced = 0 AND created_at < ?',
    ).all(Date.now() - maxAgeMs) as Array<{ id: string; path: string }>
    const remove = this.#database.prepare('DELETE FROM uploads WHERE id = ? AND referenced = 0')
    let count = 0
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        if (within(this.uploadRoot, row.path)) rmSync(row.path, { force: true })
        remove.run(row.id)
        count += 1
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return count
  }

  discard(staged: readonly Pick<StagedUpload, 'tempPath' | 'path'>[]): void {
    for (const file of staged) {
      if (within(this.uploadRoot, file.tempPath)) rmSync(file.tempPath, { force: true })
      if (within(this.uploadRoot, file.path)) rmSync(file.path, { force: true })
    }
  }
}

export async function receiveGroupUploads(
  request: IncomingMessage,
  store: UploadStore,
  accountKey: string,
): Promise<UploadReference[]> {
  const contentType = request.headers['content-type']
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(415, 'Expected multipart/form-data', 'invalid_content_type')
  }
  const declared = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_REQUEST_BYTES + 128 * 1_024) {
    throw new HttpError(413, 'Upload request is too large', 'upload_request_too_large')
  }

  const busboy = Busboy({
    headers: request.headers,
    // Browser FormData sends ordinary filename parameters as UTF-8 bytes.
    defParamCharset: 'utf8',
    limits: {
      files: MAX_UPLOAD_FILES,
      fileSize: MAX_UPLOAD_FILE_BYTES,
      fields: 8,
      parts: MAX_UPLOAD_FILES + 8,
    },
  })
  const staged: StagedUpload[] = []
  const tasks: Promise<void>[] = []
  let total = 0
  let parserError: Error | undefined

  busboy.on('file', (_field, stream, info) => {
    const id = randomUUID()
    const name = cleanName(info.filename)
    const destination = join(store.uploadRoot, `${id}${safeExtension(name)}`)
    const tempPath = join(store.uploadRoot, `.${id}.part`)
    const stagedFile: StagedUpload = {
      id,
      accountKey,
      name,
      mimeType: info.mimeType || 'application/octet-stream',
      size: 0,
      path: destination,
      tempPath,
      referenced: false,
    }
    staged.push(stagedFile)
    let limited = false
    stream.once('limit', () => { limited = true })
    tasks.push((async () => {
      const handle = await open(tempPath, 'wx', 0o600)
      const output = createWriteStream(tempPath, { fd: handle.fd, autoClose: false })
      try {
        for await (const chunk of stream) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          total += data.byteLength
          stagedFile.size += data.byteLength
          if (total > MAX_UPLOAD_REQUEST_BYTES) {
            throw new HttpError(413, 'Combined uploads exceed 50 MiB', 'upload_request_too_large')
          }
          if (!output.write(data)) await new Promise<void>((resolve) => output.once('drain', resolve))
        }
        if (limited || stagedFile.size > MAX_UPLOAD_FILE_BYTES) {
          throw new HttpError(413, `${name} exceeds 25 MiB`, 'upload_file_too_large')
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          output.end((error?: Error | null) => error ? reject(error) : resolve())
        })
        await handle.close().catch(() => undefined)
      }
    })())
  })
  busboy.once('filesLimit', () => {
    parserError = new HttpError(413, `At most ${MAX_UPLOAD_FILES} files are allowed`, 'too_many_uploads')
  })
  busboy.once('partsLimit', () => {
    parserError = new HttpError(413, 'Multipart request has too many parts', 'too_many_parts')
  })

  try {
    await new Promise<void>((resolvePromise, reject) => {
      busboy.once('error', reject)
      busboy.once('finish', resolvePromise)
      request.pipe(busboy)
    })
    await Promise.all(tasks)
    if (parserError) throw parserError
    return store.commit(staged)
  } catch (error) {
    await Promise.allSettled(tasks)
    store.discard(staged)
    throw error
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\\[\]]/g, '\\$&')
}

export function uploadMarkdown(records: readonly UploadRecord[]): string {
  return records.map((record) => `[${escapeMarkdown(record.name)}](<${record.path}>)`).join('\n')
}
