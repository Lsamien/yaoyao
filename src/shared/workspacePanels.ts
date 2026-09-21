export interface WorkspaceInspectorEntry {
  id:string; at:number; agentId:string; runId:string; taskId?:string
  direction:'request'|'response'|'event'|'error'; method:string; requestId?:string; durationMs?:number; data:unknown
}
export interface WorkspaceSchedule {
  kind:'once'|'interval'|'daily'|'weekly'; timezone:string
  at?:number; everyMinutes?:number; time?:string; weekdays?:number[]
}
export interface WorkspaceRoutine {
  deviceHost?:string
  id:string; agentId:string; name:string; prompt:string; enabled:boolean; schedule:WorkspaceSchedule
  nextAt?:number; lastAt?:number; createdAt:number; updatedAt:number
}
export interface WorkspaceRoutineRun {
  id:string; routineId:string; agentId:string; scheduledAt:number; startedAt:number
  status:'queued'|'running'|'waiting'|'complete'|'failed'|'interrupted'|'uncertain'|'skipped'
  conversationId?:string; runId?:string; error?:string
}
