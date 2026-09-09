import {lookup} from 'node:dns/promises'
import {BlockList,isIP} from 'node:net'
import {networkInterfaces} from 'node:os'

// Conservative public-web policy. Special-use registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const denied4=new BlockList(),denied6=new BlockList(),global6=new BlockList()
for(const [address,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const)denied4.addSubnet(address,prefix,'ipv4')
global6.addSubnet('2000::',3,'ipv6')
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)denied6.addSubnet(address,prefix,'ipv6')
export function publicAddress(address:string):boolean {
  const family=isIP(address)
  if(family===4)return !denied4.check(address,'ipv4')
  return family===6&&global6.check(address,'ipv6')&&!denied6.check(address,'ipv6')
}
export function normalizePublicHost(value:string):string {
  if(!value||value.length>253||/[\s\u0000-\u001f/%\\@?#]/.test(value))throw new Error('网络目标无效')
  const url=new URL(`http://${isIP(value)===6?`[${value}]`:value}`)
  if(url.port||url.username||url.password||url.pathname!=='/')throw new Error('网络目标无效')
  return url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase()
}
export type AddressLookup=(host:string)=>Promise<Array<{address:string;family:number}>>
export async function publicDestination(host:string,port:number,resolve:AddressLookup=host=>lookup(host,{all:true,verbatim:true}),local=networkInterfaces()):Promise<{host:string;address:string;family:4|6;port:number}> {
  if(port!==80&&port!==443)throw new Error('电脑联网仅允许公网 HTTP 和 HTTPS')
  host=normalizePublicHost(host)
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host)
  const own=new BlockList()
  for(const entries of Object.values(local))for(const entry of entries??[]){const family=isIP(entry.address);if(family)own.addAddress(entry.address,family===4?'ipv4':'ipv6')}
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)||own.check(item.address,item.family===4?'ipv4':'ipv6')))throw new Error('电脑不能访问内网、宿主或保留地址')
  const selected=addresses.find(item=>item.family===4)??addresses[0]!
  return {host,address:selected.address,family:selected.family as 4|6,port}
}
