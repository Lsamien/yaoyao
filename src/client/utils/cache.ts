import { openDB, type IDBPDatabase } from 'idb'

const memory = new Map<string, unknown>()
let databasePromise: Promise<IDBPDatabase | null> | undefined

async function database(): Promise<IDBPDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  databasePromise ??= openDB('hermes-yaoyao-cache', 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('records')) database.createObjectStore('records')
    },
  }).catch(() => null)
  return databasePromise
}

export class ScopedCache<T> {
  constructor(private readonly namespace: string, private readonly maximumBytes = 16 * 1024 * 1024) {}

  private key(scope: string, key: string): string { return `${this.namespace}:${scope}:${key}` }

  async get(scope: string, key: string): Promise<T | undefined> {
    const storageKey = this.key(scope, key)
    const db = await database()
    if (!db) return memory.get(storageKey) as T | undefined
    try { return await db.get('records', storageKey) as T | undefined } catch { return memory.get(storageKey) as T | undefined }
  }

  async set(scope: string, key: string, value: T, durable = false): Promise<void> {
    const serialized = JSON.stringify(value)
    if (new Blob([serialized]).size > this.maximumBytes) {
      if(durable)throw new Error('聊天缓存超出容量，未推进同步位置')
      return
    }
    // Cache records are JSON snapshots. Detach reactive proxies before IndexedDB
    // structured-clones them, and keep the memory fallback equally immutable.
    const snapshot = JSON.parse(serialized) as T
    const storageKey = this.key(scope, key)
    const db = await database()
    if(durable&&typeof indexedDB!=='undefined'&&!db)throw new Error('聊天缓存不可写，未推进同步位置')
    if (db) {
      if(durable)await db.put('records',snapshot,storageKey)
      else await db.put('records', snapshot, storageKey).catch(() => undefined)
    }
    memory.set(storageKey, snapshot)
  }

  async delete(scope: string, key: string): Promise<void> {
    const storageKey = this.key(scope, key)
    memory.delete(storageKey)
    const db = await database()
    if (db) await db.delete('records', storageKey).catch(() => undefined)
  }
}
