import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,randomBytes} from 'node:crypto'
import {remoteSession,enrollDesktopHost,normalizeServerURL,inspectServer} from './remote-login.mjs'

test('server inspection requests local login metadata without binding Hermes', async () => {
  const calls = []
  const info = { authenticated: true, csrfToken: 'fixture', serverKind: 'yaoyao-web', user: { username: 'admin' } }
  const result = await inspectServer('http://127.0.0.1:15300', async (url, options) => {
    calls.push({ path: url.pathname + url.search, method: options.method ?? 'GET' })
    return Response.json(info)
  })
  assert.deepEqual(result, info)
  assert.deepEqual(calls, [{ path: '/api/app/bootstrap?inspectOnly=1', method: 'GET' }])
})

test('server addresses are normalized like browser URLs',()=>{
  assert.equal(normalizeServerURL('192.168.1.10:15300'),'http://192.168.1.10:15300')
  assert.equal(normalizeServerURL('http://192.168.1.10:15300/'),'http://192.168.1.10:15300')
  assert.equal(normalizeServerURL('https://yaoyao.example.com'),'https://yaoyao.example.com')
  assert.throws(()=>normalizeServerURL(''),/服务器地址/)
  assert.throws(()=>normalizeServerURL('https://user:pass@example.com'),/无效/)
  assert.throws(()=>normalizeServerURL('http://example.com/path'),/无效/)
  assert.throws(()=>normalizeServerURL('ftp://example.com'),/无效/)
})

async function fakeServer(){
  const csrf=randomUUID(),session=randomBytes(24).toString('base64url'),token=randomBytes(32).toString('base64url'),hostId=randomUUID()
  const requests=[]
  const server=createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const body=Buffer.concat(chunks).toString()
      requests.push({method:req.method,url:req.url,origin:req.headers.origin,csrf:req.headers['x-csrf-token'],cookie:req.headers.cookie??'',body})
      const json=payload=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(payload))}
      if(req.url==='/api/app/bootstrap'&&(req.method==='GET'||req.method==='HEAD')){res.setHeader('set-cookie','csrf=test-csrf; Path=/; HttpOnly');return json({authRequired:true,csrfToken:csrf})}
      if(req.url==='/api/app/login'&&req.method==='POST'){
        const credentials=JSON.parse(body||'{}')
        if(credentials.username!=='admin'||credentials.password!=='pass'){res.statusCode=401;return json({error:'invalid'})}
        if(req.headers['x-csrf-token']!==csrf||!String(req.headers.cookie).includes('csrf=')){res.statusCode=403;return json({error:'csrf'})}
        res.setHeader('set-cookie',[`session=${session}; Path=/; HttpOnly`,`csrf=${csrf}.sig; Path=/; HttpOnly`])
        return json({user:{id:randomUUID(),username:'admin',role:'admin'},csrfToken:csrf+'-rotated'})
      }
      if(req.url==='/api/app/admin/desktop-hosts'&&req.method==='POST'){
        if(req.headers['x-csrf-token']!==csrf+'-rotated'||!String(req.headers.cookie).includes(`session=${session}`)){res.statusCode=403;return json({error:'session'})}
        return json({host:{id:hostId,name:JSON.parse(body||'{}').name,enabled:true},token})
      }
      res.statusCode=404;json({error:'not found'})
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  return {server,url:`http://127.0.0.1:${server.address().port}`,requests,csrf,session,token,hostId}
}

test('logs in with username and password and enrolls this Mac as a computer',async()=>{
  const fake=await fakeServer()
  try{
    const auth=await remoteSession(fake.url,{username:'admin',password:'pass'})
    assert.equal(auth.user.role,'admin')
    assert.equal(auth.origin,fake.url)
    assert.ok(auth.cookies.some(([name])=>name==='session'))
    const installId='22222222-2222-4222-8222-222222222222',previousHostId='33333333-3333-4333-8333-333333333333'
    const enrollment=await enrollDesktopHost(auth,{name:'书房 iMac',installId,previousHostId})
    assert.equal(enrollment.host.id,fake.hostId)
    assert.equal(enrollment.token,fake.token)
    const [bootstrap,login,enroll]=fake.requests
    assert.equal(bootstrap.url,'/api/app/bootstrap')
    assert.equal(login.origin,fake.url)
    assert.equal(login.csrf,fake.csrf)
    assert.equal(enroll.csrf,fake.csrf+'-rotated')
    assert.ok(enroll.cookie.includes(`session=${fake.session}`))
    assert.deepEqual(JSON.parse(enroll.body),{name:'书房 iMac',installId,previousHostId})
  }finally{
    fake.server.close();fake.server.closeAllConnections?.()
  }
})

test('wrong credentials and non-admin accounts surface clear errors',async()=>{
  const fake=await fakeServer()
  try{
    await assert.rejects(()=>remoteSession(fake.url,{username:'admin',password:'wrong'}),/用户名或密码不正确/)
    await assert.rejects(()=>remoteSession(fake.url,{username:'',password:'pass'}),/用户名和密码/)
    const auth={origin:fake.url,csrfToken:'stale',cookies:[['session','x']]}
    await assert.rejects(()=>enrollDesktopHost(auth,{name:'x'}),/管理员账号|注册电脑失败/)
  }finally{
    fake.server.close();fake.server.closeAllConnections?.()
  }
})

test('native login preserves cookie expiry, scope and same-site policy', async () => {
  let request = 0
  const before = Date.now() / 1000
  const auth = await remoteSession('https://server.test', { username: 'admin', password: 'password' }, async () => {
    if (++request === 1) return new Response(JSON.stringify({ csrfToken: 'fixture' }), { headers: { 'set-cookie': 'csrf=one; Path=/; HttpOnly; Secure; SameSite=Strict' } })
    return new Response(JSON.stringify({ user: { id: 'admin', role: 'admin' } }), { headers: { 'set-cookie': 'session=two; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict' } })
  })
  const session = auth.cookieDetails.find(cookie => cookie.name === 'session')
  assert.equal(session.secure, true); assert.equal(session.httpOnly, true); assert.equal(session.sameSite, 'strict')
  assert.equal(session.path, '/')
  assert.ok(session.expirationDate >= before + 3600 && session.expirationDate <= Date.now() / 1000 + 3600)
  assert.equal(auth.cookieDetails.find(cookie => cookie.name === 'csrf').expirationDate, undefined)
})

test('pending approval is not mislabeled as a bad password', async () => {
  let calls = 0
  await assert.rejects(() => remoteSession('https://server.test', { username: 'child', password: 'password' }, async () => {
    if (++calls === 1) return Response.json({ csrfToken: 'csrf' })
    return Response.json({ code: 'account_pending_approval', error: '账号尚未开通，请等待管理员开通。' }, { status: 403 })
  }), /等待管理员开通/)
})

test('registration uses only anonymous bootstrap and does not return a session', async () => {
  const { remoteRegistration } = await import('./remote-login.mjs')
  const calls = []
  await remoteRegistration('https://server.test', { username: ' child ', password: 'password' }, async (url, options) => {
    calls.push(url.pathname)
    if (url.pathname.endsWith('bootstrap')) return Response.json({ registrationAvailable: true, csrfToken: 'csrf' }, { headers: { 'set-cookie': 'csrf-cookie=value; Path=/; HttpOnly' } })
    assert.equal(options.headers.origin, 'https://server.test')
    assert.equal(options.headers['x-csrf-token'], 'csrf')
    assert.match(options.headers.cookie, /csrf-cookie=value/)
    assert.deepEqual(JSON.parse(options.body), { username: 'child', password: 'password' })
    return Response.json({ registrationStatus: 'pending' }, { status: 201 })
  })
  assert.deepEqual(calls, ['/api/app/bootstrap', '/api/app/register'])
})
