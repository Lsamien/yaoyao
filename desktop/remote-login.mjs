/** Native remote login: username/password against a yaoyao Web server.
 *  Mirrors the browser's CSRF/Origin dance so no server changes are needed,
 *  and can enroll this Mac as a computer with the logged-in session. */

export function normalizeServerURL(input){
  const raw=String(input??'').trim()
  if(!raw)throw new Error('请填写夭夭服务器地址')
  const withScheme=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)?raw:`http://${raw}`
  let url
  try{url=new URL(withScheme)}catch{throw new Error('服务器地址无效')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.pathname!==''&&url.pathname!=='/'))throw new Error('服务器地址无效')
  return url.origin
}

/** Minimal cookie jar across the bootstrap → login dance. */
class CookieJar{
  constructor(){this.cookies=new Map()}
  absorb(response){
    for(const line of response.headers.getSetCookie?.()??[]){
      const pair=line.split(';')[0],eq=pair.indexOf('=')
      if(eq>0)this.cookies.set(pair.slice(0,eq).trim(),pair.slice(eq+1).trim())
    }
  }
  header(){return [...this.cookies.entries()].map(([name,value])=>`${name}=${value}`).join('; ')}
}

export async function remoteSession(serverURL,{username,password},fetchImpl=globalThis.fetch){
  const base=normalizeServerURL(serverURL)
  const user=String(username??'').trim(),pass=String(password??'')
  if(!user||!pass)throw new Error('请填写用户名和密码')
  const jar=new CookieJar()
  const bootstrap=await fetchImpl(new URL('/api/app/bootstrap',base),{headers:{accept:'application/json'},redirect:'error'})
  jar.absorb(bootstrap)
  if(!bootstrap.ok)throw new Error(`无法连接服务器（HTTP ${bootstrap.status}）`)
  const info=await bootstrap.json().catch(()=>{throw new Error('服务器响应无效，请确认这是夭夭 Web 地址')})
  if(typeof info?.csrfToken!=='string')throw new Error('服务器响应无效，请确认这是夭夭 Web 地址')
  const response=await fetchImpl(new URL('/api/app/login',base),{
    method:'POST',redirect:'error',
    headers:{accept:'application/json','content-type':'application/json',cookie:jar.header(),'x-csrf-token':info.csrfToken,origin:base},
    body:JSON.stringify({username:user,password:pass}),
  })
  jar.absorb(response)
  if(response.status===401||response.status===403)throw new Error('用户名或密码不正确')
  if(!response.ok)throw new Error(`登录失败（HTTP ${response.status}）`)
  const result=await response.json().catch(()=>{throw new Error('登录响应无效')})
  if(!result?.user?.id)throw new Error('登录响应无效')
  return {origin:base,user:result.user,csrfToken:String(result.csrfToken??info.csrfToken),cookies:[...jar.cookies.entries()]}
}

export async function enrollDesktopHost(session,{name,installId,previousHostId},fetchImpl=globalThis.fetch){
  const cookie=session.cookies.map(([key,value])=>`${key}=${value}`).join('; ')
  const response=await fetchImpl(new URL('/api/app/admin/desktop-hosts',session.origin),{
    method:'POST',redirect:'error',
    headers:{accept:'application/json','content-type':'application/json',cookie,'x-csrf-token':session.csrfToken,origin:session.origin},
    body:JSON.stringify({name:String(name).slice(0,100),...(installId?{installId}:{}),...(previousHostId?{previousHostId}:{})}),
  })
  if(response.status===403)throw new Error('需要管理员账号，才能把这台 Mac 注册为可远程控制的电脑')
  if(!response.ok)throw new Error(`注册电脑失败（HTTP ${response.status}）`)
  const result=await response.json()
  if(typeof result?.token!=='string'||!result?.host?.id)throw new Error('注册电脑响应无效')
  return result
}
