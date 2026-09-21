import { describe, expect, it, vi } from 'vitest'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'
import type { UpstreamRequestOptions } from '../../src/server/upstream.js'

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

it.each([
  {path:'/api/config', options:{search:new URLSearchParams({profile:'yaoer',token:'private-query'})}, stage:'Profile「yaoer」读取配置', seconds:30},
  {path:'/api/plugins/yaoyao-bot-bridge/capabilities', options:{search:new URLSearchParams({profile:'default'})}, stage:'Profile「default」检查工具桥', seconds:30},
  {path:'/api/plugins/yaoyao-bot-bridge/bind', options:{method:'POST',body:{profile:'yaoer',token:'private-bridge-token'}}, stage:'Profile「yaoer」绑定工具桥', seconds:60},
  {path:'/api/config', options:{search:new URLSearchParams({profile:'invalid\nprivate-value'})}, stage:'读取配置', seconds:30},
] satisfies Array<{path:string;options:UpstreamRequestOptions;stage:string;seconds:number}>)('identifies a timed-out $path without exposing request secrets',async({path,options,stage,seconds})=>{
  vi.useFakeTimers()
  const fetchImpl=vi.fn<typeof fetch>((_url,init)=>new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})
  }))
  const client=new UpstreamClient(new URL('http://127.0.0.1:9119'),fetchImpl)
  try{
    const failed=expect(client.request(path,new CookieJar(),options)).rejects.toMatchObject({
      code:'upstream_unavailable',message:`Hermes 请求超时（${seconds} 秒）：${stage}。`,
    })
    await vi.advanceTimersByTimeAsync(seconds*1000+1);await failed
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  }finally{client.close();vi.clearAllTimers();vi.useRealTimers()}
})

it.each([
  {path:'/api/config',options:{search:new URLSearchParams({profile:'yaoer'})},stage:'读取配置',seconds:30,headersDelay:0},
  {path:'/api/plugins/yaoyao-bot-bridge/bind',options:{method:'POST',body:{profile:'yaoer'}},stage:'绑定工具桥',seconds:60,headersDelay:0},
  {path:'/api/plugins/yaoyao-bot-bridge/bind',options:{method:'POST',body:{profile:'yaoer'}},stage:'绑定工具桥',seconds:60,headersDelay:40_000},
] satisfies Array<{path:string;options:UpstreamRequestOptions;stage:string;seconds:number;headersDelay:number}>)('identifies a stalled $path body within its deadline (headers after $headersDelay ms)',async({path,options,stage,seconds,headersDelay})=>{
  vi.useFakeTimers()
  const cancel=vi.fn(),stream=new ReadableStream({cancel})
  const client=new UpstreamClient(new URL('http://127.0.0.1:9119'),vi.fn<typeof fetch>(()=>new Promise(resolve=>setTimeout(()=>resolve(new Response(stream)),headersDelay))))
  try{
    const failed=expect(client.request(path,new CookieJar(),options)).rejects.toMatchObject({
      code:'upstream_unavailable',message:`Hermes 请求超时（${seconds} 秒）：Profile「yaoer」${stage}。`,
    })
    await vi.advanceTimersByTimeAsync(seconds*1000-1)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2);await failed
    expect(cancel).toHaveBeenCalledOnce()
  }finally{client.close();vi.clearAllTimers();vi.useRealTimers()}
})

it.each(['bind','memory-extract'])('allows a slow Hermes %s request without changing normal request deadlines',async endpoint=>{
  vi.useFakeTimers()
  const fetchImpl=vi.fn<typeof fetch>(()=>new Promise(done=>setTimeout(()=>done(new Response('{"text":"memory"}')),40000)))
  const client=new UpstreamClient(new URL('http://127.0.0.1:9119'),fetchImpl)
  try{
    const normal=client.request('/api/status',new CookieJar()),rejected=expect(normal).rejects.toThrow('request timed out')
    await vi.advanceTimersByTimeAsync(30001);await rejected
    const memory=client.request(`/api/plugins/yaoyao-bot-bridge/${endpoint}`,new CookieJar(),{method:'POST',body:{profile:'default',prompt:'facts'}})
    await vi.advanceTimersByTimeAsync(40001)
    expect(JSON.parse((await memory).body.toString())).toEqual({text:'memory'})
  }finally{client.close();vi.clearAllTimers();vi.useRealTimers()}
})
