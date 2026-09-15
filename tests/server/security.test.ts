import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import { loadServerConfig, type ServerConfig } from '../../src/server/config.js'
import {
  CsrfProtection,
  isAllowedHostHeader,
  isExactOrigin,
  applySecurityHeaders,
} from '../../src/server/security.js'

const configHomes: string[] = []

afterEach(() => {
  for (const home of configHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-security-config-'))
  configHomes.push(home)
  return { HERMES_YAOYAO_HOME: home, ...overrides }
}

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 15300,
    upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(),
    home: '/tmp/hermes-yaoyao-test',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
    ...overrides,
  }
}

describe('server security boundary', () => {
  it('accepts loopback/private hosts and configured DNS only', () => {
    const value = config({ allowedHosts: new Set(['yaoyao.internal']) })
    expect(isAllowedHostHeader('127.0.0.1:15300', value)).toBe(true)
    expect(isAllowedHostHeader('[::1]:15300', value)).toBe(true)
    expect(isAllowedHostHeader('192.168.10.8:15300', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao.internal:15300', value)).toBe(true)
    expect(isAllowedHostHeader('127.0.0.1:9999', value)).toBe(false)
    expect(isAllowedHostHeader('127.0.0.1', value)).toBe(true)
    expect(isAllowedHostHeader('192.168.10.8:443', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao.internal', value)).toBe(true)
    expect(isAllowedHostHeader('attacker.example:15300', value)).toBe(false)
    expect(isAllowedHostHeader('127.0.0.1@attacker.example', value)).toBe(false)
  })

  it('accepts the configured production reverse-proxy domain on public ports', () => {
    const value = config({ allowedHosts: new Set(['yaoyao-lc.samien.cn']) })
    expect(isAllowedHostHeader('yaoyao-lc.samien.cn', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao-lc.samien.cn:443', value)).toBe(true)
    expect(isAllowedHostHeader('other.samien.cn', value)).toBe(false)
  })

  it('accepts an HTTPS browser Origin behind an HTTP TLS-terminating proxy', () => {
    expect(isExactOrigin('https://yaoyao.internal', 'yaoyao.internal', false)).toBe(true)
    expect(isExactOrigin('https://attacker.example', 'yaoyao.internal', false)).toBe(false)
  })

  it('accepts a configured public Origin when the reverse proxy rewrites Host internally', () => {
    const allowed = new Set(['yaoyao-lc.samien.cn'])
    expect(isExactOrigin('http://yaoyao-lc.samien.cn', '10.1.5.100', false, allowed)).toBe(true)
    expect(isExactOrigin('http://attacker.example', '10.1.5.100', false, allowed)).toBe(false)
  })

  it('adds configured reverse-proxy domains to the WebSocket CSP', () => {
    const headers: Record<string, string> = {}
    const ctx = { host: '10.1.5.100', set(name: string, value: string) { headers[name] = value } } as unknown as Koa.Context
    applySecurityHeaders(ctx, false, new Set(['yaoyao-lc.samien.cn']))
    expect(headers['Content-Security-Policy']).toContain('ws://yaoyao-lc.samien.cn')
    expect(headers['Content-Security-Policy']).toContain('wss://yaoyao-lc.samien.cn')
  })

  it('accepts configured IPv6 addresses and brackets them in WebSocket CSP origins', () => {
    const allowed = new Set(['2001:db8::10'])
    expect(isAllowedHostHeader('[2001:db8::10]:15300', config({ allowedHosts: allowed }))).toBe(true)
    expect(isExactOrigin('https://[2001:db8::10]', '10.1.5.100', false, allowed)).toBe(true)
    const headers: Record<string, string> = {}
    const ctx = { host: '10.1.5.100', set(name: string, value: string) { headers[name] = value } } as unknown as Koa.Context
    applySecurityHeaders(ctx, false, allowed)
    expect(headers['Content-Security-Policy']).toContain('ws://[2001:db8::10]')
    expect(headers['Content-Security-Policy']).toContain('wss://[2001:db8::10]')
  })

  it('requires an exact scheme and host Origin', () => {
    expect(isExactOrigin('http://127.0.0.1:15300', '127.0.0.1:15300', false)).toBe(true)
    expect(isExactOrigin('https://127.0.0.1:15300', '127.0.0.1:15300', false)).toBe(true)
    expect(isExactOrigin('http://127.0.0.1:8801', '127.0.0.1:15300', false)).toBe(false)
    expect(isExactOrigin('null', '127.0.0.1:15300', false)).toBe(false)
  })

  it('uses a signed double-submit CSRF token', () => {
    const csrf = new CsrfProtection(randomBytes(32), false)
    const headers: Record<string, unknown> = {}
    let incomingCookie = ''
    const ctx = {
      response: { headers },
      set(name: string, value: unknown) { headers[name.toLowerCase()] = value },
      get(name: string) { return name.toLowerCase() === 'cookie' ? incomingCookie : '' },
    } as unknown as Koa.Context
    const token = csrf.issue(ctx)
    const setCookie = (headers['set-cookie'] as string[])[0]!
    const cookie = setCookie.split(';', 1)[0]!
    incomingCookie = cookie
    expect(csrf.verify(cookie, token)).toBe(true)
    expect(csrf.issue(ctx)).toBe(token)
    expect(csrf.issue(ctx, true)).not.toBe(token)
    expect(csrf.verify(cookie, `${token}x`)).toBe(false)
    expect(csrf.verify(cookie.replace(/.$/, 'x'), token)).toBe(false)
  })

  it('refuses production LAN HTTP unless explicitly enabled', () => {
    expect(() => loadServerConfig(isolatedEnv({
      NODE_ENV: 'production',
      HERMES_YAOYAO_HOST: '0.0.0.0',
    }))).toThrow(/ALLOW_INSECURE_LAN/)
    expect(loadServerConfig(isolatedEnv({
      NODE_ENV: 'production',
      HERMES_YAOYAO_HOST: '0.0.0.0',
      HERMES_YAOYAO_ALLOW_INSECURE_LAN: '1',
    })).insecureLan).toBe(true)
  })

  it('defaults the YaoYao Web listener to loopback', () => {
    const value = loadServerConfig(isolatedEnv())
    expect(value.host).toBe('127.0.0.1')
    expect(value.insecureLan).toBe(false)
    expect(value).not.toHaveProperty('yaoyaoPluginSource')
    expect(value.releaseSource).toBe('https://github.com/Lsamien/yaoyao.git')
    expect(value.allowRemoteUpdate).toBe(false)
  })

  it('requires a credential-free HTTPS or SSH system release source', () => {
    expect(() => loadServerConfig(isolatedEnv({
      HERMES_YAOYAO_RELEASE_SOURCE: 'http://git.example/hermes-yaoyao.git',
    }))).toThrow(/HTTPS or SSH/)
    expect(() => loadServerConfig(isolatedEnv({
      HERMES_YAOYAO_RELEASE_SOURCE: 'https://user:secret@git.example/hermes-yaoyao.git',
    }))).toThrow(/must not contain credentials/)
    expect(() => loadServerConfig(isolatedEnv({
      HERMES_YAOYAO_RELEASE_SOURCE: 'ssh://git:secret@git.example/hermes-yaoyao.git',
    }))).toThrow(/must not contain credentials/)
    expect(loadServerConfig(isolatedEnv({ HERMES_YAOYAO_RELEASE_SOURCE: 'ssh://git@git.example/hermes-yaoyao.git' })).releaseSource)
      .toBe('ssh://git@git.example/hermes-yaoyao.git')
  })
})

it('requires explicit mounted-Hermes opt-in and container-absolute installation paths',()=>{
  const base={HERMES_YAOYAO_LOCAL_VM_HOST:'runner',HERMES_YAOYAO_UPSTREAM:'http://hermes:9119'}
  expect(loadServerConfig(isolatedEnv({...base,HERMES_YAOYAO_BRIDGE_HOME:'/hermes'})).hermesBridgeMount).toBeUndefined()
  const mapped=loadServerConfig(isolatedEnv({...base,HERMES_YAOYAO_BRIDGE_MOUNTED:'1',HERMES_YAOYAO_BRIDGE_HOME:'/hermes'}))
  expect(mapped.hermesBridgeMount).toEqual({home:'/hermes',python:'/usr/bin/python3'})
  expect(mapped.localVmHost).toBe('runner');expect(mapped.superviseDashboard).toBe(false)
  for(const patch of [{HERMES_YAOYAO_BRIDGE_HOME:''},{HERMES_YAOYAO_BRIDGE_HOME:'relative'},{HERMES_YAOYAO_BRIDGE_HOME:'/hermes\nother'},{HERMES_YAOYAO_BRIDGE_PYTHON:'python3'}]){
    expect(()=>loadServerConfig(isolatedEnv({...base,HERMES_YAOYAO_BRIDGE_MOUNTED:'1',HERMES_YAOYAO_BRIDGE_HOME:'/hermes',...patch}))).toThrow()
  }
})
