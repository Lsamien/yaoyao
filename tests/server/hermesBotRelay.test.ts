// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { hermesBotRelay } from '../../src/server/hermesBotRelay'

const id = '11111111-1111-4111-8111-111111111111'
function fixture(path: string, method = 'GET', body?: object) {
  const calls: {url: URL; options: RequestInit}[] = []
  const node = { id, transport: 'paired-web', secret: 'sealed' }
  const nodes: any = {
    store: { require: (owner: string) => { if(owner !== 'owner') throw new Error('forbidden'); return node }, get: () => node },
    target: vi.fn((owner: string) => {
      if (owner !== 'owner') throw new Error('forbidden')
      return {url: new URL('http://child:15300/node/'+id), pairedToken:'child-secret', client: {
        fetchImpl: async (url: URL, options: RequestInit) => {
          calls.push({url, options})
          return Response.json(path.endsWith('capabilities') ? {protocolVersion:1, csrfToken:'child-csrf'} : {state:'confirmed'})
        },
      }}
    }),
  }
  const auth: any = {require: () => ({id:'owner'}), isUserActive: () => true}
  const ctx: any = {path: '/api/app/hermes-bot/nodes/'+id+path, method, search:'',
    req: Readable.from(body ? [JSON.stringify(body)] : []), res: new EventEmitter(),
    get: (name: string) => ({'idempotency-key':'command-one','last-event-id':'cursor-one'}[name] || ''),
    is: () => true, set: vi.fn(),
  }
  return {nodes,auth,ctx,calls,run:()=>hermesBotRelay(nodes,auth,{issue:()=> 'primary-csrf'} as any)(ctx,async()=>{})}
}
describe('native Hermes Bot primary relay', () => {
  it('keeps the primary CSRF identity and relays only to paired child 15300', async () => {
    const t=fixture('/api/realtime/capabilities'); await t.run()
    expect(t.ctx.body.csrfToken).toBe('primary-csrf')
    expect(t.calls[0]!.url.port).toBe('15300')
    expect(t.calls[0]!.url.pathname).toBe('/node/'+id+'/api/realtime/capabilities')
    expect(t.calls[0]!.options.headers).toMatchObject({Authorization:'Bearer child-secret'})
    expect(JSON.stringify(t.ctx.body)).not.toContain('child-secret')
  })
  it('uses the native child entry only for explicit native chat routes', async () => {
    const t=fixture('/api/realtime/capabilities')
    t.ctx.path=t.ctx.path.replace('/api/realtime','/native/api/realtime')
    await t.run()
    expect(t.calls[0]!.url.pathname).toBe('/node/'+id+'/api/hermes-bot/api/realtime/capabilities')
  })
  it('preserves receipt identity for prompt submission and forbids redirects', async () => {
    const frame={method:'prompt.submit',params:{text:'hello'}}
    const t=fixture('/api/realtime/channels/'+id+'/commands','POST',frame); await t.run()
    expect(t.calls[0]!.options.redirect).toBe('error')
    expect(t.calls[0]!.options.headers).toMatchObject({'Idempotency-Key':'command-one'})
    expect(JSON.parse(Buffer.from(t.calls[0]!.options.body as Uint8Array).toString())).toEqual(frame)
  })
  it('rejects another primary account and non-paired legacy nodes before contacting upstream', async () => {
    const t=fixture('/api/profiles'); t.auth.require=()=>({id:'other'})
    await expect(t.run()).rejects.toThrow('forbidden'); expect(t.calls).toHaveLength(0)
    t.auth.require=()=>({id:'owner'}); t.nodes.store.require=()=>({transport:'legacy'})
    await expect(t.run()).rejects.toThrow('15300'); expect(t.calls).toHaveLength(0)
  })
  it.each(['/api/app/agents','/api/auth/login','/api/profiles/new'])('refuses unrelated or configuration route %s', async path => {
    const t=fixture(path,'POST',{}); await expect(t.run()).rejects.toThrow('不支持'); expect(t.calls).toHaveLength(0)
  })
})
