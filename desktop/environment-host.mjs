import {app,desktopCapturer,dialog,screen,shell,systemPreferences} from 'electron'
import {hostname} from 'node:os'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {request} from 'node:http'
import {execFile} from 'node:child_process'
import {BrowserEnvironment} from './browser-environment.mjs'

function exchange(record,body){return new Promise((resolve,reject)=>{const url=new URL('/desktop/environment',record.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')return reject(new Error('桌面服务地址无效'));const bytes=Buffer.from(JSON.stringify(body)),req=request(url,{method:'POST',headers:{'x-yaoyao-desktop-token':record.token,'content-type':'application/json','content-length':bytes.length}},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>256*1024)res.destroy(new Error('桌面命令超过限制'));else chunks.push(chunk)});res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('桌面服务未连接');resolve(JSON.parse(Buffer.concat(chunks)))}catch(error){reject(error)}})});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('桌面连接超时')));req.end(bytes)})}
export class DesktopEnvironmentHost {
 constructor({manager,root,dataRoot}){this.manager=manager;this.root=root;this.dataRoot=dataRoot;this.id=randomUUID();this.results=[];this.running=new Set();this.closed=false;this.browser=new BrowserEnvironment(join(dataRoot,'bot-browsers'));this.approved=new Set();this.permissionsFile=join(dataRoot,'computer-permissions.json');try{const list=JSON.parse(readFileSync(this.permissionsFile,'utf8'));if(Array.isArray(list))for(const key of list)if(/^[a-f0-9]{64}$/.test(key))this.approved.add(key)}catch{}this.frames=new Map()}
 info(){return {id:this.id,name:hostname(),platform:process.platform,screen:process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')==='granted',accessibility:process.platform==='darwin'&&systemPreferences.isTrustedAccessibilityClient(false),approved:[...this.approved]}}
 async revoke(){this.approved.clear();this.save();this.frames.clear();this.id=randomUUID()}
 save(){mkdirSync(this.dataRoot,{recursive:true,mode:0o700});writeFileSync(this.permissionsFile,JSON.stringify([...this.approved]),{mode:0o600})}
 async execute(c){const epoch=this.id;if(Date.now()>c.deadline||this.closed)throw new Error('桌面请求已过期');if(!/^[a-f0-9]{64}$/.test(c.owner))throw new Error('桌面请求身份无效')
  if(c.operation==='authorize'){
   if(process.platform!=='darwin')throw new Error('此电脑暂不支持本机控制')
   const {response}=await dialog.showMessageBox({type:'question',title:'授权本机控制',message:`允许夭夭账号「${String(c.account??'当前账号').slice(0,100)}」的机器人查看和操作这台 Mac？`,detail:'授权后，机器人和该账号的 Web、手机端可以查看屏幕，并在接管时操作鼠标和键盘。你可以在夭夭菜单中撤销。',buttons:['取消','允许并检查系统权限'],defaultId:0,cancelId:0})
   if(response!==1||Date.now()>c.deadline||this.closed||epoch!==this.id)throw new Error('本机控制授权已取消')
   this.approved.add(c.owner);this.save()
   if(!systemPreferences.isTrustedAccessibilityClient(false))systemPreferences.isTrustedAccessibilityClient(true)
   if(systemPreferences.getMediaAccessStatus('screen')!=='granted'){await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1,height:1}}).catch(()=>{});if(systemPreferences.getMediaAccessStatus('screen')!=='granted')await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}
   return {ok:true}
  }
  if(!['local','browser'].includes(c.mode)||!['persistent','temporary'].includes(c.profile)||!['open','view','input','browser','browser-state'].includes(c.operation))throw new Error('桌面命令无效')
  if(c.mode==='browser'){
   if(!/^[a-f0-9]{64}$/.test(c.resource))throw new Error('浏览器资源无效')
   if(c.operation==='browser-state')return this.browser.state(c.resource)
   if(c.operation==='open'){await this.browser.open(c.resource,c.profile);return {ok:true}}
   if(c.operation==='browser')return this.browser.action(c.resource,c.profile,c.action)
   if(c.operation==='view')return this.browser.view(c.resource)
   return this.browser.input(c.resource,c.action,c.frame)
  }
  const info=this.info();if(!info.approved.includes(c.owner)||!info.screen||!info.accessibility)throw new Error('请在桌面端授权，并在系统设置开启屏幕录制和辅助功能')
  if(c.operation==='open')return {ok:true}
  if(c.operation==='view'){const d=screen.getPrimaryDisplay(),sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1600,height:1200}}),source=sources.find(s=>s.display_id===String(d.id));if(!source||source.thumbnail.isEmpty())throw new Error('系统尚未允许读取屏幕');const dimensions=source.thumbnail.getSize();this.frames.set(c.resource,{display:d.id,...dimensions,bounds:d.bounds});return {data:source.thumbnail.toPNG().toString('base64'),...dimensions}}
  if(c.operation!=='input')throw new Error('本机操作无效')
  const f=this.frames.get(c.resource),d=screen.getPrimaryDisplay();if(!f||f.display!==d.id||JSON.stringify(f.bounds)!==JSON.stringify(d.bounds)||f.width!==c.frame?.width||f.height!==c.frame?.height)throw new Error('显示器已变化，请刷新画面')
  return new Promise((resolve,reject)=>{const child=execFile(join(this.root,app.isPackaged?'computer-helper':'computer-helper-dev'),[],{timeout:10000,maxBuffer:65536},(error,stdout,stderr)=>{if(error)reject(new Error(stderr.trim()||'系统未接受电脑输入'));else{try{resolve(JSON.parse(stdout))}catch{reject(new Error('电脑助手响应无效'))}}});child.stdin.end(JSON.stringify({action:c.action,frame:f}))})
 }
 async cycle(){if(this.closed)return;try{const record=await this.manager.readRecord();if(record){const verified=await this.manager.verify(record);record.url=verified.url;if(this.instance&&this.instance!==record.instanceId){this.results=[];this.id=randomUUID();await this.browser.close()}this.instance=record.instanceId;const sent=this.results.slice(),value=await exchange(record,{host:this.info(),results:sent});this.results.splice(0,sent.length);for(const c of value.commands??[]){if(this.running.has(c.id))continue;this.running.add(c.id);const epoch=this.id;void this.execute(c).then(value=>{if(epoch===this.id)this.results.push({id:c.id,value})},error=>{if(epoch===this.id)this.results.push({id:c.id,error:String(error.message).slice(0,500)})}).finally(()=>this.running.delete(c.id))}}}catch{}finally{if(!this.closed)this.timer=setTimeout(()=>void this.cycle(),400)}}
 start(){this.closed=false;void this.cycle()}
 async close(){this.closed=true;clearTimeout(this.timer);this.id=randomUUID();this.results=[];await this.browser.close()}
}
