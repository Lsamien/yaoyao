// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest'
import {request} from 'node:http'
import {connect} from 'node:net'
import {BrowserPublicProxy,publicBrowserURL} from '../../src/runner/browser/publicProxy.js'
const proxies:BrowserPublicProxy[]=[]
async function fixture(){const authorize=vi.fn(async()=>{}),resolve=vi.fn(async()=>[{address:'10.2.3.4',family:4}]);const proxy=await BrowserPublicProxy.start(authorize,resolve);proxies.push(proxy);return {proxy,authorize,resolve}}
function get(proxy:BrowserPublicProxy,target:string,authenticated=true){return new Promise<number>((resolve,reject)=>{const req=request(proxy.serverURL,{path:target,headers:authenticated?{'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}:{}} ,res=>{res.resume();res.on('end',()=>resolve(res.statusCode!))});req.on('error',reject);req.end()})}
afterEach(async()=>{await Promise.all(proxies.splice(0).map(proxy=>proxy.close()))})
describe('browser public network boundary',()=>{
  it('requires private credentials before resolving a destination',async()=>{
    const f=await fixture();expect(await get(f.proxy,'http://example.com/',false)).toBe(407);expect(f.resolve).not.toHaveBeenCalled();expect(f.authorize).not.toHaveBeenCalled()
  })
  it('rejects private IPs and public-looking names resolving to private destinations',async()=>{
    const f=await fixture()
    expect(await get(f.proxy,'http://127.0.0.1/')).toBe(403)
    expect(await get(f.proxy,'http://example.com/')).toBe(403)
    expect(f.resolve).toHaveBeenCalledWith('example.com')
  })
  it('rejects HTTPS tunnels to local destinations',async()=>{
    const f=await fixture(),url=new URL(f.proxy.serverURL)
    const output=await new Promise<string>((resolve,reject)=>{
      const socket=connect(Number(url.port),url.hostname,()=>socket.write(`CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\nProxy-Authorization: Basic ${Buffer.from(`${f.proxy.username}:${f.proxy.password}`).toString('base64')}\r\n\r\n`))
      let text='';socket.on('data',chunk=>text+=chunk);socket.on('end',()=>resolve(text));socket.on('error',reject)
    })
    expect(output).toContain('403 Forbidden')
  })
  it('rejects non-web protocols, credential URLs and non-web ports',()=>{
    for(const value of ['file:///etc/passwd','ftp://example.com/','http://name:secret@example.com/','http://example.com:9222/'])expect(()=>publicBrowserURL(value)).toThrow()
    expect(publicBrowserURL('https://example.com/path').hostname).toBe('example.com')
  })
})
