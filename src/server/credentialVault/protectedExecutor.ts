import {CredentialAdapterExecutor} from './adapterExecutor.js'
/** Independent deployment still supplies the operator-approved isolation gate. */
export class ProtectedCredentialExecutor extends CredentialAdapterExecutor {
  readonly mode='protected-adapters' as const
}
