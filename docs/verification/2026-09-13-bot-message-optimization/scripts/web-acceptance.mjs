import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const root='/tmp/bot-latency-acceptance', config=JSON.parse(readFileSync(root+'/connections.json'));
const results=[], nonce=Date.now().toString(36);
const browser=await chromium.launch({headless:true});
try{
 for(const mode of ['baseline','optimized']){
  const {url,conversationId}=config[mode];
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await context.newPage();
  await page.addInitScript(()=>{
   const NativeSource=window.EventSource;window.__latencySources=[];
   window.EventSource=class extends NativeSource { constructor(...args){super(...args);window.__latencySources.push(this);this.addEventListener('ready',()=>{this.__ready=true})} };
   const original=window.fetch;
   window.fetch=async(...args)=>{
    const input=args[0], options=args[1];const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const response=await original(...args);
    if(options?.method==='POST'&&/\/conversations\/[^/]+\/messages$/.test(target)) window.__botLatency?.push({time:Date.now()/1000,name:'post_ack',detail:''});
    return response;
   };
  });
  await fetch(`http://127.0.0.1:19359/scenario?delay=160&run=${mode}-web-setup`);
  await page.goto(url+'/conversations');
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');
  const [loginResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/app/login')&&r.request().method()==='POST'),page.getByRole('button',{name:'登录',exact:true}).click()]);
  await loginResponse.finished();if(!loginResponse.ok())throw new Error('Fixture login failed');
  await page.goto(url+'/conversations/'+conversationId);
  const input=page.locator('textarea.composer-textarea');
  await input.waitFor(); await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>{
   let previous='';
   const root=document.querySelector('.message-stack');
   new MutationObserver(()=>{
    const rows=document.querySelectorAll('.message--assistant');const row=rows[rows.length-1];
    const text=row?.querySelector('.message__content')?.textContent??'';const key=(row?.dataset.messageId??'')+'|'+text;
    if(key!==previous){previous=key;window.__botLatency.push({time:Date.now()/1000,name:'dom_text',detail:'assistant|'+(row?.querySelector('.markdown--streaming')?'streaming':'complete')+'|'+text.length});}
   }).observe(root,{subtree:true,characterData:true,childList:true});
  });
  for(const [kind,count] of [['short',6],['long',1]]){
   for(let i=1;i<=count;i++){
    const run=`${mode}-web-${kind}-${i}`, marker=`${kind}-${run}-${nonce}`;
    await fetch(`http://127.0.0.1:19359/scenario?delay=160&run=${run}`);
    await page.evaluate(()=>{window.__botLatency.length=0});
    await input.fill(`[latency:${marker}]`);await input.press('Enter');
    await page.waitForFunction(end=>window.__botLatency?.some(v=>v.name==='completed_text'&&v.detail.endsWith(end)),` END-${marker}`,{timeout:30000});
    const trace=await page.evaluate(()=>window.__botLatency);
    const completed=trace.find(v=>v.name==='completed_text'&&v.detail.endsWith(` END-${marker}`));
    const body=kind==='long'?Array.from({length:200},(_,n)=>`第${String(n+1).padStart(3,'0')}段。用于比较两个移动端的连续文本显示表现，全部内容来自隔离测试服务。\n\n`).join(''):Array.from({length:40},(_,n)=>`${String(n+1).padStart(2,'0')}测试文字 `).join('');
    if(completed.detail!==body+` END-${marker}`)throw new Error('Full response mismatch');
    results.push({run,mode,trace});writeFileSync(root+'/evidence/web-traces.json',JSON.stringify(results,null,2));
    if(i===count)await page.screenshot({path:root+`/evidence/${mode}-web-${kind}.png`});
    await page.waitForTimeout(700);
   }
  }
  if(mode==='optimized'){
   await fetch(`http://127.0.0.1:19359/scenario?delay=160&run=optimized-web-reading`);
   const scroller=page.locator('.message-stack').locator('..');const box=await scroller.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-700);await page.waitForTimeout(200);
   const top=await scroller.evaluate(e=>e.scrollTop);
   const sources=await page.evaluate(()=>window.__latencySources.length);
   await page.evaluate(()=>window.__latencySources.at(-1).dispatchEvent(new MessageEvent('reset',{data:'{}'})));
   await page.waitForFunction(n=>window.__latencySources.length>n&&window.__latencySources.at(-1).__ready,sources);
   await page.waitForTimeout(100);
   if(Math.abs(await scroller.evaluate(e=>e.scrollTop)-top)>4)throw new Error('Snapshot recovery moved the reader');
   const caps=await(await context.request.get(url+'/api/app/capabilities')).json();const marker='short-reading-'+nonce;
   const sent=await context.request.post(url+'/api/app/conversations/'+conversationId+'/messages',{headers:{origin:url,'X-CSRF-Token':caps.csrfToken},data:{requestId:crypto.randomUUID(),content:'[latency:'+marker+']'}});
   if(!sent.ok())throw new Error(await sent.text());
   await page.waitForFunction(end=>window.__botLatency.some(v=>v.name==='completed_text'&&v.detail.endsWith(end)),' END-'+marker,{timeout:20000});
   if(Math.abs(await scroller.evaluate(e=>e.scrollTop)-top)>4)throw new Error('New reply pulled the reader to the bottom');
   await page.screenshot({path:root+'/evidence/optimized-web-reading.png'});
  }
  await context.close();
 }
 console.log('14 native Web UI sends passed with exact full text.');
}finally{await browser.close()}
