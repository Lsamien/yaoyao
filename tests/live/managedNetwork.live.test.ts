// @vitest-environment node
import {expect,it} from 'vitest'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {createServer} from 'node:net'
import {randomUUID} from 'node:crypto'
import {ManagedProxy} from '../../src/runner/network/managedProxy'
import {ContainerComputerProvider} from '../../src/runner/computers/container'
import {ComposeComputerProvider} from '../../src/runner/computers/compose'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const exec=promisify(execFile)
const enabled=process.env.HERMES_YAOYAO_LIVE_TEST==='1'
it.skipIf(!enabled).each(['pipe','compose'] as const)('routes all programs through %s transport and cannot connect directly after proxy failure',async transport=>{
  const desktopId=randomUUID(),name='yaoyao-network-test-'+desktopId,connections:string[]=[]
  let reject=false,proxy:ManagedProxy|undefined
  const upstream=createServer(socket=>{
    let buffer='',connected=false
    socket.on('data',chunk=>{buffer+=chunk.toString();if(!buffer.includes('\r\n\r\n'))return
      if(!connected){connections.push(buffer.split('\r\n')[0]!);buffer='';if(reject){socket.end('HTTP/1.1 503 Unavailable\r\n\r\n');return}connected=true;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')}
      else{socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nthrough-proxy');buffer=''}
    })
  })
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r))
  const port=(upstream.address() as {port:number}).port
  const guest=(code:string)=>exec('docker',['run','--rm','--network','container:'+name,'--cap-drop','ALL','--entrypoint','python3','localhost/yaoyao/network:1','-c',code],{timeout:15000})
  const request="import socket; s=socket.create_connection(('1.1.1.1',80),5); s.settimeout(5); s.sendall(b'GET / HTTP/1.1\\r\\nHost: fixture\\r\\n\\r\\n'); print(s.recv(4096).decode())"
  try{
    await exec('docker',['run','-d','--name',name,'--network','none','--dns','198.18.0.1','--cap-drop','ALL','--cap-add','NET_ADMIN','--device','/dev/net/tun','--env','YAOYAO_COMPOSE_DESKTOP_ID='+desktopId,'localhost/yaoyao/network:1','--init',...(transport==='compose'?['--socket']:[])])
    await exec('docker',['exec',name,'sh','-c','i=0; until ip link show tun0 >/dev/null 2>&1; do i=$((i+1)); test "$i" -lt 50 || exit 1; sleep .1; done'])
    const relay=async(_id:string,operation:string,body:Record<string,unknown>)=>{
      const code="import socket,http.client,json,sys\np=json.load(sys.stdin)\nc=http.client.HTTPConnection('localhost',timeout=5)\ns=socket.socket(socket.AF_UNIX);s.connect('/run/yaoyao-network/gateway.sock');c.sock=s\nc.request('POST','/'+p['operation'],body=json.dumps(p['body']),headers={'Content-Type':'application/json'})\nr=c.getresponse();data=r.read();assert r.status==200,data;print(data.decode())"
      return await new Promise<any>((resolve,reject)=>{const child=spawn('docker',['exec','-i',name,'python3','-c',code],{stdio:'pipe'});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',status=>{try{if(status)throw new Error(err);resolve(JSON.parse(out))}catch(error){reject(error)}});child.stdin.end(JSON.stringify({operation,body:{...body,desktopId}}))})
    }
    if(transport==='compose')await exec('docker',['exec',name,'sh','-c','i=0; until test -S /run/yaoyao-network/gateway.sock; do i=$((i+1)); test "$i" -lt 50 || exit 1; sleep .1; done'])
    const provider=transport==='compose'?new ComposeComputerProvider(randomUUID(),'/tmp',relay):{openNetworkPipe:async()=>spawn('docker',['exec','-i',name,'python3','/usr/local/libexec/yaoyao/network_gateway.py'],{stdio:'pipe'})} as any
    proxy=await ManagedProxy.start(provider,{id:randomUUID(),ownerKey:'fixture',imageId:'sha256:'+'a'.repeat(64)}, {enabled:true,protocol:'http',host:'127.0.0.1',port,username:'',revision:1},()=>{})
    expect((await guest(request)).stdout).toContain('through-proxy')
    expect(connections).toEqual(['CONNECT 1.1.1.1:80 HTTP/1.1'])
    expect((await guest("import socket; print(socket.gethostbyname('example.com'))")).stdout.trim()).toMatch(/^198\.19\./)
    await expect(guest("import socket; socket.create_connection(('169.254.169.254',80),2).sendall(b'GET / HTTP/1.0\\r\\n\\r\\n'); raise SystemExit(1)")).rejects.toThrow()
    reject=true
    const failed=await guest(request).catch(()=>({stdout:''}))
    expect(failed.stdout).not.toContain('through-proxy')
    expect(connections.length).toBe(2)
    const interfaces=await exec('docker',['exec',name,'ip','-j','link'])
    expect(JSON.parse(interfaces.stdout).map((i:any)=>i.ifname).sort()).toEqual(['lo','tun0'])
  }finally{await proxy?.close();await exec('docker',['rm','-f',name]).catch(()=>{});await new Promise<void>(r=>upstream.close(()=>r()))}
},60000)

it.skipIf(!enabled||!process.env.YAOYAO_NETWORK_TEST_DESKTOP_IMAGE)('prepares a real managed desktop with a separate gateway and removes only its own resources',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-network-provider-')),provider=new ContainerComputerProvider('docker',randomUUID(),home)
  const spec={id:randomUUID(),ownerKey:'network-provider-fixture',imageId:process.env.YAOYAO_NETWORK_TEST_DESKTOP_IMAGE!,network:'managed-proxy' as const}
  try{
    const state=await provider.ensure(spec,()=>{})
    expect(state.running).toBe(true)
    const result=await provider.execute(spec,['python3','-c','import os,socket; print(os.getuid()); print(open("/etc/resolv.conf").read())'],{authorize:()=>{}})
    expect(result.stdout).toContain('1000');expect(result.stdout).toContain('198.18.0.1')
    await expect(provider.execute(spec,['sh','-c','ip link add bypass type dummy'],{authorize:()=>{},user:'root'})).rejects.toThrow()
    const namespace=JSON.parse((await exec('docker',['inspect',state.containerId])).stdout)[0].HostConfig.NetworkMode
    expect(namespace).toMatch(/^container:/)
    await provider.remove(spec)
    await expect(exec('docker',['inspect',namespace.slice('container:'.length)])).rejects.toThrow()
  }finally{await provider.remove(spec).catch(()=>{});await rm(home,{recursive:true,force:true})}
},60000)
