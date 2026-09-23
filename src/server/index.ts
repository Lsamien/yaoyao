import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import send from 'koa-send'
import serve from 'koa-static'
import { createApplication, createNodeServer } from './app.js'
import { loadServerConfig } from './config.js'
import { DashboardSupervisor } from './dashboardSupervisor.js'
import { isLocalAuthorizationTarget } from './loopbackAuthorization.js'
import { acquireServiceInstance } from './serviceInstance.js'
import { readReleaseManifest } from './releases.js'
import { readBuildIdentity } from './buildIdentity.js'
import { migrateDataHome } from '../../bin/lib/data-migration.mjs'
import { legacyDataHome, resolveDataHome } from '../../bin/lib/data-home.mjs'
import { spawn } from 'node:child_process'
import { ServerDashboardController } from './dashboardController.js'
import { DesktopActivation } from './desktopActivation.js'

migrateDataHome(resolveDataHome(process.env.YAOYAO_HOME || process.env.HERMES_YAOYAO_HOME, { preserveActiveUpdate: true }))
const config = loadServerConfig()
if (config.home === legacyDataHome() && process.platform === 'darwin') {
  const child = spawn(process.execPath, [resolve(process.cwd(), 'bin/migrate-data-home.mjs'), String(config.port)], { detached: true, stdio: 'ignore' })
  child.on('error', error => console.error('数据迁移助手启动失败：', error.message))
  child.unref()
}
const instance = acquireServiceInstance(config.home, readReleaseManifest(resolve(process.cwd(), 'release.json')).webVersion, process.env.HERMES_YAOYAO_DESKTOP === '1', readBuildIdentity(process.cwd()))
process.once('exit', () => instance.release())
const dashboardSupervisor = config.superviseDashboard
  && isLocalAuthorizationTarget(config.upstream) && config.upstream.hostname === '127.0.0.1'
  && config.upstream.protocol === 'http:' && config.upstream.port === '9119'
  ? new DashboardSupervisor({ managed: process.env.HERMES_YAOYAO_DESKTOP === '1' })
  : undefined
const dashboardController = new ServerDashboardController(config.upstream, dashboardSupervisor)
const runtime = createApplication({config, dashboardSupervisor: dashboardController, deferBackground: true})
const nodeRuntime = createNodeServer(runtime, {deferBackground:true})
const desktopActivation = new DesktopActivation(config.home, process.env.HERMES_YAOYAO_DEFER_HERMES === '1', () => {
  nodeRuntime.startBackground()
  dashboardSupervisor?.start()
})
let closeFrontend = async (): Promise<void> => undefined
// Native update admission runs before routes (including streamed requests).
// The capability is loopback-only and never shared with the Web renderer.
runtime.app.middleware.unshift(instance.middleware(shutdown, () => runtime.realtime.broker.idleForUpdate
  && runtime.runners.idleForUpdate && runtime.workspaceRuntime.idleForUpdate && runtime.desktopEnvironments.idleForUpdate && runtime.hermesBridge.idleForUpdate, ctx=>runtime.desktopEnvironments.bridge(ctx), desktopActivation))

if (runtime.config.production) {
  const dist = resolve(process.env.HERMES_YAOYAO_STATIC_DIR || resolve(process.cwd(), 'dist'))
  runtime.app.use(serve(dist, { index: 'index.html' }))
  runtime.app.use(async (ctx) => {
    if (ctx.method !== 'GET' || !ctx.accepts('html') || !existsSync(resolve(dist, 'index.html'))) {
      ctx.status = 404
      return
    }
    await send(ctx, 'index.html', { root: dist })
  })
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    server: {
      middlewareMode: true,
      ws: { server: nodeRuntime.server },
    },
    appType: 'spa',
  })
  closeFrontend = () => vite.close()
  runtime.app.use(async (ctx) => {
    const handled = await new Promise<boolean>((resolvePromise, reject) => {
      const finish = () => {
        cleanup()
        resolvePromise(true)
      }
      const cleanup = () => {
        ctx.res.off('finish', finish)
        ctx.res.off('close', finish)
      }
      ctx.res.once('finish', finish)
      ctx.res.once('close', finish)
      vite.middlewares(ctx.req, ctx.res, (error?: unknown) => {
        cleanup()
        if (error) reject(error)
        else resolvePromise(false)
      })
    })
    if (handled) ctx.respond = false
    else ctx.status = 404
  })
}

nodeRuntime.server.once('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`夭夭 AI could not start: ${runtime.config.host}:${runtime.config.port} is already in use`)
  } else {
    console.error(`夭夭 AI could not start: ${error.message}`)
  }
  void shutdown().finally(() => { process.exitCode = 1 })
})
nodeRuntime.server.listen(runtime.config.port, runtime.config.host, () => {
  const protocol = runtime.config.tlsCert ? 'https' : 'http'
  console.log(`夭夭 AI listening on ${protocol}://${runtime.config.host}:${runtime.config.port}`)
  instance.publish(`${protocol}://${runtime.config.host}:${runtime.config.port}`)
  if (runtime.config.insecureLan) {
    console.warn('Warning: trusted-LAN HTTP mode is enabled; credentials are not encrypted in transit.')
  }
  desktopActivation.start()
})

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  instance.beginShutdown()
  dashboardController.stop()
  try {
    dashboardSupervisor?.stop()
    await closeFrontend()
    // Existing browser/SSE connections must not keep an explicitly stopped
    // background process alive after its workers and VMs have been cleaned up.
    await nodeRuntime.close(true)
    await dashboardSupervisor?.stopOwned()
  } finally {
    instance.release()
    process.exitCode = 0
  }
}

process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
