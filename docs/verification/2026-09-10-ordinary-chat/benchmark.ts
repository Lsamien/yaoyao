import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ChatCacheStore,ChatCacheCoordinator} from '../../../src/server/chatCache.js'
const home=mkdtempSync(join(tmpdir(),'ordinary-bench-'))
const store=new ChatCacheStore(home),coordinator=new ChatCacheCoordinator(store,{request:async()=>{throw new Error('Unexpected upstream read')}} as any)
for(let i=0;i<1000;i++)store.recordCommand('bench','p',`s${i}`,'session.create',{})
const events:number[]=[],reads:number[]=[]
for(let i=0;i<500;i++){const start=performance.now();coordinator.observe('bench','p','s0',{type:'message.delta',payload:{text:'测试'},delivery_id:`e${i}`});events.push(performance.now()-start)}
coordinator.observe('bench','p','s0',{type:'message.complete',payload:{},delivery_id:'done'})
for(let i=0;i<200;i++){const start=performance.now();coordinator.readLocal('bench','list','p',undefined,{limit:20});reads.push(performance.now()-start)}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return{count:v.length,p50_ms:v[Math.floor(v.length*.5)],p95_ms:v[Math.floor(v.length*.95)],max_ms:v.at(-1)}}
console.log(JSON.stringify({environment:'local macOS SQLite microbenchmark; not model/network/device latency',list_sessions:1000,event_persistence:stats(events),local_list:stats(reads),diagnostics:coordinator.diagnostics},null,2))
coordinator.close();store.close();rmSync(home,{recursive:true,force:true})
