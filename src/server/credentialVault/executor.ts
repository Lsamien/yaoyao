import type { VaultEntry, LeaseInput } from './schema.js'
export type CredentialExecutionReceipt =
  | {status:'complete';operation:'ssh.exec';exitCode:number;stdout:string;stderr:string;truncated:boolean}
  | {status:'complete';operation:LeaseInput['operation'];exitCode?:number;bytes?:number;sha256?:string}
  | {status:'manual_takeover_required';reason:'unsupported_form_flow'|'usage_policy_required';submitted:boolean}
export interface CredentialExecutor {
  readonly mode?:'dummy-fixture'|'protected-adapters'|'local-adapters'
  assertAvailable?():void
  prepareSshHost?(target:Extract<LeaseInput['target'],{kind:'ssh'}>,signal:AbortSignal):Promise<string>
  execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal):Promise<CredentialExecutionReceipt|void>
}
/** Supplied by the trusted boot path, never by the model or an RPC body. */
export interface IsolationGate { assert():void }
