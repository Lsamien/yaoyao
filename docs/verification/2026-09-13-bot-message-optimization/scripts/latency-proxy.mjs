import http from 'node:http';
import { appendFileSync,writeFileSync } from 'node:fs';
const directory='/tmp/bot-latency-acceptance';
async function seed(url){
 const login=await fetch(url+'/auth/password-login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({username:'fixture',password:'fixture-pass'})});
 let cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const response=await fetch(url+'/api/app/bootstrap',{headers:{cookie}}),bootstrap=await response.json();
 cookie+='; '+response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const headers={cookie,origin:url,'content-type':'application/json','X-CSRF-Token':bootstrap.csrfToken};
 const created=await fetch(url+'/api/app/agents',{method:'POST',headers,body:JSON.stringify({name:'LatencyBot',profile:'default'})});
 if(!created.ok&&created.status!==409)throw new Error(await created.text());
 const {conversations}=await(await fetch(url+'/api/app/conversations',{headers})).json();
 return {conversationId:conversations.find(v=>v.name==='LatencyBot').id};
}
const baseline=await seed('http://127.0.0.1:19351'),optimized=await seed('http://127.0.0.1:19361');
let delay=160,run='setup',id=0;
const log=value=>appendFileSync(directory+'/evidence/network.jsonl',JSON.stringify({time:Date.now()/1000,run,...value})+'\n');
function proxy(mode,port,targetPort){
 const target=new URL('http://127.0.0.1:'+targetPort);
 http.createServer((req,res)=>{
  const requestId=++id,half=delay/2,start=Date.now();const parts=[];
  req.on('data',p=>parts.push(p));req.on('end',()=>{
   log({mode,id:requestId,event:'request',method:req.method,path:req.url});
   setTimeout(()=>{
    const headers={...req.headers,host:target.host};if(headers.origin)headers.origin=target.origin;
    const up=http.request(new URL(req.url,target),{method:req.method,headers},response=>{
     const streaming=String(response.headers['content-type']??'').includes('text/event-stream');let buffer='',bytes=0;const lengths=new Map();
     setTimeout(()=>{if(!res.destroyed){res.writeHead(response.statusCode,response.headers);res.flushHeaders()}},half);
     response.on('data',chunk=>{
      bytes+=chunk.length;
      if(streaming){
       log({mode,id:requestId,event:'sse_bytes',bytes:chunk.length});buffer+=chunk.toString();let cut;
       while((cut=buffer.indexOf('\n\n'))>=0){
        const frame=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
        const line=frame.split('\n').find(x=>x.startsWith('data:'));
        if(line)try{
         const v=JSON.parse(line.slice(5));const entry={mode,id:requestId,event:'sse',type:v.type??'ready',seq:v.seq};
         if(v.type==='message.changed'&&v.data?.role==='assistant'){
          lengths.set(v.data.id,v.data.content.length);Object.assign(entry,{chars:v.data.content.length,status:v.data.status,messageId:v.data.id});
         }else if(v.type==='message.patch'){
          const n=(lengths.get(v.data.id)??0)+v.data.contentAppend.length;lengths.set(v.data.id,n);Object.assign(entry,{chars:n,status:'streaming',messageId:v.data.id});
         }log(entry);
        }catch{}
       }
      }
      setTimeout(()=>{if(!res.destroyed)res.write(chunk)},half);
     });
     response.on('end',()=>setTimeout(()=>{if(!res.destroyed)res.end();log({mode,id:requestId,event:'response_end',path:req.url,status:response.statusCode,bytes,elapsedMs:Date.now()-start})},half));
    });up.on('error',e=>{if(!res.headersSent)res.writeHead(502);res.end();log({mode,id:requestId,event:'error',message:e.message})});res.on('close',()=>up.destroy());up.end(Buffer.concat(parts));
   },half);
  });
 }).listen(port,'127.0.0.1');
}
proxy('baseline',19371,19351);proxy('optimized',19372,19361);
const config={baseline:{url:'http://127.0.0.1:19371',...baseline},optimized:{url:'http://127.0.0.1:19372',...optimized}};
writeFileSync(directory+'/connections.json',JSON.stringify(config,null,2));
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:19359');res.setHeader('content-type','application/json');
 if(url.pathname==='/scenario'){delay=Number(url.searchParams.get('delay')??160);run=url.searchParams.get('run')??'setup';log({event:'scenario',delay});res.end('{"ok":true}');return;}
 if(url.pathname==='/clock'){res.end(JSON.stringify({time:Date.now()/1000}));return;}
 res.end(JSON.stringify(config));
}).listen(19359,'127.0.0.1');console.log('Isolated latency proxy ready');
