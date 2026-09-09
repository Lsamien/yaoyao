import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.HERMES_YAOYAO_VERIFY_PORT || 18800)
const entry = new URL('../dist-server/server/index.js', import.meta.url)
const verificationHome = mkdtempSync(join(tmpdir(), 'yaoyao-lifecycle-'))

function listenerPids(targetPort) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  return new Set(result.stdout.split(/\s+/).map(value => value.trim()).filter(Boolean))
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Host: `127.0.0.1:${port}` },
      })
      if (response.ok) return
    } catch {
      // Server may still be materializing the production bundle.
    }
    await delay(150)
  }
  throw new Error('Timed out waiting for the verification server')
}

const gatewayBefore = listenerPids(9119)
const child = spawn(process.execPath, [entry.pathname], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HERMES_YAOYAO_HOST: '127.0.0.1',
    HERMES_YAOYAO_HOME: verificationHome,
    HERMES_YAOYAO_PORT: String(port),
    HERMES_YAOYAO_UPSTREAM: process.env.HERMES_YAOYAO_UPSTREAM || 'http://127.0.0.1:9119',
    HERMES_YAOYAO_SUPERVISE_DASHBOARD: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', chunk => { stderr += chunk.toString() })

try {
  await waitForHealth()
  const webPids = listenerPids(port)
  if (webPids.size !== 1) throw new Error(`Expected one ${port} listener, received ${[...webPids].join(', ') || 'none'}`)
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5_000).then(() => child.kill('SIGKILL')),
  ])
  rmSync(verificationHome, { recursive: true, force: true })
}

const gatewayAfter = listenerPids(9119)
if ([...gatewayBefore].join(',') !== [...gatewayAfter].join(',')) {
  throw new Error(`9119 listener changed: before=${[...gatewayBefore]} after=${[...gatewayAfter]}`)
}
if (child.exitCode !== 0 && child.signalCode !== 'SIGTERM') {
  throw new Error(`Verification server failed: ${stderr.trim()}`)
}
process.stdout.write(`Lifecycle verified: one ${port} listener; 9119 unchanged (${[...gatewayAfter].join(',') || 'no listener'}).\n`)
