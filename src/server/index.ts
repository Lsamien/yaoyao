import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import send from 'koa-send'
import serve from 'koa-static'
import { createApplication, createNodeServer } from './app.js'
import { serveConsoleStatic } from './admin/app.js'
import { loadServerConfig } from './config.js'
import { acquireServiceInstance } from './serviceInstance.js'
import { readReleaseManifest } from './releases.js'
import { readBuildIdentity } from './buildIdentity.js'
import { migrateDataHome } from '../../bin/lib/data-migration.mjs'
import { legacyDataHome, resolveDataHome } from '../../bin/lib/data-home.mjs'
import { spawn } from 'node:child_process'
import { DesktopActivation } from './desktopActivation.js'
import { importLegacyHermes } from './hermes/import.js'
import { kernelPaths } from './hermes/paths.js'
import { prepareKernel } from '../../bin/lib/kernel-setup.mjs'

migrateDataHome(resolveDataHome(process.env.YAOYAO_HOME || process.env.HERMES_YAOYAO_HOME, { preserveActiveUpdate: true }))
const config = loadServerConfig()
if (config.home === legacyDataHome() && process.platform === 'darwin') {
  const child = spawn(process.execPath, [resolve(process.cwd(), 'bin/migrate-data-home.mjs'), String(config.port)], { detached: true, stdio: 'ignore' })
  child.on('error', error => console.error('数据迁移助手启动失败：', error.message))
  child.unref()
}
const instance = acquireServiceInstance(config.home, readReleaseManifest(resolve(process.cwd(), 'release.json')).webVersion, process.env.HERMES_YAOYAO_DESKTOP === '1', readBuildIdentity(process.cwd()))
process.once('exit', () => instance.release())
const retiredHermesVariables = ['HERMES_YAOYAO_UPSTREAM', 'HERMES_YAOYAO_UPSTREAM_USERNAME', 'HERMES_YAOYAO_UPSTREAM_PASSWORD', 'HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE', 'HERMES_YAOYAO_SUPERVISE_DASHBOARD', 'HERMES_YAOYAO_BRIDGE_MOUNTED', 'HERMES_YAOYAO_BRIDGE_HOME', 'HERMES_YAOYAO_BRIDGE_PYTHON'].filter(name => process.env[name])
if (retiredHermesVariables.length) console.warn(`Hermes 已内置在夭夭中，以下变量不再生效：${retiredHermesVariables.join('、')}`)
// First start with the embedded kernel: copy an existing ~/.hermes (read-only) into <data>/hermes.
const reportImport = (result: ReturnType<typeof importLegacyHermes>) => {
  if (result.status === 'imported') console.log(`已导入原 Hermes 数据（${result.source}，${result.files} 个文件）`)
  else if (result.status === 'failed') console.error(`原 Hermes 数据导入失败，内置 Hermes 将从空数据启动：${result.error}`)
}
const kernel = kernelPaths()
if (existsSync(kernel.python)) reportImport(importLegacyHermes(config.home))
else {
  // npm installs that skipped postinstall, and packaged apps, prepare the kernel on first start.
  console.log('正在准备内置 Hermes 内核（首次启动需要下载 Python 依赖）…')
  void prepareKernel({ root: kernel.root }).then(() => {
    console.log('内置 Hermes 内核已就绪')
    reportImport(importLegacyHermes(config.home))
  }, (error: Error) => console.error(error.message))
}
const runtime = createApplication({config, deferBackground: true})
const nodeRuntime = createNodeServer(runtime, {deferBackground:true})
const desktopActivation = new DesktopActivation(config.home, process.env.HERMES_YAOYAO_DEFER_HERMES === '1', () => {
  nodeRuntime.startBackground()
})
let closeFrontend = async (): Promise<void> => undefined
// Native update admission runs before routes (including streamed requests).
// The capability is loopback-only and never shared with the Web renderer.
runtime.app.middleware.unshift(instance.middleware(shutdown, () => runtime.runners.idleForUpdate && runtime.workspaceRuntime.idleForUpdate && runtime.desktopEnvironments.idleForUpdate && runtime.hermes.gateway.idle, ctx=>runtime.desktopEnvironments.bridge(ctx), desktopActivation, ctx => {
    const user = runtime.auth.localDesktopSession(ctx)
    ctx.body = { user, setCookies: ctx.response.get('set-cookie') }
  }))

// The console bundle lives in dist/admin but is served only on the admin port.
runtime.app.use(async (ctx, next) => {
  if (ctx.path === '/admin' || ctx.path.startsWith('/admin/') || ctx.path === '/admin.html') { ctx.status = 404; return }
  await next()
})
if (runtime.config.production) {
  const dist = resolve(process.env.HERMES_YAOYAO_STATIC_DIR || resolve(process.cwd(), 'dist'))
  serveConsoleStatic(runtime.adminApp, resolve(dist, 'admin'))
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
  // Development: the same Vite server renders the console entry (admin.html) on the admin port.
  runtime.adminApp.use(async (ctx) => {
    if (ctx.method === 'GET' && !/\.[a-z0-9]+$/i.test(ctx.path) && !ctx.path.startsWith('/@') && !ctx.path.startsWith('/src/') && !ctx.path.startsWith('/node_modules/')) ctx.req.url = '/admin.html'
    const handled = await new Promise<boolean>((resolvePromise, reject) => {
      const finish = () => { ctx.res.off('finish', finish); ctx.res.off('close', finish); resolvePromise(true) }
      ctx.res.once('finish', finish)
      ctx.res.once('close', finish)
      vite.middlewares(ctx.req, ctx.res, (error?: unknown) => {
        ctx.res.off('finish', finish); ctx.res.off('close', finish)
        if (error) reject(error)
        else resolvePromise(false)
      })
    })
    if (handled) ctx.respond = false
    else ctx.status = 404
  })
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
const adminServer = nodeRuntime.adminServer
if (adminServer) {
  const { host, port, external } = runtime.config.admin
  adminServer.once('error', (error: NodeJS.ErrnoException) => {
    // The Web keeps running; the console is reported as unavailable.
    console.error(error.code === 'EADDRINUSE'
      ? `管理后台无法启动：${host}:${port} 已被占用。可用 YAOYAO_ADMIN_PORT 指定其他端口。`
      : `管理后台无法启动：${error.message}`)
  })
  adminServer.listen(port, host, () => {
    const protocol = runtime.config.tlsCert ? 'https' : 'http'
    console.log(`夭夭管理后台 listening on ${protocol}://${host}:${port}${external ? '（允许远程访问，已启用访问白名单）' : '（仅本机）'}`)
  })
}

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  instance.beginShutdown()
  try {
    await closeFrontend()
    // Existing browser/SSE connections must not keep an explicitly stopped
    // background process alive after its workers and VMs have been cleaned up.
    await nodeRuntime.close(true)
  } finally {
    instance.release()
    process.exitCode = 0
  }
}

process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
