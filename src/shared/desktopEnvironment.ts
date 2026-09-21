import type {WorkspaceAgent} from './workspace.js'
export interface DesktopHostStatus {
  id:string
  name:string
  platform:string
  online:boolean
  local:{supported:boolean;authorized:boolean;screen:boolean;accessibility:boolean;ready:boolean;fullAuthorized:boolean}
  browser:{available:boolean}
}
export interface DesktopEnvironmentState {
 online:boolean
 /** The computer this agent resolves to; id is 'local' or a paired desktop-host id. */
 host:{id:string;name:string;platform:string}|null
 local:{supported:boolean;authorized:boolean;screen:boolean;accessibility:boolean;ready:boolean;fullAuthorized:boolean}
 browser:{available:boolean;profile:'persistent'|'temporary'}
 selected:'local'|'browser'|null
 agent:WorkspaceAgent
 /** Every connected computer, for the machine picker. */
 hosts:DesktopHostStatus[]
}
export interface BotBrowserState {open:boolean;profile:string;tabs:{id:string;title:string;url:string;active:boolean}[]}
