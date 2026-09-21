import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DesktopOnboarding } from './onboarding.mjs'

function fixture(overrides = {}) {
  const calls = []
  const flow = new DesktopOnboarding({
    remoteServer: () => 'http://remote.test:15300',
    prepareLocal: async () => { calls.push('prepare'); return 'http://127.0.0.1:15300' },
    inspect: async () => ({ authenticated: false, setupRequired: true }),
    authenticate: async value => { calls.push(value); return { username: value.username } },
    activate: async value => { calls.push({ mode: value.mode, remember: value.remember }) },
    navigate: async url => { calls.push(url) }, ...overrides,
  })
  return { flow, calls }
}
test('selection, local preparation and account creation run in order; snapshots contain no credentials', async () => {
  const { flow, calls } = fixture()
  await assert.rejects(() => flow.submit({ username: 'admin', password: 'password' }), /检测/)
  flow.select('local')
  await flow.prepare()
  assert.equal(flow.snapshot().setupRequired, true)
  await assert.rejects(() => flow.submit({ username: 'admin', password: 'password', confirmation: 'different' }), /不一致/)
  await flow.submit({ username: 'admin', password: 'password', confirmation: 'password', remember: true })
  assert.deepEqual(calls, ['prepare', { mode: 'local', serverURL: 'http://127.0.0.1:15300', setup: true, username: 'admin', password: 'password' }, { mode: 'local', remember: true }, 'http://127.0.0.1:15300'])
  assert.equal(flow.snapshot().active, false)
  assert.equal(JSON.stringify(flow.snapshot()).includes('password'), false)
  assert.doesNotThrow(() => flow.open({ mode: 'remote' }), 'completed flows can reopen in the same window')
})
test('an in-flight server check cannot be switched underneath credentials', async () => {
  let release
  const { flow, calls } = fixture({ inspect: () => new Promise(resolve => { release = resolve }) })
  flow.select('remote')
  const checking = flow.prepare()
  assert.throws(() => flow.select('local'), /尚未完成/)
  await assert.rejects(() => flow.submit({ username: 'admin', password: 'password' }), /检测/)
  release({ authenticated: false }); await checking
  assert.equal(flow.snapshot().serverURL, 'http://remote.test:15300')
  assert.deepEqual(calls, [])
})
test('remote setup is blocked; failed checks and wrong passwords stay inline and can be retried', async () => {
  let checks = 0, logins = 0
  const { flow } = fixture({
    inspect: async () => ++checks === 1 ? { setupRequired: true, authenticated: false } : { authenticated: false },
    authenticate: async () => { if (++logins === 1) throw new Error('密码错误'); return { username: 'user' } },
  })
  flow.select('remote'); await flow.prepare()
  assert.match(flow.snapshot().error, /本机创建管理员/)
  assert.equal(flow.snapshot().phase, 'error')
  await flow.prepare()
  await flow.submit({ username: 'user', password: 'bad' })
  assert.equal(flow.snapshot().phase, 'ready'); assert.equal(flow.snapshot().error, '密码错误')
  await flow.submit({ username: 'user', password: 'good' })
  assert.equal(flow.snapshot().active, false)
})
test('valid remembered sessions skip credentials, but reauthorization requests a fresh login', async () => {
  const { flow, calls } = fixture({ inspect: async () => ({ authenticated: true, user: { username: 'user' } }) })
  flow.open({ mode: 'remote', serverURL: 'http://remote.test', remember: true })
  await flow.prepare({ autoEnter: true })
  assert.equal(flow.snapshot().active, false)
  flow.open({ mode: 'remote', serverURL: 'http://remote.test', forceLogin: true })
  await flow.prepare({ autoEnter: true })
  assert.equal(flow.snapshot().active, true); assert.equal(flow.snapshot().authenticated, false)
  assert.equal(calls.length, 2)
})
test('failed computer enrollment preserves login and offers inline continuation', async () => {
  const { flow, calls } = fixture({ inspect: async () => ({ authenticated: false }), authenticate: async () => ({ username: 'admin', warning: '电脑授权未恢复' }) })
  flow.select('remote'); await flow.prepare(); await flow.submit({ username: 'admin', password: 'password' })
  assert.equal(flow.snapshot().phase, 'ready'); assert.equal(flow.snapshot().authenticated, true)
  assert.match(flow.snapshot().error, /授权未恢复/); assert.deepEqual(calls, [])
  await flow.submit(); assert.equal(flow.snapshot().active, false)
})

test('registration stays anonymous and does not enter or enroll a computer', async () => {
  const calls = []
  const flow = new DesktopOnboarding({ remoteServer: () => 'http://127.0.0.1:15300', inspect: async () => ({ registrationAvailable: true }), register: async input => { calls.push(input) }, authenticate: async () => { throw new Error('must not log in') }, activate: async () => { throw new Error('must not activate') } })
  flow.select('remote'); await flow.prepare()
  const next = await flow.submit({ register: true, username: 'child', password: 'password', confirmation: 'password' })
  assert.equal(next.authenticated, false)
  assert.match(next.registrationNotice, /等待管理员开通/)
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(next).includes('password'), false)
  await flow.prepare({ serverURL: 'http://another-server.test' })
  assert.equal(flow.snapshot().registrationNotice, '', 'registration belongs to the checked server')
})
