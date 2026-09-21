import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,randomBytes} from 'node:crypto'
import {remoteSession,enrollDesktopHost,normalizeServerURL} from './remote-login.mjs'

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
