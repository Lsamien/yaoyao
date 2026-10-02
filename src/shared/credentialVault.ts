/** Public metadata only. Passwords, private keys and unlock material never belong here. */
export const CREDENTIAL_VAULT_PROTOCOL = 1
export type CredentialTarget =
  | { kind: 'website'; origin: string }
  | { kind: 'ssh'; host: string; port: number; hostKey?: string; auth?: 'privateKey' | 'password' }
export type CredentialOperation = 'website.login' | 'ssh.exec' | 'sftp.read' | 'sftp.write'
export type CredentialUseSummary =
  | { kind:'ssh.exec';mode:'unrestricted' }
  | { kind:'website.form';loginPath:string;submitPath:string;successPath:string;logoutPath?:string;formId:string;usernameName:string;passwordName:string;successSelector:string }
  | { kind:'ssh.exec';command:string }
  | { kind:'sftp.read';remotePath:string;maxBytes:number }
  | { kind:'sftp.write';remotePath:string;bytes:number }
export interface CredentialSummary {
  id: string; name: string; username: string; target: CredentialTarget
  revision: number; updatedAt: number
  usage?: Exclude<CredentialUseSummary,{mode:'unrestricted'}>
}
export interface CredentialLeaseSummary {
  id: string; credentialRef: string; agentId: string; workId: string
  runnerId: string; operation: CredentialOperation; expiresAt: number
}
export interface CredentialBotGrantSummary {
  credentialRef:string;agentId:string;name:string;operation:CredentialOperation
}
export interface CredentialBotReference {
  credentialRef:string;agentId?:string;name?:string;operation:CredentialOperation
  allowedTarget:CredentialTarget;allowedUse?:CredentialUseSummary;authorized?:boolean
}
export interface CredentialVaultStatus {
  protocol: 1; online: boolean; initialized: boolean; unlocked: boolean
  unlockExpiresAt?: number
  storageMode?: 'local'
  botGrants?:CredentialBotGrantSummary[]
  execution: 'disabled' | 'dummy-fixture' | 'protected-adapters' | 'local-adapters'; reason: 'executor_not_enabled' | 'vault_offline' | 'dummy_fixture_only' | 'operator_approved' | 'isolation_required' | 'local_controlled' | 'executor_unavailable'
  entries: CredentialSummary[]; leases: CredentialLeaseSummary[]
}
