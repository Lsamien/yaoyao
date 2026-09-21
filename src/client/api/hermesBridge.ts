import {apiRequest} from './client'
import type {HermesBridgeStatus,HermesBridgeInstallResult,HermesDashboardRestartResult} from '@shared/hermesBridge'

export const getHermesBridgeStatus=()=>apiRequest<HermesBridgeStatus>('/api/app/admin/hermes-bridge',{timeoutMs:45000})
export const installHermesBridge=(profile:string,enable=false)=>apiRequest<HermesBridgeInstallResult>('/api/app/admin/hermes-bridge/install',{
  method:'POST',body:{profile,enable},timeoutMs:60000,
})
export const restartHermesDashboard=()=>apiRequest<HermesDashboardRestartResult>('/api/app/admin/hermes-bridge/restart',{
  method:'POST',body:{},timeoutMs:120000,
})
