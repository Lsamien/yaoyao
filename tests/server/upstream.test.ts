import { describe, expect, it, vi } from 'vitest'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'

describe('upstream request boundary', () => {
  it('rejects a path that URL normalization would escape', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetchImpl)
    await expect(client.request('/api/sessions/..', new CookieJar())).rejects.toThrow(/normalization/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('derives proxy scheme from public 15300 TLS and forwards only the trusted peer IP', async () => {
    let headers = new Headers()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=test; Path=/; HttpOnly; SameSite=Lax' },
      })
    })
    const jar = new CookieJar()
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetchImpl, true)
    await client.request('/api/status', jar, { clientAddress: '::ffff:192.168.1.22' })
    expect(headers.get('x-forwarded-proto')).toBe('https')
    expect(headers.get('x-forwarded-for')).toBe('192.168.1.22')
    expect(jar.browserCookies[0]).toContain('Secure')
    expect(jar.browserCookies[0]).not.toMatch(/Domain=/i)
  })
})

it('allows the Hermes memory helper to finish within its 90-second budget without changing normal request deadlines',async()=>{
  vi.useFakeTimers()
  const fetchImpl=vi.fn<typeof fetch>(()=>new Promise(done=>setTimeout(()=>done(new Response('{"text":"memory"}')),40000)))
  const client=new UpstreamClient(new URL('http://127.0.0.1:9119'),fetchImpl)
  try{
    const normal=client.request('/api/status',new CookieJar()),rejected=expect(normal).rejects.toThrow('request timed out')
    await vi.advanceTimersByTimeAsync(30001);await rejected
    const memory=client.request('/api/plugins/yaoyao-bot-bridge/memory-extract',new CookieJar(),{method:'POST',body:{profile:'default',prompt:'facts'}})
    await vi.advanceTimersByTimeAsync(40001)
    expect(JSON.parse((await memory).body.toString())).toEqual({text:'memory'})
  }finally{client.close();vi.clearAllTimers();vi.useRealTimers()}
})
