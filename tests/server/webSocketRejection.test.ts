// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeServer, type NodeServerRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticatedApplication as createApplication } from './authenticatedApplication.js'
import { createEmbeddedHermes } from '../../src/server/hermes/embedded.js'
import { kernelPaths } from '../../src/server/hermes/paths.js'

const kernel = existsSync(kernelPaths().python)

const closers: Array<() => Promise<void>> = []
const homes: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
}

function closeRuntime(runtime: NodeServerRuntime): () => Promise<void> {
  return () => runtime.close()
}

describe('client transport', () => {
  it('rejects client WebSocket upgrades instead of keeping legacy compatibility', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-ws-'))
    homes.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 15300,
      upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(),
      home,
      allowInsecureLan: false,
      insecureLan: false,
      production: true,
    }
    const application = createApplication({ config })
    const node = createNodeServer(application)
    await listen(node.server)
    closers.push(closeRuntime(node))
    const port = (node.server.address() as AddressInfo).port
    config.port = port
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/vite-hmr`, {
        origin: `http://127.0.0.1:${port}`,
      })
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
      })
      socket.once('error', reject)
    })
    expect(status).toBe(410)
  })
})
