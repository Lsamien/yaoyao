// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {createServer} from 'node:net'
import {randomUUID} from 'node:crypto'
import {publicAddress,publicDestination,normalizePublicHost} from '../../src/runner/network/publicDestination'
import {PublicSocketBroker,type NetworkFrame} from '../../src/runner/network/socketBroker'

it.each(['127.0.0.1','127.20.30.40','0.0.0.0','10.1.2.3','100.64.0.1','169.254.169.254','172.31.2.3','192.168.1.1','192.0.0.9','192.0.2.1','198.19.1.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','fe80::1','fd00::1','64:ff9b::a00:1','2001:db8::1','2002:7f00:1::1','3fff::1'])('blocks non-public destination %s',address=>expect(publicAddress(address)).toBe(false))
it.each(['1.1.1.1','8.8.8.8','93.184.216.34','2606:4700:4700::1111'])('recognizes ordinary public unicast %s',address=>expect(publicAddress(address)).toBe(true))
it.each(['127.1','2130706433','0x7f000001'])('normalizes alternate IP notation before applying the policy (%s)',async host=>{
  expect(normalizePublicHost(host)).toBe('127.0.0.1');await expect(publicDestination(host,443)).rejects.toThrow()
})
it('rejects mixed DNS, host addresses and unsafe authority syntax',async()=>{
  await expect(publicDestination('fixture.example',443,async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}],{})).rejects.toThrow()
  await expect(publicDestination('fixture.example',443,async()=>[{address:'1.1.1.1',family:4}],{eth0:[{address:'1.1.1.1',family:'IPv4'} as any]})).rejects.toThrow()
  for(const host of ['user:secret@example.com','example.com/path','example.com:8443','host%2elocal','[::1%eth0]'])expect(()=>normalizePublicHost(host)).toThrow()
  await expect(publicDestination('1.1.1.1',22)).rejects.toThrow()
})
it('pins the resolved address and revalidates each new connection',async()=>{
  let calls=0
  const lookup=async()=>[{address:calls++===0?'1.1.1.1':'127.0.0.1',family:4}]
  expect(await publicDestination('fixture.example',443,lookup,{})).toMatchObject({address:'1.1.1.1',port:443})
  await expect(publicDestination('fixture.example',443,lookup,{})).rejects.toThrow()
})
it('does not dial after authority changes while DNS is pending',async()=>{
  let release!:(value:any)=>void,allowed=true
  const frames:NetworkFrame[]=[],dial=vi.fn()
  const broker=new PublicSocketBroker(async frame=>{frames.push(frame)},()=>{if(!allowed)throw new Error('revoked')},()=>new Promise(resolve=>{release=resolve}),dial)
  const pending=broker.receive({op:'open',id:randomUUID(),host:'example.com',port:443})
  await vi.waitFor(()=>expect(release).toBeDefined());allowed=false;release({address:'1.1.1.1',family:4,port:443,host:'example.com'})
  await pending;expect(dial).not.toHaveBeenCalled();expect(frames.at(-1)?.op).toBe('error');broker.close()
})
it('bounds pending connections before asynchronous resolution',async()=>{
  let release!:(value:any)=>void
  const wait=new Promise<any>(resolve=>{release=resolve}),frames:NetworkFrame[]=[],dial=vi.fn()
  const broker=new PublicSocketBroker(async frame=>{frames.push(frame)},()=>{},()=>wait,dial,{connections:1,bytes:1024})
  const first=broker.receive({op:'open',id:randomUUID(),host:'example.com',port:443})
  await broker.receive({op:'open',id:randomUUID(),host:'example.com',port:443})
  expect(broker.activeConnections).toBe(1);expect(frames.at(-1)?.op).toBe('error')
  broker.close();release({address:'1.1.1.1',family:4,port:443,host:'example.com'});await first;expect(dial).not.toHaveBeenCalled()
})
it('transfers bytes through a real socket and rejects further writes after revocation',async()=>{
  const server=createServer(socket=>socket.on('data',bytes=>socket.write(bytes)))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const frames:NetworkFrame[]=[],id=randomUUID();let active=true
  // The loopback fixture is injected only here; production resolution is tested above.
  const broker=new PublicSocketBroker(async frame=>{frames.push(frame)},()=>{if(!active)throw new Error('revoked')},async()=>({address:'127.0.0.1',family:4,port:(server.address() as {port:number}).port,host:'fixture'}))
  try{
    await broker.receive({op:'open',id,host:'fixture.example',port:443});await vi.waitFor(()=>expect(frames.some(frame=>frame.op==='opened')).toBe(true))
    await broker.receive({op:'data',id,data:Buffer.from('wire-proof').toString('base64')})
    await vi.waitFor(()=>expect(frames.some(frame=>frame.op==='data'&&Buffer.from(String(frame.data),'base64').toString()==='wire-proof')).toBe(true))
    active=false;await expect(broker.receive({op:'data',id,data:'eA=='})).rejects.toThrow('revoked')
  }finally{broker.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
