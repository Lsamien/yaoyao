import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LaunchAgentService } from './service-update.mjs'
import { defaultDataHome, legacyDataHome } from './data-home.mjs'
import { migrateDataHome, rebaseDataPath } from './data-migration.mjs'

export async function migrateManagedDataHome({ home, port = 15300, onProgress = () => {}, beforeMove }) {
  if (home !== defaultDataHome()) return
  const old = legacyDataHome(), releaseRoot = join(homedir(), '.local', 'share', 'hermes-yaoyao')
  let previous, driver
  if (existsSync(old)) {
    driver = new LaunchAgentService({ home: old, port, releaseRoot })
    previous = driver.snapshot()
    if (previous) {
      onProgress('正在等待旧服务空闲，准备迁移数据到 ~/.yaoyao…')
      await driver.quiesce(onProgress, 0)
      await driver.stop()
    }
  }
  try {
    if (existsSync(old)) await beforeMove?.(old)
    migrateDataHome(home)
  } catch (error) {
    if (previous && existsSync(old)) await driver.restore(previous)
    throw error
  }
  // Also recover a crash between the atomic rename and the LaunchAgent rewrite.
  if (!existsSync(home)) return
  const currentDriver = new LaunchAgentService({ home, port, releaseRoot })
  if (!previous && existsSync(join(home, '.data-home-migration.json')) && existsSync(currentDriver.plistPath)) {
    const { execFileSync } = await import('node:child_process')
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', currentDriver.plistPath], { encoding: 'utf8' }))
    if (plist.EnvironmentVariables?.HERMES_YAOYAO_HOME === old) previous = { plist, wasRunning: true }
  }
  if (previous) {
    for (const [key, value] of Object.entries(previous.plist.EnvironmentVariables ?? {})) previous.plist.EnvironmentVariables[key] = rebaseDataPath(value, old, home)
    previous.plist.EnvironmentVariables.HERMES_YAOYAO_HOME = home
    previous.plist.EnvironmentVariables.YAOYAO_HOME = home
    for (const field of ['StandardOutPath', 'StandardErrorPath']) previous.plist[field] = rebaseDataPath(previous.plist[field], old, home)
    currentDriver.writePlist(previous.plist)
    if (previous.wasRunning) { await currentDriver.boot(); await currentDriver.verify(undefined) }
    onProgress('账号、会话、文件和配置已迁移到 ~/.yaoyao')
  }
}
