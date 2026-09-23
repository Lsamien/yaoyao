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

async function requestServer(fetchImpl,url,options){
  try{return await fetchImpl(url,options)}
  catch(error){
    if(['TimeoutError','AbortError'].includes(error.name))throw new Error('连接超时，请检查服务器地址和网络后重试。')
    throw new Error('无法连接服务器，请检查服务器地址和网络后重试。')
  }
}

/** Minimal cookie jar across the bootstrap → login dance. */
class CookieJar{
  constructor(){this.cookies=new Map();this.details=new Map()}
  absorb(response){
    for(const line of response.headers.getSetCookie?.()??[]){
      const pair=line.split(';')[0],eq=pair.indexOf('=')
      if(eq<=0)continue
      const name=pair.slice(0,eq).trim(),value=pair.slice(eq+1).trim()
      this.cookies.set(name,value)
      const attributes=new Map(line.split(';').slice(1).map(part=>{
        const index=part.indexOf('=')
        return index<0?[part.trim().toLowerCase(),'']:[part.slice(0,index).trim().toLowerCase(),part.slice(index+1).trim()]
      }))
      const detail={name,value,path:attributes.get('path')||'/',httpOnly:attributes.has('httponly'),secure:attributes.has('secure')}
      const sameSite={strict:'strict',lax:'lax',none:'no_restriction'}[attributes.get('samesite')?.toLowerCase()]
      if(sameSite)detail.sameSite=sameSite
      const maxAge=attributes.get('max-age'),expires=Date.parse(attributes.get('expires'))
      if(maxAge!==undefined&&/^-?\d+$/.test(maxAge))detail.expirationDate=Date.now()/1000+Number(maxAge)
      else if(Number.isFinite(expires))detail.expirationDate=expires/1000
      this.details.set(name,detail)
    }
  }
  header(){return [...this.cookies.entries()].map(([name,value])=>`${name}=${value}`).join('; ')}
}

export async function inspectServer(serverURL,fetchImpl=globalThis.fetch){
  const base=normalizeServerURL(serverURL)
  const response=await requestServer(fetchImpl,new URL('/api/app/bootstrap?inspectOnly=1',base),{
    headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000),
  })
  if(!response.ok)throw new Error(`无法连接服务器（HTTP ${response.status}）`)
  const info=await response.json().catch(()=>{throw new Error('服务器响应无效，请确认这是夭夭服务器地址')})
  if(typeof info?.csrfToken!=='string'||typeof info?.authenticated!=='boolean'||(info.serverKind&&info.serverKind!=='yaoyao-web'))
    throw new Error('服务器响应无效，请确认这是夭夭服务器地址')
  return info
}

export async function remoteSession(serverURL,{username,password,setup=false},fetchImpl=globalThis.fetch){
  const base=normalizeServerURL(serverURL)
  const user=String(username??'').trim(),pass=String(password??'')
  if(!user||!pass)throw new Error('请填写用户名和密码')
  const jar=new CookieJar()
  const bootstrap=await requestServer(fetchImpl,new URL('/api/app/bootstrap',base),{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)})
  jar.absorb(bootstrap)
  if(!bootstrap.ok)throw new Error(`无法连接服务器（HTTP ${bootstrap.status}）`)
  const info=await bootstrap.json().catch(()=>{throw new Error('服务器响应无效，请确认这是夭夭 Web 地址')})
  if(typeof info?.csrfToken!=='string')throw new Error('服务器响应无效，请确认这是夭夭 Web 地址')
  const response=await requestServer(fetchImpl,new URL(setup?'/api/app/setup':'/api/app/login',base),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{accept:'application/json','content-type':'application/json',cookie:jar.header(),'x-csrf-token':info.csrfToken,origin:base},
    body:JSON.stringify({username:user,password:pass}),
  })
  jar.absorb(response)
  if(!setup&&(response.status===401||response.status===403)) {
    const body=await response.json().catch(()=>({}))
    if(body.code==='account_pending_approval')throw new Error(body.error || '账号尚未开通，请等待管理员开通。')
    throw new Error('用户名或密码不正确')
  }
  if(setup&&!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error?.message||body.error||`创建管理员失败（HTTP ${response.status}）`)}
  if(!response.ok)throw new Error(`登录失败（HTTP ${response.status}）`)
  const result=await response.json().catch(()=>{throw new Error('登录响应无效')})
  if(!result?.user?.id)throw new Error('登录响应无效')
  return {origin:base,user:result.user,csrfToken:String(result.csrfToken??info.csrfToken),cookies:[...jar.cookies.entries()],cookieDetails:[...jar.details.values()]}
}

export async function enrollDesktopHost(session,{name,installId,previousHostId},fetchImpl=globalThis.fetch){
  const cookie=session.cookies.map(([key,value])=>`${key}=${value}`).join('; ')
  const response=await requestServer(fetchImpl,new URL('/api/app/admin/desktop-hosts',session.origin),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{accept:'application/json','content-type':'application/json',cookie,'x-csrf-token':session.csrfToken,origin:session.origin},
    body:JSON.stringify({name:String(name).slice(0,100),...(installId?{installId}:{}),...(previousHostId?{previousHostId}:{})}),
  })
  if(response.status===403)throw new Error('需要管理员账号，才能把这台电脑注册为可远程控制的电脑')
  if(!response.ok)throw new Error(`注册电脑失败（HTTP ${response.status}）`)
  const result=await response.json()
  if(typeof result?.token!=='string'||!result?.host?.id)throw new Error('注册电脑响应无效')
  return result
}

/** Registration owns a temporary cookie jar and never activates a desktop session. */
export async function remoteRegistration(serverURL,{username,password},fetchImpl=globalThis.fetch){
  const base=normalizeServerURL(serverURL),jar=new CookieJar()
  const bootstrap=await requestServer(fetchImpl,new URL('/api/app/bootstrap',base),{redirect:'error',signal:AbortSignal.timeout(10000)})
  jar.absorb(bootstrap)
  const info=await bootstrap.json().catch(()=>({}))
  if(!bootstrap.ok||info.registrationAvailable!==true||info.setupRequired||typeof info.csrfToken!=='string')throw new Error('当前服务器尚不支持子账号注册，请联系管理员初始化或升级。')
  const response=await requestServer(fetchImpl,new URL('/api/app/register',base),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json',cookie:jar.header(),'x-csrf-token':info.csrfToken,origin:base},
    body:JSON.stringify({username:String(username).trim(),password}),
  })
  const result=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(result.error || `注册失败（HTTP ${response.status}）`)
  if(result.registrationStatus!=='pending')throw new Error('注册响应无效，请联系管理员确认账号状态。')
}
