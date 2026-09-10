import {acquireServiceInstance} from '../../src/server/serviceInstance.js'
import type {ApplicationRuntime} from '../../src/server/app.js'
import {writeFileSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import electron from 'electron'
export function nativeEnvironmentFixture(runtime:ApplicationRuntime,home:string,port:number){
 const instance=acquireServiceInstance(home,'0.4.3');instance.publish(`http://127.0.0.1:${port}`)
 runtime.app.middleware.unshift(instance.middleware(async()=>{},()=>true,ctx=>runtime.desktopEnvironments.bridge(ctx)))
 const main=join(home,'native-main.mjs'),dataRoot=join(home,'native-data')
 writeFileSync(main,`import {app} from 'electron';app.setPath('userData',${JSON.stringify(dataRoot)});app.whenReady().then(async()=>{const {DesktopEnvironmentHost}=await import(${JSON.stringify(pathToFileURL(resolve('desktop/environment-host.mjs')).href)});const {DesktopServiceManager}=await import(${JSON.stringify(pathToFileURL(resolve('desktop/service-manager.mjs')).href)});const manager=new DesktopServiceManager({home:${JSON.stringify(home)}});manager.root=${JSON.stringify(realpathSync(home))};globalThis.host=new DesktopEnvironmentHost({manager,root:${JSON.stringify(resolve('.desktop-build'))},dataRoot:${JSON.stringify(dataRoot)}});globalThis.host.start();app.on('window-all-closed',()=>{});});`)
 const child=spawn(String(electron),[main],{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE')),stdio:'ignore'})
 return ()=>{child.kill('SIGTERM');instance.release()}
}
