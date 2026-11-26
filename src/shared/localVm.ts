export type LocalVmMode = 'shared' | 'per-bot'
export const DEFAULT_VM_IDLE_STOP_MINUTES = 5
export const MAX_VM_IDLE_STOP_MINUTES = 10080
export const VM_IDLE_STOP_OPTIONS = [1, 5, 10, 15, 30, 60, 120, 0] as const
export function vmIdleStopLabel(minutes = DEFAULT_VM_IDLE_STOP_MINUTES) { return minutes === 0 ? '永不自动停止' : `空闲 ${minutes} 分钟后自动停止` }
export const LOCAL_VM_IMAGE_KEYS = ['standard', 'cursor'] as const
export type LocalVmImageKey = typeof LOCAL_VM_IMAGE_KEYS[number]
export const LOCAL_VM_IMAGES = [
  {key:'standard',name:'标准桌面',description:'XFCE 桌面环境'},
  {key:'cursor',name:'Cursor Universal',description:'Debian 开发桌面 · amd64'},
] as const
export interface LocalVmImageOption {key:LocalVmImageKey;name:string;description:string;ready:boolean;imageId?:string}
export type LocalVmAction = 'create' | 'start' | 'stop' | 'recreate' | 'remove'
/** Bot desktops one account computer may hold at once (displays 2..). */
export const MAX_DESKTOPS_PER_COMPUTER = 8
export interface LocalVmStatus {
  /** False in Docker deployments: they never run virtual machines. */
  supported?: boolean
  executionHost?: 'server' | 'runner'
  runnerName?: string
  setupRequired?: 'runner' | 'worker'
  configured: boolean
  runtime?: 'docker' | 'podman'
  daemonUp: boolean
  image: boolean
  imageId?: string
  images?: LocalVmImageOption[]
  /** Always `shared`: one computer per account, one desktop per Bot. */
  mode: LocalVmMode
  /** Account computers that may run at once on this server. */
  maxInstances: number
  /** Bot desktops per account computer. */
  maxDesktops?: number
  idleStopMinutes?: number
  busy: boolean
  problem?: string
  job?: { id: string; state: 'running' | 'complete' | 'failed'; message: string; imageKey?: LocalVmImageKey }
  instances?: Array<{id:string;status:string;name?:string;orphaned?:boolean;desktops?:number}>
}
export interface LocalVmInstance {
  idleStopMinutes?: number
  container: 'missing' | 'stopped' | 'running'
  /** This Bot's own desktop is running. */
  ready: boolean
  /** The account computer is healthy (independent of this Bot's desktop). */
  computerReady?: boolean
  desktop?: { display: number; running: boolean }
  /** Bot desktops assigned in this account computer, and the limit. */
  desktops?: number
  maxDesktops?: number
  inUse: boolean
  mode: LocalVmMode
  maxInstances: number
  image: boolean
  imageId?: string
  images?: LocalVmImageOption[]
  imageKey?: LocalVmImageKey
  problem?: string
}
