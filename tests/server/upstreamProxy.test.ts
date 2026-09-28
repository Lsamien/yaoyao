// @vitest-environment node
import {expect,it} from 'vitest'
import {connect,createServer,type Server,type Socket} from 'node:net'
import {createServer as createHttpsServer} from 'node:https'
import {execFile,execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {proxySocket} from '../../src/runner/network/upstreamProxy'
import type {VmProxySettings} from '../../src/shared/executionEnvironment'
const listen=async(server:Server)=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return (server.address() as {port:number}).port}
it('authenticates HTTP CONNECT, pins the destination and preserves bytes received with the header',async()=>{
  let header='';const server=createServer(socket=>socket.once('data',data=>{header=data.toString();socket.write('HTTP/1.1 200 Connection Established\r\n\r\nfirst-byte')}))
  const port=await listen(server)
  try{const socket=await proxySocket({enabled:true,protocol:'http',host:'127.0.0.1',port,username:'user',password:'password',revision:1},'1.1.1.1',443)
    const data=await new Promise<string>(r=>{socket.once('data',d=>r(d.toString()));socket.resume()})
    expect(data).toBe('first-byte');expect(header).toContain('CONNECT 1.1.1.1:443');expect(header).toContain(Buffer.from('user:password').toString('base64'));socket.destroy()
  }finally{await new Promise<void>(r=>server.close(()=>r()))}
})
it('fails closed when the proxy refuses authentication',async()=>{
  const server=createServer(socket=>socket.once('data',()=>socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'))),port=await listen(server)
  try{await expect(proxySocket({enabled:true,protocol:'http',host:'127.0.0.1',port,username:'',revision:1},'1.1.1.1',443)).rejects.toThrow('代理连接或认证失败')}finally{await new Promise<void>(r=>server.close(()=>r()))}
})
it('handles authenticated SOCKS5 and never offers anonymous downgrade',async()=>{
  const frames:Buffer[]=[]
  const server=createServer(socket=>{let phase=0;socket.on('data',data=>{frames.push(data);if(phase++===0)socket.write(Buffer.from([5,2]));else if(phase===2)socket.write(Buffer.from([1,0]));else socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]))})}),port=await listen(server)
  try{const socket=await proxySocket({enabled:true,protocol:'socks5',host:'127.0.0.1',port,username:'u',password:'p',revision:1} satisfies VmProxySettings,'1.1.1.1',443);expect(frames[0]).toEqual(Buffer.from([5,1,2]));expect(frames[2]).toEqual(Buffer.from([5,1,0,1,1,1,1,1,1,187]));socket.destroy()}finally{await new Promise<void>(r=>server.close(()=>r()))}
})

it('resolves IPv4 and IPv6 through authenticated CONNECT with verified DNS-over-HTTPS',async()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-doh-')),key=join(home,'key.pem'),cert=join(home,'cert.pem'),config=join(home,'openssl.cnf')
  writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=dns.google\n[ext]\nsubjectAltName=DNS:dns.google\nbasicConstraints=critical,CA:TRUE\n')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-config',config],{stdio:'ignore'})
  const requests:string[]=[],headers:string[]=[],sockets=new Set<Socket>()
  const https=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
    requests.push(req.url!)
    const type=Number(new URL(req.url!,'https://dns.google').searchParams.get('type'))
    res.setHeader('content-type','application/json');res.end(JSON.stringify({Status:0,Answer:[{type,data:type===1?'93.184.216.34':'2606:4700:4700::1111'}]}))
  })
  const tlsPort=await listen(https)
  const proxy=createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket))
    let header=''
    const read=(chunk:Buffer)=>{
      header+=chunk.toString();if(!header.endsWith('\r\n\r\n'))return
      socket.off('data',read);headers.push(header)
      const target=connect(tlsPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(target);target.pipe(socket)})
      sockets.add(target);target.once('close',()=>sockets.delete(target));target.on('error',()=>socket.destroy());socket.once('close',()=>target.destroy())
    }
    socket.on('data',read)
  })
  try{
    const port=await listen(proxy)
    const settings={enabled:true,protocol:'http',host:'127.0.0.1',port,username:'fixture',password:'proxy-fixture',revision:1}
    const source=`import {proxyLookup} from ${JSON.stringify(new URL('../../src/runner/network/upstreamProxy.ts',import.meta.url).href)}; console.log(JSON.stringify(await proxyLookup(${JSON.stringify(settings)})('service.example.test')))`
    // Trust only this fixture certificate in a separate process; production TLS
    // verification and the parent test process's trust store remain unchanged.
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',source],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:15000})
    expect(JSON.parse(result.stdout)).toEqual([{address:'93.184.216.34',family:4},{address:'2606:4700:4700::1111',family:6}])
    expect(requests.sort()).toEqual(['/resolve?name=service.example.test&type=1','/resolve?name=service.example.test&type=28'])
    expect(headers).toHaveLength(2)
    for(const header of headers){expect(header).toContain('CONNECT 8.8.8.8:443');expect(header).toContain('Proxy-Authorization: Basic '+Buffer.from('fixture:proxy-fixture').toString('base64'))}
  }finally{for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>https.close(()=>r()))]);rmSync(home,{recursive:true,force:true})}
},20000)
