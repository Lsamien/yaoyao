export type LocalVmMode = 'shared' | 'per-bot'
export const LOCAL_VM_IMAGE_KEYS = ['standard', 'cursor'] as const
export type LocalVmImageKey = typeof LOCAL_VM_IMAGE_KEYS[number]
export const LOCAL_VM_IMAGES = [
  {key:'standard',name:'标准桌面',description:'XFCE 桌面环境'},
  {key:'cursor',name:'Cursor Universal',description:'Debian 开发桌面 · amd64'},
] as const
export interface LocalVmImageOption {key:LocalVmImageKey;name:string;description:string;ready:boolean;imageId?:string}
export type LocalVmAction = 'create' | 'start' | 'stop' | 'recreate' | 'remove'
export interface LocalVmStatus {
  fixedCapacity?:boolean
  desktops?:Array<{id:string;name:string;online:boolean;ready:boolean;available?:boolean;imageKey?:LocalVmImageKey}>
  executionHost?: 'server' | 'runner'
  runnerName?: string
  setupRequired?: 'runner' | 'worker'
  configured: boolean
  runtime?: 'docker' | 'podman'
  daemonUp: boolean
  image: boolean
  imageId?: string
  images?: LocalVmImageOption[]
  mode: LocalVmMode
  maxInstances: number
  busy: boolean
  problem?: string
  job?: { id: string; state: 'running' | 'complete' | 'failed'; message: string; imageKey?: LocalVmImageKey }
  instances?: Array<{id:string;status:string;name?:string;orphaned?:boolean}>
}
export interface LocalVmInstance {
  desktopId?:string
  fixedCapacity?:boolean
  desktops?:Array<{id:string;name:string;online:boolean;ready:boolean;available?:boolean;imageKey?:LocalVmImageKey}>
  container: 'missing' | 'stopped' | 'running'
  ready: boolean
  inUse: boolean
  mode: LocalVmMode
  maxInstances: number
  image: boolean
  imageId?: string
  images?: LocalVmImageOption[]
  imageKey?: LocalVmImageKey
  problem?: string
}
