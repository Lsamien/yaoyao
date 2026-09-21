import {HttpError} from '../../server/errors.js'
import {ComputerError} from './container.js'

/** Environment/pool failures that should become tool results, not hard run kills. */
export const SOFT_COMPUTER_CODES = new Set([
  'computer_busy',
  'computer_quota',
  'computer_pool_unavailable',
  'computer_image_required',
  'computer_unavailable',
  'computer_stop_uncertain',
  'computer_owner_mismatch',
  'computer_spec_invalid',
  'computer_authorization_revoked',
  'compose_desktop_error',
  'compose_desktop_managed',
])

export function softComputerFailure(error:unknown){
  if(error instanceof ComputerError)return true
  if(error instanceof HttpError)return SOFT_COMPUTER_CODES.has(error.code??'')
  return false
}

export function needsVmLease(name:string,teamToolNames:string[]=[],skillToolNames:string[]=[]){
  if(name.startsWith('host_'))return false
  if(teamToolNames.includes(name))return false
  return name.startsWith('computer_')||skillToolNames.includes(name)
}
