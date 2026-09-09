export const RUNNER_PROTOCOL = 1
export interface RunnerRecord {
  id: string
  name: string
  sourceNodeId: string
  sourceOwner: string
  allowedProfiles: string[]
  tokenHash: string
  enabled: boolean
  createdAt: number
}
export interface RunnerCommand {
  id: string
  kind: 'local-vm.manage' | 'computer.control' | 'computer.retire' | 'http' | 'gateway.open' | 'gateway.rpc' | 'gateway.close' | 'lease.create' | 'lease.bind' | 'lease.close'
  payload: Record<string, unknown>
  expiresAt: number
}
export interface RunnerConfiguration {
  protocol: 1
  serverURL: string
  runnerId: string
  token: string
  hermesURL: string
  allowedProfiles: string[]
  artifactRoots: string[]
  allowInsecureLan?: boolean
  computers?: {managedBy?:'compose';network?:'none'|'public-proxy';runtime:'docker'|'podman';imageId:string;python:string;hermesSource:string;hermesHome:string;maxConcurrent?:number}
  hermesCredentials?: {username:string;password:string}
}
export const UNCONFIGURED_COMPUTER_IMAGE='sha256:'+'0'.repeat(64)
