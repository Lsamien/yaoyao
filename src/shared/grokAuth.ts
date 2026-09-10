export interface GrokAuthAttempt {
  id:string
  status:'pending'|'complete'|'cancelled'|'expired'|'failed'
  loginUrl?:string
  expiresAt:number
  error?:string
}
export interface GrokAuthSnapshot {
  configured:boolean
  status:'disconnected'|'connected'|'refreshing'|'reauthorization-required'
  account?:{email?:string;name?:string}
  expiresAt?:number
  automaticRefresh:boolean
  version:string
  error?:string
  attempt?:GrokAuthAttempt
}
