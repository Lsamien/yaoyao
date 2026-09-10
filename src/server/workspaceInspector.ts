import Router from '@koa/router'
import {randomUUID} from 'node:crypto'
import type {WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceInspectorEntry} from '../shared/workspacePanels.js'

export function redactInspector(value:unknown,depth=0):unknown {
  if(depth>8)return '[深度限制]'
  if(typeof value==='string')return value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[已隐藏凭据]').replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi,'$1[已隐藏]').slice(0,16000)
  if(Array.isArray(value))return value.slice(0,80).map(v=>redactInspector(v,depth+1))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,80).map(([key,item])=>[key,/(?:authorization|cookie|password|secret|credential|access.?token|refresh.?token|api.?key|content_base64|data_url|sealed|tokenHash)/i.test(key)||key==='token'?'[已隐藏]':redactInspector(item,depth+1)]))
  return value
}
export class WorkspaceInspector {
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore){
    store.db.exec('CREATE TABLE IF NOT EXISTS workspace_inspector(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS workspace_inspector_scope ON workspace_inspector(owner,conversation_id,seq)')
  }
  record(owner:string,conversationId:string,entry:Omit<WorkspaceInspectorEntry,'id'|'at'>){
    try {
      const value={...entry,data:redactInspector(entry.data),id:randomUUID(),at:Date.now()}
      let data=JSON.stringify(value)
      if(Buffer.byteLength(data)>64000)data=JSON.stringify({...value,data:{truncated:true,preview:JSON.stringify(value.data).slice(0,14000)}})
      this.store.db.prepare('INSERT INTO workspace_inspector(owner,conversation_id,data) VALUES(?,?,?)').run(owner,conversationId,data)
      this.store.db.prepare('DELETE FROM workspace_inspector WHERE owner=? AND conversation_id=? AND seq NOT IN (SELECT seq FROM workspace_inspector WHERE owner=? AND conversation_id=? ORDER BY seq DESC LIMIT 2000)').run(owner,conversationId,owner,conversationId)
    }catch{ /* Inspection must never interrupt a running conversation. */ }
  }
  router(){
    const router=new Router()
    router.get('/api/app/conversations/:id/inspector',ctx=>{
      const owner=this.auth.require(ctx).id;this.store.require(owner,'conversation',ctx.params.id)
      const taskId=typeof ctx.query.taskId==='string'?ctx.query.taskId:undefined
      if(taskId)this.store.requireTask(owner,ctx.params.id,taskId)
      const entries=this.store.db.prepare('SELECT data FROM workspace_inspector WHERE owner=? AND conversation_id=? ORDER BY seq DESC LIMIT 2000').all(owner,ctx.params.id).map(row=>JSON.parse(String(row.data)) as WorkspaceInspectorEntry).reverse().filter(e=>!taskId||e.taskId===taskId).slice(-400)
      ctx.set('Cache-Control','no-store');ctx.body={entries,retention:2000}
    })
    return router
  }
}
