import {apiRequest} from './client'
import type {HermesBridgeStatus,HermesBridgeInstallResult} from '@shared/hermesBridge'

export const getHermesBridgeStatus=()=>apiRequest<HermesBridgeStatus>('/api/app/admin/hermes-bridge',{timeoutMs:45000})
export const installHermesBridge=(profile:string,enable=false)=>apiRequest<HermesBridgeInstallResult>('/api/app/admin/hermes-bridge/install',{
  method:'POST',body:{profile,enable},timeoutMs:60000,
})
