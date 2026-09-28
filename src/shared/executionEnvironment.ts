/** Default execution target only; environment and resource grants are independent. */
export type ExecutionMode = 'none' | 'server' | 'virtual'
export interface ExecutionSelection {
  mode: ExecutionMode
  revision: number
  /** Compatibility hint for the default target, never a filter on resource grants. */
  credentialSource: 'native' | 'yaoyao'
}
export interface VmProxySettings { enabled: boolean; protocol: 'http' | 'socks5'; host: string; port: number; username: string; password?: string; revision: number }
export interface TaskEnvironment { variables: Record<string,string>; files: Array<{name:string;content:string;envKey:string}> }
export interface CodexAuthorizationAttempt {
  id:string; status:'starting'|'pending'|'authorized'|'failed'|'expired'|'cancelled'
  expiresAt:number; loginUrl?:string; userCode?:string; error?:string
}
export interface SystemResourceSummary {
  id:string; name:string; kind:'variables'|'api'|'codex'; revision:number; agentIds:string[]
  envKeys:string[]; tokenEnv?:string; baseUrl?:string; configured:boolean
}
export interface ExecutionSettingsView {
  execution:ExecutionSelection
  proxy:Omit<VmProxySettings,'password'> & {hasPassword:boolean}
  resources:SystemResourceSummary[]
  agents:Array<{id:string;name:string;owner:string}>
  nodes:Array<{id:string;name:string;online:boolean;status:string}>
  activeTurns:Array<{agentId:string;mode:ExecutionMode;revision:number}>
}
