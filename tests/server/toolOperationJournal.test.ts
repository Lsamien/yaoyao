// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {ToolOperationJournal} from '../../src/server/toolOperationJournal'
import {HttpError} from '../../src/server/errors'
import {createHash} from 'node:crypto'

function fixture(){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-operation-journal-')),store=new WorkspaceStore(home),journal=new ToolOperationJournal(store)
  return {store,journal,close(){store.close();rmSync(home,{recursive:true,force:true})}}
}
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

it('joins duplicate in-flight operations and reuses a durable reply across instances',async()=>{
  const f=fixture(),gate=defer(),action=vi.fn(async()=>{await gate.promise;return {fileId:'published'}})
  try{
    const first=f.journal.execute('owner','work','call','export',{downloadId:'one'},()=>{},action)
    const concurrent=f.journal.execute('owner','work','call','export',{downloadId:'one'},()=>{},action)
    gate.resolve()
    expect(await first).toEqual({fileId:'published'});expect(await concurrent).toEqual({fileId:'published'})
    const reopened=new ToolOperationJournal(f.store)
    expect(await reopened.execute('owner','work','call','export',{downloadId:'one'},()=>{},action)).toEqual({fileId:'published'})
    expect(action).toHaveBeenCalledTimes(1)
    expect(f.store.list<any>('owner','tool-operation')).toMatchObject([{state:'complete',result:{fileId:'published'}}])
  }finally{gate.resolve();await Promise.resolve();f.close()}
})

it('canonicalizes object keys but preserves action identity, array order and changed arguments',async()=>{
  const f=fixture(),action=vi.fn(async()=>({ok:true}))
  try{
    await f.journal.execute('owner','work','call','action',{a:1,b:{x:2,y:['first','second']}},()=>{},action)
    await f.journal.execute('owner','work','call','action',{b:{y:['first','second'],x:2},a:1},()=>{},action)
    expect(action).toHaveBeenCalledTimes(1)
    for(const [name,args] of [['other',{a:1,b:{x:2,y:['first','second']}}],['action',{a:1,b:{x:2,y:['second','first']}}],['action',{a:2,b:{x:2,y:['first','second']}}]] as const){
      await expect(f.journal.execute('owner','work','call',name,args,()=>{},action)).rejects.toMatchObject({code:'idempotency_conflict'})
    }
    expect(action).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})

it('scopes stable IDs to both owner and task',async()=>{
  const f=fixture(),action=vi.fn(async()=>({ok:true}))
  try{
    for(const [owner,work] of [['one','work'],['two','work'],['one','other-work']])await f.journal.execute(owner!,work!,'same-call','action',{},()=>{},action)
    expect(action).toHaveBeenCalledTimes(3)
    expect(f.store.list('one','tool-operation')).toHaveLength(2)
    expect(f.store.list('two','tool-operation')).toHaveLength(1)
  }finally{f.close()}
})

it('does not replay a submitted operation whose original process has not produced a receipt',async()=>{
  const f=fixture(),gate=defer(),action=vi.fn(async()=>{await gate.promise;return {ok:true}})
  try{
    const original=f.journal.execute('owner','work','call','submit',{},()=>{},action)
    await Promise.resolve()
    const restarted=new ToolOperationJournal(f.store)
    await expect(restarted.execute('owner','work','call','submit',{},()=>{},action)).rejects.toMatchObject({code:'tool_operation_uncertain'})
    expect(action).toHaveBeenCalledTimes(1)
    gate.resolve();await original
  }finally{gate.resolve();await Promise.resolve();f.close()}
})

it('persists failures and never repeats an external effect after a missing reply',async()=>{
  const f=fixture(),effect=vi.fn(async()=>{throw new HttpError(504,'已发送，结果未知','transport_uncertain')})
  try{
    await expect(f.journal.execute('owner','work','call','submit',{},()=>{},effect)).rejects.toMatchObject({code:'transport_uncertain'})
    const restarted=new ToolOperationJournal(f.store)
    await expect(restarted.execute('owner','work','call','submit',{},()=>{},effect)).rejects.toMatchObject({status:504,code:'transport_uncertain'})
    expect(effect).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})

it('checks authorization even when returning a cached receipt and after an effect finishes',async()=>{
  const f=fixture(),action=vi.fn(async()=>({ok:true}))
  let allowed=true
  const authorize=()=>{if(!allowed)throw new HttpError(403,'任务已撤销','revoked')}
  try{
    await f.journal.execute('owner','work','cached','submit',{},authorize,action)
    allowed=false
    await expect(f.journal.execute('owner','work','cached','submit',{},authorize,action)).rejects.toMatchObject({code:'revoked'})
    expect(action).toHaveBeenCalledTimes(1)
    allowed=true
    const revokeDuring=vi.fn(async()=>{allowed=false;return {ok:true}})
    await expect(f.journal.execute('owner','work','late-revoke','submit',{},authorize,revokeDuring)).rejects.toMatchObject({code:'revoked'})
    allowed=true
    await expect(f.journal.execute('owner','work','late-revoke','submit',{},authorize,revokeDuring)).rejects.toMatchObject({code:'revoked'})
    expect(revokeDuring).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})

it('keeps a bounded receipt for a large command reply and never replays its side effect after restart',async()=>{
  const f=fixture(),value={stdout:'文件正文'.repeat(4096)},action=vi.fn(async()=>value),encoded=JSON.stringify(value)
  try{
    expect(await f.journal.execute('owner','work','call','computer_shell',{},()=>{},action)).toBe(value)
    const receipt=f.store.list<any>('owner','tool-operation')[0]
    expect(receipt.state).toBe('complete');expect(receipt).not.toHaveProperty('result')
    expect(receipt.resultSummary).toEqual({cached:false,reason:'size',bytes:Buffer.byteLength(encoded),sha256:createHash('sha256').update(encoded).digest('hex')})
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024)
    const restarted=new ToolOperationJournal(f.store)
    await expect(restarted.execute('owner','work','call','computer_shell',{},()=>{},action)).rejects.toMatchObject({code:'tool_operation_result_unavailable'})
    expect(action).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})

it.each([
  ['computer_read_file',{}],['computer_desktop_state',{}],['managed_browser_state',{}],['managed_browser_snapshot',{}],
  ['managed_browser_action',{action:{kind:'screenshot'}}],
] as const)('records observation evidence without retaining the %s payload',async(name,args)=>{
  const f=fixture(),action=vi.fn(async()=>({content:'private-observation'}))
  try{
    expect(await f.journal.execute('owner','work','call',name,args,()=>{},action)).toEqual({content:'private-observation'})
    const receipt=f.store.list<any>('owner','tool-operation')[0]
    expect(receipt).toMatchObject({state:'complete',resultSummary:{cached:false,reason:'observation'}})
    expect(receipt).not.toHaveProperty('result')
    expect(JSON.stringify(receipt)).not.toContain('private-observation')
    await expect(new ToolOperationJournal(f.store).execute('owner','work','call',name,args,()=>{},action)).rejects.toMatchObject({code:'tool_operation_result_unavailable'})
    expect(action).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})

it('shares an uncached binary reply in flight but persists only evidence, even for a small image',async()=>{
  const f=fixture(),gate=defer(),value={content:[{type:'image',mimeType:'image/png',data:'private-base64'}]},action=vi.fn(async()=>{await gate.promise;return value})
  try{
    const first=f.journal.execute('owner','work','call','some_effect',{},()=>{},action)
    const duplicate=f.journal.execute('owner','work','call','some_effect',{},()=>{},action)
    gate.resolve()
    expect(await first).toBe(value);expect(await duplicate).toBe(value)
    const receipt=f.store.list<any>('owner','tool-operation')[0]
    expect(receipt).toMatchObject({state:'complete',resultSummary:{cached:false,reason:'binary'}})
    expect(JSON.stringify(receipt)).not.toContain('private-base64')
    await expect(new ToolOperationJournal(f.store).execute('owner','work','call','some_effect',{},()=>{},action)).rejects.toMatchObject({code:'tool_operation_result_unavailable'})
    expect(action).toHaveBeenCalledTimes(1)
  }finally{gate.resolve();await Promise.resolve();f.close()}
})

it('bounds error receipts without permitting a failed side effect to execute again',async()=>{
  const f=fixture(),action=vi.fn(async()=>{throw new HttpError(500,'x'.repeat(100000),'failed_effect')})
  try{
    await expect(f.journal.execute('owner','work','call','computer_shell',{},()=>{},action)).rejects.toMatchObject({code:'failed_effect'})
    const receipt=f.store.list<any>('owner','tool-operation')[0]
    expect(receipt.state).toBe('failed')
    expect(receipt.error.message.length).toBeLessThanOrEqual(2048)
    await expect(new ToolOperationJournal(f.store).execute('owner','work','call','computer_shell',{},()=>{},action)).rejects.toMatchObject({code:'failed_effect'})
    expect(action).toHaveBeenCalledTimes(1)
  }finally{f.close()}
})
