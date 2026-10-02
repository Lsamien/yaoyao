import {CredentialAdapterExecutor} from './adapterExecutor.js'
import {HttpError} from '../errors.js'

/** Trusted server execution; it does not claim protection from same-UID shells.
 * The broker enforces owner, session, task, revision and one-use leases. */
export class LocalCredentialExecutor extends CredentialAdapterExecutor {
  readonly mode='local-adapters' as const
  private readonly lifetime:{closed:boolean}
  constructor(home:string,testCA?:Buffer){
    const lifetime={closed:false}
    super(home,{assert(){if(lifetime.closed)throw new HttpError(503,'本机凭据执行器已关闭','vault_executor_unavailable')}},testCA)
    this.lifetime=lifetime
  }
  close(){this.lifetime.closed=true}
}
