/** Fetch the authority in the existing browser session; renderer count input is never trusted. */
export function installUnreadBadge({ ipcMain, app, owner, origins, url, quitting, fetch, interval = 3000 }) {
 let account=null,generation=0,poll,pending=false
 const badge=count=>{if(app.dock)app.dock.setBadge(count ? String(count) : '')}
 const clear=()=>{account=null;generation++;pending=false;clearInterval(poll);poll=undefined;badge(0)}
 const trusted=event=>{
  try{return !quitting()&&event.sender===owner()?.webContents&&event.senderFrame===owner().webContents.mainFrame&&origins().includes(new URL(event.senderFrame.url).origin)}catch{return false}
 }
 async function refresh(){
  if(!account||pending||quitting())return
  const current=generation,identity=account,origin=new URL(url()).origin;pending=true
  try{
   const options={credentials:'include',redirect:'error',cache:'no-store'}
   const auth=await fetch(`${origin}/api/app/bootstrap?csrfOnly=1`,options)
   if(!auth.ok)throw new Error('authentication required')
   const user=await auth.json()
   // auth-disabled local identity is represented as null by csrfOnly.
   if((user.userId??'local')!==identity){if(current===generation)clear();return}
   const response=await fetch(`${origin}/api/app/unread`,options)
   if([401,403].includes(response.status)){if(current===generation)clear();return}
   if(!response.ok)return
   const value=await response.json()
   if(current===generation&&account===identity&&origins().includes(origin)&&Number.isSafeInteger(value.total)&&value.total>=0)badge(value.total)
  }catch{ /* Offline preserves the last authenticated count. Navigation/logout clears immediately. */ }
  finally{if(current===generation)pending=false}
 }
 ipcMain.handle('desktop:unread-state',async(event,input)=>{
  if(!trusted(event))throw new Error('不允许此页面更新未读状态')
  if(input!==null&&(typeof input!=='string'||!input.trim()||input.length>256))throw new Error('无效账号范围')
  if(input===null){clear();return}
  if(account!==input){clear();account=input;poll=setInterval(()=>void refresh(),interval);poll.unref?.()}
  await refresh()
 })
 return { clear,refresh,stop(){clear();ipcMain.removeHandler('desktop:unread-state')} }
}
