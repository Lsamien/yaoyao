import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** A native helper owns the update until completion, even if the window closes.
 * The renderer never receives its configuration or a process-control bridge. */
export const synchronizeLocalService = options => serviceCommand({...options,action:'sync'})
export const stopLocalService = options => serviceCommand({...options,action:'stop'})
function serviceCommand({ home, port, root, fixture, environment, onProgress = () => {}, action }) {
  return new Promise((done, reject) => {
    const runtimeRoot = join(root, 'web-service')
    const helper = spawn(join(runtimeRoot, 'node'), [join(runtimeRoot, 'bin', 'desktop-service-sync.mjs')], {
      cwd: runtimeRoot, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { HOME: process.env.HOME, PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', NODE_USE_ENV_PROXY: '0' },
    })
    let buffer = '', result, failure, failureCode
    helper.stdout.on('data', bytes => {
      buffer += bytes
      if (buffer.length > 256 * 1024) { failure = '同步进程输出异常'; return }
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try { const value = JSON.parse(line); if (value.message) onProgress(value.message); if (value.result) result = value.result; if (value.error) { failure = value.error; failureCode = value.code } }
        catch { failure = '同步进程响应无效' }
      }
    })
    helper.once('error', reject)
    helper.once('exit', code => code === 0 && result ? done(result) : reject(Object.assign(new Error(failure || (action==='stop'?'后台服务停止未完成':'本机 Web 同步未完成，请重试')), { code: failureCode })))
    helper.stdin.on('error', () => {})
    helper.stdin.end(JSON.stringify({ home, port, runtimeRoot, fixture, environment, action }))
  })
}
