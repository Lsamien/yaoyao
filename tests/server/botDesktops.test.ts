// @vitest-environment node
import {it,expect} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {BotDesktops,desktopSocket,DESKTOP_SCRIPT} from '../../src/runner/computers/desktops'

/** A guest that runs `yaoyao-desktop` faithfully enough: displays, tokens, a running container. */
function guest(options:{script?:boolean}={}){
  const displays=new Map<string,string>(),calls:string[][]=[]
  let running=true
  const provider:any={
    inspect:async()=>({running}),
    execute:async(target:any,argv:string[],options_:any)=>{
      calls.push(argv);options_.authorize()
      if(options.script===false)throw Object.assign(new Error('电脑命令失败'),{stderr:`python3: can't open file '${DESKTOP_SCRIPT}': [Errno 2] No such file or directory`})
      const [,script,command,display,token]=argv
      expect(script).toBe(DESKTOP_SCRIPT);expect(options_.user).toBe('cua')
      const n=`${target.id}:${display}`
      if(command==='inspect')return {stdout:JSON.stringify({running:running&&displays.has(n),token:displays.get(n)??null})}
      if(command==='start'){displays.set(n,token!);return {stdout:JSON.stringify({running:true,token})}}
      if(command==='stop'){displays.delete(n);return {stdout:'{"running":false}'}}
      throw new Error('unexpected')
    },
  }
  return {provider,displays,calls,has:(computer:any,display:number)=>displays.has(`${computer.id}:${display}`),set:(computer:any,display:number,token:string)=>displays.set(`${computer.id}:${display}`,token),restart(){displays.clear()},setRunning(value:boolean){running=value}}
}
const spec=(id=randomUUID())=>({id,ownerKey:'owner',imageId:'sha256:'+'a'.repeat(64)})
const ok=()=>{}

it('gives each Bot its own display in the account computer, enforces the limit and reuses released displays',async()=>{
  const g=guest(),db=new DatabaseSync(':memory:'),desktops=new BotDesktops(db,g.provider,()=>2),computer=spec()
  const a=randomUUID(),b=randomUUID(),c=randomUUID()
  const first=await desktops.ensure(computer,a,ok),second=await desktops.ensure(computer,b,ok)
  expect([first.display,second.display]).toEqual([2,3])
  expect(first.socket).toBe(desktopSocket(2))
  expect(g.calls.filter(argv=>argv[2]==='start').map(argv=>argv[5])).toEqual([a,b]) // HOME key is the Bot
  // Asking again changes nothing.
  expect(await desktops.ensure(computer,a,ok)).toEqual(first)
  expect(g.calls.filter(argv=>argv[2]==='start')).toHaveLength(2)
  await expect(desktops.ensure(computer,c,ok)).rejects.toMatchObject({code:'computer_desktop_capacity'})
  // Another account computer has its own displays.
  expect((await desktops.ensure(spec(),c,ok)).display).toBe(2)
  // Stop keeps the display reserved for the Bot; release frees it.
  await desktops.stop(computer,b,ok)
  expect(g.has(computer,3)).toBe(false);expect(desktops.current('owner',computer.id,b)?.display).toBe(3)
  await desktops.release(computer,b,ok)
  expect(desktops.current('owner',computer.id,b)).toBeUndefined()
  expect((await desktops.ensure(computer,c,ok)).display).toBe(3)
  // Concurrent requests never hand out one display twice.
  const other=spec(),many=await Promise.all([randomUUID(),randomUUID()].map(id=>desktops.ensure(other,id,ok)))
  expect(new Set(many.map(d=>d.display)).size).toBe(2)
})

it('keeps a Bot on the same display across container restarts and refuses a display owned by another token',async()=>{
  const g=guest(),db=new DatabaseSync(':memory:'),computer=spec(),bot=randomUUID()
  const first=await new BotDesktops(db,g.provider).ensure(computer,bot,ok)
  g.restart()
  // A new Runner process reads the same private database.
  const restarted=new BotDesktops(db,g.provider),again=await restarted.ensure(computer,bot,ok)
  expect(again.display).toBe(first.display);expect(again.token).toBe(first.token)
  g.set(computer,first.display,randomUUID())
  await expect(restarted.ensure(computer,bot,ok)).rejects.toMatchObject({code:'computer_desktop_owner_mismatch'})
  // Stop on a stopped computer is a no-op; forget clears a retired computer.
  g.setRunning(false);await restarted.stop(computer,bot,ok)
  restarted.forget('owner',computer.id);expect(restarted.list('owner',computer.id)).toEqual([])
})

it('asks for a new image when the computer predates per-Bot desktops',async()=>{
  const g=guest({script:false}),desktops=new BotDesktops(new DatabaseSync(':memory:'),g.provider)
  await expect(desktops.ensure(spec(),randomUUID(),ok)).rejects.toMatchObject({code:'computer_image_upgrade_required'})
})
