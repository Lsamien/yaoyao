// @vitest-environment node
import {expect,it} from 'vitest'
import {buildWorkspaceEnvironment,workspaceEnvironmentTools} from '../../src/server/workspaceEnvironment'
import {parseHostTools} from '../../src/server/hostToolSettings'
import {deviceInventoryText,type DesktopEnvironmentSnapshot} from '../../src/shared/botEnvironment'
import type {WorkspaceAgent} from '../../src/shared/workspace'
const agent:WorkspaceAgent={id:'bot',name:'Bot',avatar:'',instructions:'',nodeId:'local',profile:'default',archived:false,revision:1,createdAt:1,updatedAt:1}
const desktop:DesktopEnvironmentSnapshot={capturedAt:10,sourceHost:'local',hosts:[{id:'local',target:'server',name:'服务器',kind:'server',source:true,online:true,open:true,
 capabilities:{view:{enabled:true,status:'human_control'},input:{enabled:true,status:'human_control'},fileRead:{enabled:false,status:'not_authorized'},fileWrite:{enabled:false,status:'not_authorized'},shell:{enabled:false,status:'not_authorized'},fileTransfer:{enabled:false,status:'not_authorized'}},transfer:{protocol:'legacy',readMaxMiB:12,writeMaxMiB:10}}]}
it('requires both explicit browser policy and a capable Runner, without enabling VM or the retired host browser',()=>{
 const make=(enabled:boolean,available:boolean)=>workspaceEnvironmentTools(buildWorkspaceEnvironment({agent,globals:parseHostTools({managedBrowser:enabled,vm:false}),desktop,bridge:true,cloud:false,plugins:false,managedBrowser:available})).map(tool=>tool.id)
 expect(make(false,true)).not.toContain('managed_browser_open')
 expect(make(true,false)).not.toContain('managed_browser_open')
 expect(make(true,true)).toContain('managed_browser_open')
 expect(make(true,true)).not.toContain('computer_shell')
 expect(make(true,true)).not.toContain('managed_browser_to_vm')
 expect(make(true,true)).not.toContain('desktop_browser')
})
it('mounts only granted desktop capabilities while distinguishing human control and deferred virtual environments',()=>{
 const env=buildWorkspaceEnvironment({agent,globals:parseHostTools({}),desktop,bridge:true,cloud:false,plugins:false})
 const names=workspaceEnvironmentTools(env).map(tool=>tool.id)
 expect(names).toContain('desktop_environment_view')
 expect(names).not.toContain('desktop_shell')
 expect(names).toContain('computer_shell')
 expect(names).not.toContain('cloud_computer_shell')
 expect(env.virtual.vm.status).toBe('on_demand')
 expect(env.virtual.cloud.status).toBe('not_configured')
 expect(deviceInventoryText(env.desktop)).toContain('等待人工交还')
 expect(env.cwd).toBeUndefined()
})
it('captures policy and file limits rather than observing later settings mutations',()=>{
 const globals=parseHostTools({fileTransferMaxMiB:60,cloud:false,vm:false})
 const facts=structuredClone(desktop)
 for(const cap of Object.values(facts.hosts[0]!.capabilities))Object.assign(cap,{enabled:true,status:'ready'})
 const env=buildWorkspaceEnvironment({agent,globals,desktop:facts,bridge:true,cloud:true,plugins:false})
 globals.fileTransferMaxMiB=1;globals.vm=true
 const names=workspaceEnvironmentTools(env)
 expect(names.find(tool=>tool.id==='desktop_file_copy')?.description).toContain('60 MiB')
 expect(names.some(tool=>tool.id==='computer_shell')).toBe(false)
 expect(env.virtual.vm.status).toBe('disabled')
 expect(env.virtual.cloud.status).toBe('disabled')
})
it('does not expose computer tools for an unavailable Bot or missing bridge',()=>{
 const env=buildWorkspaceEnvironment({agent:{...agent,archived:true},globals:parseHostTools({}),desktop,bridge:false,cloud:true,plugins:false})
 expect(workspaceEnvironmentTools(env)).toEqual([])
 expect(env.virtual.vm.status).toBe('bridge_unavailable')
})
