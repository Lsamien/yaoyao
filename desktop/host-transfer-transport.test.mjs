import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {exchangeDesktopEnvironment} from './environment-exchange.mjs'
import {remoteExchange} from './host-manager.mjs'

for(const kind of ['server','client'])test(`${kind} transport accepts a complete 10 MiB file and still bounds oversized commands`,async()=>{
 const data=Buffer.alloc(10*1024*1024,255).toString('base64'),hostId=randomUUID(),seen=[]
 let response={commands:[{id:randomUUID(),operation:'file',action:{op:'receive',path:'Desktop/a.bin',data}}]}
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({path:req.url,headers:req.headers,body:JSON.parse(body)});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${server.address().port}`
 const exchange=()=>kind==='server'?exchangeDesktopEnvironment({url,token:'fixture'},{results:[]}):remoteExchange({serverURL:url,hostId,token:'fixture'},{results:[]})
 try{
  const result=await exchange()
  assert.equal(result.commands[0].action.data,data)
  assert.equal(seen[0].path,kind==='server'?'/desktop/environment':`/api/desktop-host/v1/${hostId}/exchange`)
  assert.equal(kind==='server'?seen[0].headers['x-yaoyao-desktop-token']:seen[0].headers.authorization,kind==='server'?'fixture':'Bearer fixture')
  response={commands:[],padding:'x'.repeat(16*1024*1024)}
  await assert.rejects(exchange,/超过限制/)
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
