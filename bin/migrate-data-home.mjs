import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDataHome, legacyDataHome, legacyUpdateActive } from './lib/data-home.mjs'
import { migrateManagedDataHome } from './lib/managed-data-migration.mjs'

const deadline = Date.now() + 10 * 60 * 1000
for (;;) {
  try {
    if (legacyUpdateActive()) throw new Error('旧版升级事务仍在运行')
    await migrateManagedDataHome({ home: defaultDataHome(), port: Number(process.argv[2] || 15300) })
    break
  } catch (error) {
    if (Date.now() >= deadline) {
      try { appendFileSync(join(legacyDataHome(), 'data-migration.log'), `${new Date().toISOString()} ${error.message}\n`, { mode: 0o600 }) } catch {}
      process.exitCode = 1
      break
    }
    await new Promise(done => setTimeout(done, 5000))
  }
}
