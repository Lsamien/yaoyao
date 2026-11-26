import Koa from 'koa'
import Router from '@koa/router'
import { bodyParser } from '@koa/bodyparser'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../../src/server/errors.js'
import { registerHermesAdminRoutes } from '../../src/server/hermesAdminRoutes.js'

function fixture(admin = true) {
  const call = vi.fn(async (_scope: unknown, op: string, _args?: Record<string, unknown>) => {
    if (op === 'env.list') return {
      OPENROUTER_API_KEY: { is_set: true, redacted_value: 'sk-…abcd', description: 'OpenRouter', url: 'https://openrouter.ai/keys', category: 'provider', is_password: true, advanced: false, provider: 'openrouter', provider_label: 'OpenRouter', custom: false, readonly: false },
      TELEGRAM_BOT_TOKEN: { is_set: false, category: 'messaging', is_password: true },
      SLACK_TOKEN: { is_set: false, category: 'tool', channel_managed: true },
    }
    if (op === 'model.auxiliary') return { tasks: [{ task: 'vision', provider: 'auto', model: '' }], main: { provider: 'openrouter', model: 'x' } }
    if (op === 'providers.catalog') return { providers: [{ id: 'openrouter', label: 'OpenRouter' }, { id: '' }] }
    return { ok: true }
  })
  const app = new Koa()
  app.use(async (ctx, next) => { try { await next() } catch (error) { ctx.status = error instanceof HttpError ? error.status : 500; ctx.body = { error: (error as Error).message } } })
  app.use(bodyParser({ parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'] }))
  const router = new Router()
  registerHermesAdminRoutes(router, {
    auth: { requireAdmin: () => { if (!admin) throw new HttpError(403, 'forbidden') } },
    hermes: { pool: { call } } as never,
  })
  app.use(router.routes())
  return { server: app.callback(), call }
}

describe('Hermes admin routes', () => {
  it('lists credentials without messaging or channel-managed variables', async () => {
    const { server, call } = fixture()
    const response = await request(server).get('/api/app/admin/hermes/credentials?profile=writer').expect(200)
    expect(response.body.variables.map((row: { key: string }) => row.key)).toEqual(['OPENROUTER_API_KEY'])
    expect(response.body.variables[0]).toMatchObject({ isSet: true, preview: 'sk-…abcd', secret: true, providerLabel: 'OpenRouter' })
    expect(call).toHaveBeenCalledWith({ profile: 'writer' }, 'env.list', {}, expect.anything())
  })

  it('saves and deletes variables on the system home by default', async () => {
    const { server, call } = fixture()
    await request(server).put('/api/app/admin/hermes/credentials').send({ key: 'OPENROUTER_API_KEY', value: ' sk-1 ' }).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'env.set', { key: 'OPENROUTER_API_KEY', value: 'sk-1' }, expect.anything())
    await request(server).delete('/api/app/admin/hermes/credentials').send({ key: 'OPENROUTER_API_KEY' }).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'env.delete', { key: 'OPENROUTER_API_KEY' }, expect.anything())
    await request(server).put('/api/app/admin/hermes/credentials').send({ key: 'bad key', value: 'x' }).expect(400)
    await request(server).put('/api/app/admin/hermes/credentials').send({ key: 'A', value: ' ' }).expect(400)
  })

  it('assigns auxiliary models and resets them to auto', async () => {
    const { server, call } = fixture()
    const response = await request(server).put('/api/app/admin/hermes/auxiliary').send({ task: 'vision', provider: 'openrouter', model: 'gpt-x' }).expect(200)
    expect(call).toHaveBeenCalledWith('system', 'model.set', { scope: 'auxiliary', task: 'vision', provider: 'openrouter', model: 'gpt-x' }, expect.anything())
    expect(response.body.tasks[0].task).toBe('vision')
    expect(response.body.providers).toEqual([{ id: 'openrouter', label: 'OpenRouter' }])
    await request(server).put('/api/app/admin/hermes/auxiliary').send({ task: '__reset__' }).expect(200)
    expect(call).toHaveBeenCalledWith('system', 'model.set', { scope: 'auxiliary', task: '__reset__', provider: 'auto', model: '' }, expect.anything())
    await request(server).put('/api/app/admin/hermes/auxiliary').send({ task: 'vision', provider: 'openrouter' }).expect(400)
  })

  it('runs OAuth sign-in with a held service process', async () => {
    const { server, call } = fixture()
    await request(server).post('/api/app/admin/hermes/oauth/nous/start').send({}).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'oauth.start', { provider: 'nous' }, expect.objectContaining({ hold: true }))
    await request(server).post('/api/app/admin/hermes/oauth/nous/poll').send({ sessionId: 'abc' }).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'oauth.poll', { provider: 'nous', sessionId: 'abc' }, expect.anything())
    await request(server).post('/api/app/admin/hermes/oauth/anthropic/token').send({ token: 'sk-ant' }).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'oauth.submit', { provider: 'anthropic', token: 'sk-ant' }, expect.anything())
    await request(server).delete('/api/app/admin/hermes/oauth/nous').send({}).expect(200)
    expect(call).toHaveBeenLastCalledWith('system', 'oauth.disconnect', { provider: 'nous' }, expect.anything())
  })

  it('rejects non-admins and invalid profiles before reaching Hermes', async () => {
    const denied = fixture(false)
    await request(denied.server).get('/api/app/admin/hermes/credentials').expect(403)
    expect(denied.call).not.toHaveBeenCalled()
    const { server, call } = fixture()
    await request(server).get('/api/app/admin/hermes/auxiliary?profile=../x').expect(400)
    expect(call).not.toHaveBeenCalled()
  })
})
