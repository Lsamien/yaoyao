export type LocalVmMode = 'shared' | 'per-bot'
export type LocalVmAction = 'create' | 'start' | 'stop' | 'recreate' | 'remove'
export interface LocalVmStatus {
  fixedCapacity?:boolean
  desktops?:Array<{id:string;name:string;online:boolean;ready:boolean;available?:boolean}>
  executionHost?: 'server' | 'runner'
  runnerName?: string
  setupRequired?: 'runner' | 'worker'
  configured: boolean
  runtime?: 'docker' | 'podman'
  daemonUp: boolean
  image: boolean
  imageId?: string
  mode: LocalVmMode
  maxInstances: number
  busy: boolean
  problem?: string
  job?: { id: string; state: 'running' | 'complete' | 'failed'; message: string }
  instances?: Array<{id:string;status:string;name?:string;orphaned?:boolean}>
}
export interface LocalVmInstance {
  desktopId?:string
  fixedCapacity?:boolean
  desktops?:Array<{id:string;name:string;online:boolean;ready:boolean;available?:boolean}>
  container: 'missing' | 'stopped' | 'running'
  ready: boolean
  inUse: boolean
  mode: LocalVmMode
  maxInstances: number
  image: boolean
  problem?: string
}
