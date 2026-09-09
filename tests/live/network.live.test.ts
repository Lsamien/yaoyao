// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {ContainerComputerProvider} from '../../src/runner/computers/container'
import {ComputerPool} from '../../src/runner/computers/pool'
import {ComputerPublicProxy} from '../../src/runner/network/computerProxy'

it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('connects from a real networkless guest through the public proxy and denies host access',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-public-network-')),db=new DatabaseSync(':memory:')
  const provider=new ContainerComputerProvider('docker',randomUUID(),home),pool=new ComputerPool(db,provider)
  const spec={id:randomUUID(),ownerKey:randomUUID(),imageId:process.env.YAOYAO_COMPUTER_IMAGE!,network:'public-proxy' as const}
  let proxy:ComputerPublicProxy|undefined,stage='ensure',heartbeat:ReturnType<typeof setInterval>|undefined
  try{
    await pool.recover();const lease=await pool.acquire(spec,'network-proof',()=>{});heartbeat=setInterval(()=>{try{pool.renew(lease)}catch{}},5000)
    const guard=()=>pool.authorize(lease)
    stage='start proxy';proxy=await ComputerPublicProxy.start(provider,spec,resolve('src/runner/network/guest_proxy.py'),guard,async()=>guard(),()=>{})
    const command=(argv:string[])=>pool.use(lease,context=>provider.execute(spec,argv,context))
    stage='inspect interfaces';expect((await command(['ls','/sys/class/net'])).stdout.trim()).toBe('lo')
    stage='public HTTPS';const page=await command(['curl','--fail','--silent','--show-error','--max-time','20','https://example.com'])
    expect(page.stdout).toContain('Example Domain')
    stage='browser';const browser=(await command(['/bin/sh','-c','command -v firefox || command -v chromium || command -v google-chrome'])).stdout.trim()
    if(browser.includes('firefox')){
      await command(['mkdir','-p','.browser-profiles/network-proof'])
      await command([browser,'--headless','--profile','/home/cua/workspace/.browser-profiles/network-proof','--screenshot','/tmp/network-browser.png','--window-size','1280,900','https://example.com'])
      const png=Buffer.from((await command(['base64','-w0','/tmp/network-browser.png'])).stdout.trim(),'base64')
      expect(png.subarray(1,4).toString()).toBe('PNG');await mkdir('test-results/network',{recursive:true});await writeFile('test-results/network/browser.png',png)
    }else throw new Error(`No verified Firefox path: ${browser}`)
    stage='reject host';const rejected=await command(['curl','--silent','--max-time','10','--noproxy','','--proxy','http://127.0.0.1:3128','--output','/dev/null','--write-out','%{http_code}','http://127.0.0.1:15300'])
    expect(rejected.stdout).toBe('502')
    stage='close proxy';await proxy.close();proxy=undefined
    await expect(command(['curl','--fail','--silent','--max-time','2','https://example.com'])).rejects.toBeDefined()
    stage='release';await pool.release(lease)
  }catch(error){throw new Error(`${stage}: ${String(error)} code=${(error as any).code}\n${String((error as any).stdout??'')}\n${String((error as any).stderr??'')}`)}finally{clearInterval(heartbeat);await proxy?.close();await pool.close();db.close();await provider.remove(spec);await rm(home,{recursive:true,force:true})}
},90000)
