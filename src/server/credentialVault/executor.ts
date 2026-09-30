import type { VaultEntry, LeaseInput } from './schema.js'
export type CredentialExecutionReceipt =
  | {status:'complete';operation:LeaseInput['operation'];exitCode?:number;bytes?:number;sha256?:string}
  | {status:'manual_takeover_required';reason:'unsupported_form_flow'|'usage_policy_required';submitted:boolean}
export interface CredentialExecutor {
  readonly mode?:'dummy-fixture'|'protected-adapters'
  assertAvailable?():void
  execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal):Promise<CredentialExecutionReceipt|void>
}
/** Supplied by the trusted boot path, never by the model or an RPC body. */
export interface IsolationGate { assert():void }
