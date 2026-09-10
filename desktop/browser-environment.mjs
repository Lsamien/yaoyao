import {BrowserWindow,session} from 'electron'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {mkdirSync,chmodSync} from 'node:fs'

export function browserURL(value){if(typeof value!=='string'||value.length>4096||/[\\\x00-\x20]/.test(value))throw new Error('请输入完整的 http 或 https 地址');const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('浏览器只支持 http 和 https 页面');return u.href}
const allowed=url=>url==='about:blank'||(()=>{try{browserURL(url);return true}catch{return false}})()
/** A bot gets an isolated Chromium profile, never the app or personal browser's
 * cookies. All commands are structured; no model-supplied JavaScript or CDP. */
export class BrowserEnvironment {
 constructor(root){mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);this.root=root;this.browsers=new Map();this.sessions=new Map()}
 state(key){const b=this.browsers.get(key);return {open:!!b,tabs:b?[...b.tabs].map(([id,w])=>({id,title:w.webContents.getTitle()||'新标签页',url:w.webContents.getURL(),active:id===b.active})):[],profile:b?.profile??'persistent'}}
 async open(key,profile){if(!/^[a-f0-9]{64}$/.test(key)||!['persistent','temporary'].includes(profile))throw new Error('浏览器身份无效');let b=this.browsers.get(key);if(!b){let s=this.sessions.get(key);if(!s){s=profile==='persistent'?session.fromPath(join(this.root,key)):session.fromPartition('yaoyao-temporary-'+key+'-'+randomUUID());s.setPermissionRequestHandler((_w,_p,callback)=>callback(false));s.setPermissionCheckHandler(()=>false);s.on('will-download',event=>event.preventDefault());this.sessions.set(key,s)}b={tabs:new Map(),active:'',session:s,profile};this.browsers.set(key,b);await this.newTab(b,'about:blank')}return b}
 async newTab(b,url){if(b.tabs.size>=12)throw new Error('最多打开 12 个标签页，请先关闭不用的页面');const id=randomUUID(),w=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{session:b.session,sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,webSecurity:true,allowRunningInsecureContent:false}});b.tabs.set(id,w);b.active=id
  w.webContents.setWindowOpenHandler(({url})=>{if(allowed(url))void this.newTab(b,url).catch(()=>{});return {action:'deny'}})
  w.webContents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault()});w.webContents.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault()});w.webContents.on('will-attach-webview',event=>event.preventDefault());w.webContents.on('did-start-navigation',()=>{w.snapshotId=undefined})
  w.on('closed',()=>{b.tabs.delete(id);if(b.active===id)b.active=b.tabs.keys().next().value??''})
  try{await this.load(w,url)}catch(error){if(!w.isDestroyed()&&error.code!=='ERR_ABORTED')throw new Error('页面加载失败，请检查地址或网络')}
  return id
 }
 async load(w,url){let timer;try{await Promise.race([w.loadURL(url),new Promise((_,reject)=>{timer=setTimeout(()=>{if(!w.isDestroyed())w.webContents.stop();reject(new Error('页面加载超时'))},18000)})])}finally{clearTimeout(timer)}}
 current(b){const w=b.tabs.get(b.active);if(!w||w.isDestroyed())throw new Error('浏览器标签页已关闭，请新建标签页');return w}
 async view(key){const b=this.browsers.get(key);if(!b)throw new Error('浏览器尚未打开，点击打开浏览器');const wc=this.current(b).webContents;await wc.executeJavaScript('new Promise(resolve=>{requestAnimationFrame(()=>requestAnimationFrame(resolve));setTimeout(resolve,200)})').catch(()=>{});const image=await wc.capturePage();if(image.isEmpty())throw new Error('浏览器画面尚未就绪');return {data:image.toPNG().toString('base64'),...image.getSize()}}
 async action(key,profile,a){const b=await this.open(key,profile);if(a.kind==='new-tab'){await this.newTab(b,browserURL(a.url));return this.state(key)}
  if(['select-tab','close-tab'].includes(a.kind)){if(!b.tabs.has(a.tabId))throw new Error('标签页已关闭');if(a.kind==='select-tab')b.active=a.tabId;else{b.tabs.get(a.tabId).destroy();if(!b.tabs.size)await this.newTab(b,'about:blank')}return this.state(key)}
  const w=this.current(b),wc=w.webContents
  if(a.kind==='navigate'){const url=browserURL(a.url);w.snapshotId=undefined;try{await this.load(w,url)}catch(error){if(error.code!=='ERR_ABORTED')throw new Error('页面加载失败，请检查地址或网络')}}
  else if(a.kind==='back'){w.snapshotId=undefined;if(wc.navigationHistory.canGoBack())wc.navigationHistory.goBack()}
  else if(a.kind==='forward'){w.snapshotId=undefined;if(wc.navigationHistory.canGoForward())wc.navigationHistory.goForward()}
  else if(a.kind==='reload'){w.snapshotId=undefined;wc.reload()}
  else if(a.kind==='snapshot'){
   const id=randomUUID();w.snapshotId=id
   // Ref metadata lives in an isolated world, out of reach of page scripts.
   const value=await wc.executeJavaScriptInIsolatedWorld(999,[{code:`(()=>{const nodes=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(e=>e.getClientRects().length).slice(0,500);globalThis.__yaoyaoRefs=new Map(nodes.map((e,i)=>['e'+i,e]));return {title:document.title,url:location.href,text:document.body?.innerText.slice(0,24000)||'',elements:nodes.map((e,i)=>({ref:'e'+i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),label:e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText?.slice(0,160)||'',type:e.getAttribute('type')}))}})()`}]);return {...value,snapshotId:id}
  }else if(a.kind==='click'||a.kind==='fill'){
   if(!w.snapshotId||w.snapshotId!==a.snapshotId||!/^e[0-9]+$/.test(a.ref))throw new Error('页面已变化，请重新读取 snapshot')
   if(a.kind==='fill'&&typeof a.text!=='string')throw new Error('填写内容缺失')
   const code=`(()=>{const e=globalThis.__yaoyaoRefs?.get(${JSON.stringify(a.ref)});if(!e||!e.isConnected||!e.getClientRects().length)throw new Error('元素已变化，请重新读取 snapshot');if(e instanceof HTMLInputElement&&e.type==='file')throw new Error('请通过页面接管处理文件选择');e.scrollIntoView({block:'center'});${a.kind==='click'?'e.click();':`if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e.isContentEditable))throw new Error('该元素不能填写');e.focus();if(e.isContentEditable)e.textContent=${JSON.stringify(a.text)};else{const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set;setter.call(e,${JSON.stringify(a.text)})}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`}return {ok:true}})()`
   await wc.executeJavaScriptInIsolatedWorld(999,[{code}]);w.snapshotId=undefined
  }else throw new Error('浏览器操作无效')
  return this.state(key)
 }
 async input(key,a,frame){const b=this.browsers.get(key);if(!b)throw new Error('浏览器未打开');const w=this.current(b),wc=w.webContents,size=w.getContentSize();w.snapshotId=undefined
  const point=(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=frame.width||y>=frame.height)throw new Error('输入超出画面');return {x:Math.floor(x*size[0]/frame.width),y:Math.floor(y*size[1]/frame.height)}}
  if(a.kind==='text')await wc.insertText(a.text)
  else if(a.kind==='key'){const keyCode=({Return:'Enter',BackSpace:'Backspace',Up:'Up',Down:'Down',Left:'Left',Right:'Right',space:'Space'}[a.key]??a.key),modifiers=(a.modifiers??[]).map(m=>({ctrl:'control',alt:'alt',shift:'shift',super:'meta'}[m]));wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers})}
  else if(a.kind==='click'){const p=point(a.x,a.y),button=a.button??'left',clickCount=a.count??1;wc.sendInputEvent({type:'mouseMove',...p});wc.sendInputEvent({type:'mouseDown',...p,button,clickCount});wc.sendInputEvent({type:'mouseUp',...p,button,clickCount})}
  else if(a.kind==='drag'){const start=point(a.fromX,a.fromY),end=point(a.toX,a.toY);wc.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseMove',...end,modifiers:['leftButtonDown']});wc.sendInputEvent({type:'mouseUp',...end,button:'left',clickCount:1})}
  else if(a.kind==='scroll'){const amount=(a.amount??3)*80;wc.sendInputEvent({type:'mouseWheel',x:Math.floor(size[0]/2),y:Math.floor(size[1]/2),deltaX:a.direction==='left'?-amount:a.direction==='right'?amount:0,deltaY:a.direction==='up'?-amount:a.direction==='down'?amount:0,canScroll:true})}
  else throw new Error('浏览器输入无效')
  return {ok:true}
 }
 async close(){for(const b of this.browsers.values())for(const w of b.tabs.values())w.destroy();this.browsers.clear();for(const s of this.sessions.values()){s.flushStorageData();await s.cookies.flushStore();if(!s.isPersistent())await s.clearStorageData()}this.sessions.clear()}
}
