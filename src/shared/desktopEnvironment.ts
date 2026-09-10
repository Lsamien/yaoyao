import type {WorkspaceAgent} from './workspace.js'
export interface DesktopEnvironmentState {
 online:boolean
 host:{name:string;platform:string}|null
 local:{supported:boolean;authorized:boolean;screen:boolean;accessibility:boolean;ready:boolean}
 browser:{available:boolean;profile:'persistent'|'temporary'}
 selected:'local'|'browser'|null
 agent:WorkspaceAgent
}
export interface BotBrowserState {open:boolean;profile:string;tabs:{id:string;title:string;url:string;active:boolean}[]}
