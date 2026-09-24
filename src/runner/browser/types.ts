import type {BrowserContext,LaunchOptions} from 'playwright'

export interface BrowserScope {ownerKey:string;environmentId:string;profile:'persistent'|'temporary'}
export interface BrowserUpload {name:string;mimeType:string;buffer:Buffer}
export interface BrowserDownload {id:string;name:string;mimeType:string;size:number;sha256:string;url:string;createdAt:number}
export interface BrowserState {open:boolean;generation:number;profile:'persistent'|'temporary';tabs:{id:string;url:string;title:string;active:boolean}[];downloads:BrowserDownload[]}
export interface BrowserLauncher {
  launchPersistentContext(directory:string,options:LaunchOptions & {acceptDownloads:boolean;viewport:{width:number;height:number};serviceWorkers:'block'}):Promise<BrowserContext>
}
export type BrowserAction=
  |{kind:'state'|'downloads'|'snapshot'|'screenshot'|'back'|'forward'|'reload'}
  |{kind:'navigate'|'new-tab';url:string}
  |{kind:'select-tab'|'close-tab';tabId:string}
  |{kind:'click';snapshotId:string;ref:string}
  |{kind:'fill';snapshotId:string;ref:string;text:string}
  |{kind:'upload';snapshotId:string;ref:string;fileId:string}
  |{kind:'coordinate';x:number;y:number;button?:'left'|'right'|'middle';clickCount?:1|2}
  |{kind:'key';key:string}
  |{kind:'text';text:string}
  |{kind:'scroll';deltaX?:number;deltaY:number}
export interface BrowserOperation {generation:number;operationId:string;action:BrowserAction}
export interface BrowserCallContext {authorize:()=>void|Promise<void>;signal?:AbortSignal}
export class BrowserRuntimeError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='BrowserRuntimeError'}
}
