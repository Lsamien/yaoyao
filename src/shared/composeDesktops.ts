export interface ComposeDesktop {id:string;name:string;socketPath:string}
export interface ComposeDesktopState {id:string;name:string;online:boolean;ready:boolean}
export interface DesktopRelay {
  (id:string,operation:string,body:Record<string,unknown>):Promise<any>
}
export const COMPOSE_DESKTOP_IMAGE='sha256:'+'c'.repeat(64)
