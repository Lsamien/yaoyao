import request from 'supertest'
import type { ApplicationRuntime } from '../../src/server/app.js'

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** A supertest client on the admin console listener, with the console's own CSRF token and session. */
export async function consoleClient(runtime: Pick<ApplicationRuntime, 'adminApp' | 'config'>, credentials?: { username: string; password: string; code?: string }) {
  const agent = request.agent(runtime.adminApp.callback())
  const host = `127.0.0.1:${runtime.config.admin.port}`
  const origin = `http://${host}`
  const session = await agent.get('/api/app/console/session').set('Host', host).expect(200)
  let csrf = String(session.body.csrfToken)
  const call = (method: Method, path: string) => agent[method](path).set('Host', host).set('Origin', origin).set('X-CSRF-Token', csrf)
  let login: request.Response | undefined
  if (credentials) {
    login = await call('post', '/api/app/console/login').send(credentials)
    if (login.status !== 200) throw new Error(`console login failed: ${login.status} ${JSON.stringify(login.body)}`)
    csrf = String(login.body.csrfToken)
  }
  return { agent, call, host, origin, csrf: () => csrf, login }
}
