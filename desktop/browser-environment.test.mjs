import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {_electron} from '@playwright/test'

test('real isolated Chromium supports refs, tabs, screenshots and separate persisted profiles',{timeout:60000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-browser-')),marker=randomUUID(),server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>Browser ${marker}</title><body style="background:#edf4ff;font:24px sans-serif;padding:50px"><h1>独立浏览器验证</h1><label>随机内容 <input aria-label="验证输入"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">确认</button><output></output><p>${marker}</p><a href="/next">下一页</a></body>`)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`,moduleURL=pathToFileURL(resolve('desktop/browser-environment.mjs')).href
 await writeFile(join(home,'main.mjs'),`import {app,BrowserWindow} from 'electron';app.setPath('userData',${JSON.stringify(join(home,'app'))});app.whenReady().then(async()=>{const hostWindow=new BrowserWindow({show:false});await hostWindow.loadURL('about:blank');const {BrowserEnvironment}=await import(${JSON.stringify(moduleURL)});globalThis.botBrowser=new BrowserEnvironment(${JSON.stringify(join(home,'profiles'))});app.on('window-all-closed',()=>{});});`)
 let app
 try{
  app=await _electron.launch({args:[join(home,'main.mjs')],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE'))})
  await app.evaluate(async()=>{for(let i=0;i<100&&!globalThis.botBrowser;i++)await new Promise(resolve=>setTimeout(resolve,20));if(!globalThis.botBrowser)throw new Error('browser host did not initialize')})
  const call=async(method,...args)=>app.evaluate(async(_,{method,args})=>globalThis.botBrowser[method](...args),{method,args})
  const a='a'.repeat(64),b='b'.repeat(64),t='c'.repeat(64)
  assert.equal((await call('state',a)).open,false)
  await call('action',a,'persistent',{kind:'navigate',url})
  const snapshot=await call('action',a,'persistent',{kind:'snapshot'})
  assert.ok(snapshot.text.includes(marker));const input=snapshot.elements.find(e=>e.label==='验证输入');assert.ok(input)
  await call('action',a,'persistent',{kind:'fill',ref:input.ref,snapshotId:snapshot.snapshotId,text:marker})
  await assert.rejects(call('action',a,'persistent',{kind:'click',ref:input.ref,snapshotId:snapshot.snapshotId}),/变化/)
  const next=await call('action',a,'persistent',{kind:'snapshot'}),button=next.elements.find(e=>e.label==='确认')
  await call('action',a,'persistent',{kind:'click',ref:button.ref,snapshotId:next.snapshotId})
  assert.equal(await app.evaluate(()=>globalThis.botBrowser.current(globalThis.botBrowser.browsers.values().next().value).webContents.executeJavaScript('document.querySelector("output").textContent')),marker)
  const frame=await call('view',a);assert.ok(frame.width>=1000);assert.ok(Buffer.from(frame.data,'base64').length>10000)
  await mkdir(resolve('test-results/desktop'),{recursive:true});await writeFile(resolve('test-results/desktop/bot-browser.png'),Buffer.from(frame.data,'base64'))
  await call('action',a,'persistent',{kind:'new-tab',url:url+'next'});const tabs=(await call('state',a)).tabs;assert.equal(tabs.length,2)
  await call('action',a,'persistent',{kind:'close-tab',tabId:tabs.find(t=>t.active).id});assert.equal((await call('state',a)).tabs.length,1)
  await assert.rejects(call('action',a,'persistent',{kind:'navigate',url:'file:///etc/passwd'}),/http/)
  await app.evaluate(async(_,{a,url})=>globalThis.botBrowser.browsers.get(a).session.cookies.set({url,name:'owner',value:'a',expirationDate:Date.now()/1000+3600}),{a,url})
  await call('action',b,'persistent',{kind:'navigate',url});assert.deepEqual(await app.evaluate(async(_,b)=>globalThis.botBrowser.browsers.get(b).session.cookies.get({name:'owner'}),b),[])
  await call('action',t,'temporary',{kind:'navigate',url});await app.evaluate(async(_,{t,url})=>globalThis.botBrowser.browsers.get(t).session.cookies.set({url,name:'temporary',value:'yes',expirationDate:Date.now()/1000+3600}),{t,url})
  await call('close');await app.close();app=await _electron.launch({args:[join(home,'main.mjs')],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE'))});await app.evaluate(async()=>{for(let i=0;i<100&&!globalThis.botBrowser;i++)await new Promise(resolve=>setTimeout(resolve,20))});await call('open',a,'persistent');assert.equal((await app.evaluate(async(_,a)=>globalThis.botBrowser.browsers.get(a).session.cookies.get({name:'owner'}),a))[0].value,'a')
  await call('open',t,'temporary');assert.deepEqual(await app.evaluate(async(_,t)=>globalThis.botBrowser.browsers.get(t).session.cookies.get({name:'temporary'}),t),[])
 }finally{await app?.close();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true})}
})
