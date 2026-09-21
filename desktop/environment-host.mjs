import {app,desktopCapturer,dialog,screen,shell,systemPreferences} from 'electron'
import {hostname} from 'node:os'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {BrowserEnvironment} from './browser-environment.mjs'
import {listHostFiles,readHostFile,writeHostFile,receiveHostFile,execHostShell} from './host-files.mjs'
import {exchangeDesktopEnvironment as exchange} from './environment-exchange.mjs'
import {HostEnvironmentReporter} from './host-environment.mjs'
import {FileTransferFiles} from './file-transfer.mjs'

/** Command execution shared by the loopback server and remote computers. */
export class DesktopHostCore {
 constructor({root,dataRoot}){this.root=root;this.dataRoot=dataRoot;this.home=process.env.HOME||'/';this.environmentReporter=new HostEnvironmentReporter(this.home);this.id=randomUUID();this.results=[];this.running=new Set();this.closed=false;this.browser=new BrowserEnvironment(join(dataRoot,'bot-browsers'));this.approved=new Set();this.approvedFull=new Set();this.permissionsFile=join(dataRoot,'computer-permissions.json');try{const stored=JSON.parse(readFileSync(this.permissionsFile,'utf8'));const screen=Array.isArray(stored)?stored:stored.screen;const full=Array.isArray(stored)?[]:stored.full;if(Array.isArray(screen))for(const key of screen)if(/^[a-f0-9]{64}$/.test(key))this.approved.add(key);if(Array.isArray(full))for(const key of full)if(/^[a-f0-9]{64}$/.test(key))this.approvedFull.add(key)}catch{}this.frames=new Map()}
 transfers=new Map()
 info(){return {id:this.id,name:hostname(),platform:process.platform,screen:process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')==='granted',accessibility:process.platform==='darwin'&&systemPreferences.isTrustedAccessibilityClient(false),approved:[...this.approved],full:[...this.approvedFull],...this.environmentReporter.fields()}}
 acceptCapabilities(capabilities){this.environmentReporter.accept(capabilities)}
 async clearTransfers(){const transfers=[...this.transfers.values()];this.transfers.clear();await Promise.allSettled(transfers.map(transfer=>transfer.close()))}
 async revoke(){this.approved.clear();this.approvedFull.clear();this.save();this.frames.clear();this.id=randomUUID();await this.clearTransfers()}
 async recycle(){this.environmentReporter.reset();this.results=[];this.id=randomUUID();await this.clearTransfers();await this.browser.close()}
 save(){mkdirSync(this.dataRoot,{recursive:true,mode:0o700});writeFileSync(this.permissionsFile,JSON.stringify({screen:[...this.approved],full:[...this.approvedFull]}),{mode:0o600})}
 takeResults(){const sent=this.results.slice();this.results.splice(0,sent.length);return sent}
 async handle(commands){for(const c of commands??[]){if(this.running.has(c.id))continue;this.running.add(c.id);const epoch=this.id;void this.execute(c).then(value=>{if(epoch===this.id)this.results.push({id:c.id,value})},error=>{if(epoch===this.id)this.results.push({id:c.id,error:String(error.message).slice(0,500)})}).finally(()=>this.running.delete(c.id))}}
 async execute(c){const epoch=this.id;if(Date.now()>c.deadline||this.closed)throw new Error('桌面请求已过期');if(!/^[a-f0-9]{64}$/.test(c.owner))throw new Error('桌面请求身份无效')
  if(c.operation==='authorize'){
   if(process.platform!=='darwin')throw new Error('此电脑暂不支持本机控制')
   const full=c.scope==='full'
   const {response}=await dialog.showMessageBox({type:'question',title:full?'授权文件与命令':'授权本机控制',
    message:`允许夭夭账号「${String(c.account??'当前账号').slice(0,100)}」的机器人${full?'使用这台 Mac 的文件并执行命令':'查看和操作这台 Mac'}？`,
    detail:full?'机器人可以列出、读取和写入你用户主目录内的文件，并在这台 Mac 上执行 shell 命令。仅对信任的机器人开启；可随时在夭夭菜单中撤销。':'授权后，机器人和该账号的 Web、手机端可以查看屏幕，并在接管时操作鼠标和键盘。你可以在夭夭菜单中撤销。',
    buttons:full?['取消','允许文件与命令']:['取消','允许并检查系统权限'],defaultId:0,cancelId:0})
   if(response!==1||Date.now()>c.deadline||this.closed||epoch!==this.id)throw new Error(full?'文件与命令授权已取消':'本机控制授权已取消')
   if(full)this.approvedFull.add(c.owner);else this.approved.add(c.owner);this.save()
   if(full)return {ok:true}
   if(!systemPreferences.isTrustedAccessibilityClient(false))systemPreferences.isTrustedAccessibilityClient(true)
   if(systemPreferences.getMediaAccessStatus('screen')!=='granted'){await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1,height:1}}).catch(()=>{});if(systemPreferences.getMediaAccessStatus('screen')!=='granted')await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}
   return {ok:true}
  }
  if(c.operation==='file'||c.operation==='shell'){
   if(process.platform!=='darwin')throw new Error('此电脑暂不支持文件与命令')
   if(!this.approvedFull.has(c.owner))throw new Error('请在桌面端授权文件与命令访问')
   if(c.operation==='shell')return execHostShell(this.home,c.action)
   const action=c.action??{}
   if(typeof action.op==='string'&&action.op.startsWith('transfer-')){
    const key=c.owner+':'+c.resource
    let files=this.transfers.get(key)
    if(!files){files=new FileTransferFiles(this.home);this.transfers.set(key,files)}
    return files.call(action,()=>{if(this.closed||epoch!==this.id||!this.approvedFull.has(c.owner)||Date.now()>c.deadline)throw new Error('文件传输授权已失效')})
   }
   if(action.op==='list')return listHostFiles(this.home,action.path)
   if(action.op==='read')return readHostFile(this.home,action.path)
   if(action.op==='write')return writeHostFile(this.home,action)
   if(action.op==='receive')return receiveHostFile(this.home,action)
   throw new Error('文件操作无效')
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
 async close(){this.closed=true;await this.recycle()}
}

export class DesktopEnvironmentHost {
 constructor({manager,root,dataRoot}){this.manager=manager;this.core=new DesktopHostCore({root,dataRoot});this.closed=false;this.timer=undefined;this.instance=undefined}
 revoke(){return this.core.revoke()}
 async cycle(){if(this.closed)return;try{const record=await this.manager.readRecord();if(record){const verified=await this.manager.verify(record);record.url=verified.url;if(this.instance&&this.instance!==record.instanceId)await this.core.recycle();this.instance=record.instanceId;const value=await exchange(record,{host:this.core.info(),results:this.core.takeResults()});this.core.acceptCapabilities(value.capabilities);await this.core.handle(value.commands??[])}}catch{this.core.acceptCapabilities(undefined)}finally{if(!this.closed)this.timer=setTimeout(()=>void this.cycle(),400)}}
 start(){this.closed=false;this.core.closed=false;void this.cycle()}
 async close(){this.closed=true;clearTimeout(this.timer);await this.core.close()}
}
