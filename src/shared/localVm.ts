export type LocalVmMode = 'shared' | 'per-bot'
export type LocalVmAction = 'create' | 'start' | 'stop' | 'recreate' | 'remove'
export interface LocalVmStatus {
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
  container: 'missing' | 'stopped' | 'running'
  ready: boolean
  inUse: boolean
  mode: LocalVmMode
  maxInstances: number
  image: boolean
  problem?: string
}
