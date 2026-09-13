import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
const directory=process.argv[2]??new URL('../results',import.meta.url).pathname;
const network=readFileSync(directory+'/network.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const samples=[];
const median=x=>{x=[...x].sort((a,b)=>a-b);return x[Math.floor(x.length/2)]};
function measure(trace,run,mode){
 const started=trace.find(v=>v.name==='send_start');if(!started)return;
 const entries=trace.filter(v=>v.time>=started.time);
 const finished=Math.max(...trace.map(v=>v.time))+.8;
 const n=network.filter(v=>v.run===run&&v.time>=started.time-.01&&v.time<=finished);
 const ready=entries.find(v=>v.name==='send_ready');
 const ack=entries.find(v=>v.name==='post_ack');
 const views=entries.filter(v=>v.name==='view_text'&&v.detail.startsWith('assistant|')&&Number(v.detail.split('|').at(-1))>0);
 const first=views[0];
 const dom=entries.filter(v=>v.name==='dom_text'&&Number(v.detail.split('|').at(-1))>0);
 const domGaps=dom.slice(1).map((v,i)=>(v.time-dom[i].time)*1000).filter(v=>v>0&&v<2000);
 const posts=n.filter(v=>v.event==='request'&&v.method==='POST'&&v.path.endsWith('/messages'));
 const ackNetwork=n.find(v=>v.event==='response_end'&&v.id===posts[0]?.id);
 const delay=entries.map(v=>v.time);const gaps=views.slice(1).map((v,i)=>(v.time-views[i].time)*1000).filter(v=>v>0&&v<2000);
 const round=v=>v===undefined?null:Math.round(v*100)/100;
 const complete=entries.find(v=>v.name==='completed_text'&&v.detail.includes(' END-'));
 if(complete){
  const marker=complete.detail.split(' END-').at(-1);
  const body=marker.startsWith('long-')?Array.from({length:200},(_,i)=>`第${String(i+1).padStart(3,'0')}段。用于比较两个移动端的连续文本显示表现，全部内容来自隔离测试服务。\n\n`).join(''):Array.from({length:40},(_,i)=>`${String(i+1).padStart(2,'0')}测试文字 `).join('');
  if(complete.detail!==body+' END-'+marker)throw new Error('Exact text mismatch: '+run);
 }
 samples.push({run,mode,startedAt:started.time,finishedAt:Math.max(...trace.map(v=>v.time)),sendReadyMs:round(ready&&(ready.time-started.time)*1000),postAckMs:round(ack&&(ack.time-started.time)*1000),
  afterAckMs:round(ready&&(ack??ackNetwork)&& (ready.time-(ack??ackNetwork).time)*1000),firstViewMs:round(first&&(first.time-started.time)*1000),
  viewCount:views.length,domUpdateGapMs:round(domGaps.length?median(domGaps):undefined),medianViewGapMs:round(gaps.length?median(gaps):undefined),maxViewGapMs:round(gaps.length?Math.max(...gaps):undefined),
  sseBytes:n.filter(v=>v.event==='sse_bytes').reduce((a,b)=>a+b.bytes,0),postCount:posts.length,
  exactTextVerified:!!complete,requests:n.filter(v=>v.event==='request').map(v=>v.method+' '+v.path)});
}
for(const file of readdirSync(directory).filter(f=>/^latency-(baseline|optimized)-ios-.*\.jsonl$/.test(f))){
 const trace=readFileSync(directory+'/'+file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const starts=trace.map((v,i)=>v.name==='send_start'?i:-1).filter(i=>i>=0);
 for(let i=0;i<starts.length;i++){
  const group=file.slice(8,-6), part=trace.slice(starts[i],starts[i+1]??trace.length);
  measure(part,group+'-'+(i+1),group.startsWith('baseline')?'baseline':'optimized');
 }
}
for(const file of readdirSync(directory).filter(f=>/^(baseline|optimized)-android\.jsonl$/.test(f))){
 const trace=readFileSync(directory+'/'+file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const run of new Set(trace.map(v=>v.run).filter(v=>!v.endsWith('setup')))) measure(trace.filter(v=>v.run===run),run,file.startsWith('baseline')?'baseline':'optimized');
}
try{for(const sample of JSON.parse(readFileSync(directory+'/web-traces.json','utf8')))measure(sample.trace,sample.run,sample.mode)}catch(e){if(e.code!=='ENOENT')throw e}
const summary=[];
for(const platform of ['ios','android','web'])for(const mode of ['baseline','optimized']){
 const values=samples.filter(v=>v.run.startsWith(mode+'-'+platform+'-short-')&&!v.run.endsWith('-1')&&v.sendReadyMs!==null);
 if(!values.length)continue;
 const row={platform,mode,samples:values.length};
 for(const key of ['sendReadyMs','postAckMs','afterAckMs','firstViewMs','medianViewGapMs','domUpdateGapMs']){
  const data=values.map(v=>v[key]).filter(v=>v!==null);row[key]=data.length?Math.round(median(data)*100)/100:null;
 }
 summary.push(row);
}
writeFileSync(directory+'/measurements.json',JSON.stringify({samples,summary},null,2));console.log(JSON.stringify(summary,null,2));
