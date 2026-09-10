import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { LaunchAgentService, synchronizeDesktop, stopDesktopService } from './lib/service-update.mjs'
import { migrateManagedDataHome } from './lib/managed-data-migration.mjs'

// Losing the App's progress pipe must not interrupt a durable service transaction.
process.stdout.on('error', error => { if (!['EPIPE', 'EIO'].includes(error.code)) process.exitCode = 1 })

let input = ''
for await (const bytes of process.stdin) { input += bytes; if (input.length > 32768) throw new Error('同步参数过大') }
try {
  const options = JSON.parse(input)
  const home = resolve(options.home), port = Number(options.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本机服务端口无效')
  if (options.action === 'migrate') {
    if (!options.fixture) await migrateManagedDataHome({ home, port, onProgress: message => process.stdout.write(JSON.stringify({ message }) + '\n') })
    process.stdout.write(JSON.stringify({ result: { action: 'migrated' } }) + '\n')
    process.exit(0)
  }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // Fixture mode isolates *all* service/update state, including launchd labels.
  const fixture = options.fixture === true
  const releaseRoot = fixture ? join(home, 'updates', 'fixture-releases') : join(homedir(), '.local', 'share', 'hermes-yaoyao')
  const label = fixture ? `cn.samien.yaoyao.sync-test.${createHash('sha256').update(home).digest('hex').slice(0, 16)}` : 'com.samien.hermes-yaoyao'
  const driver = new LaunchAgentService({ home, port, releaseRoot, label,
    plistPath: fixture ? join(home, 'updates', 'fixture-service.plist') : undefined,
    environment: options.environment,
  })
  if(options.action!==undefined&&!['sync','stop'].includes(options.action))throw new Error('本机服务操作无效')
  const onProgress = message => process.stdout.write(JSON.stringify({ message }) + '\n')
  const result = options.action==='stop'
    ? await stopDesktopService({home,driver,onProgress})
    : await synchronizeDesktop({ home, runtimeRoot: resolve(options.runtimeRoot), releaseRoot, driver, onProgress })
  const current = result.current
  process.stdout.write(JSON.stringify({ result: { action: result.action, current: current && {
    version: current.version, commit: current.commit, buildNumber: current.buildNumber, artifactDigest: current.artifactDigest,
  } } }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message, code: error.code }) + '\n'); process.exitCode = 1
}
