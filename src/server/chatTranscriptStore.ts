import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CHAT_TRANSCRIPT_FEATURE, type TranscriptEvent, type TranscriptMessage, type TranscriptSnapshot } from '../shared/chatTranscript.js'

/** A versioned display projection and replay log in the chat cache transaction. */
export class ChatTranscriptStore {
  // Opt in until the three clients finish end-to-end transcript validation.
  readonly enabled = process.env.HERMES_YAOYAO_ORDINARY_TRANSCRIPTS === '1'
  readonly epoch: string
  private listeners = new Set<() => void>()
  private scheduled = false
  private closed = false
  constructor(readonly db: DatabaseSync,readonly enrich:(owner:string,profile:string,sessionId:string,rows:Record<string,any>[])=>Record<string,any>[] = (_o,_p,_s,rows)=>rows) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_transcript_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_transcript_scopes(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_transcript_execution(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_transcript_messages(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,
        id TEXT NOT NULL,seq INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner,profile,session_id,id));
      CREATE INDEX IF NOT EXISTS chat_transcript_order ON chat_transcript_messages(owner,profile,session_id,seq);
      CREATE TABLE IF NOT EXISTS chat_transcript_aliases(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,
        source TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id,source));
      CREATE TABLE IF NOT EXISTS chat_transcript_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,
        profile TEXT NOT NULL,session_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_transcript_replay ON chat_transcript_events(owner,profile,session_id,cursor);`)
    db.prepare("INSERT OR IGNORE INTO chat_transcript_meta VALUES('epoch',?)").run(randomUUID())
    this.epoch = String(db.prepare("SELECT value FROM chat_transcript_meta WHERE key='epoch'").get()!.value)
  }
  close() { this.closed=true; this.listeners.clear() }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() {
    if (this.scheduled || this.closed) return
    this.scheduled=true
    // All enclosing cache savepoints finish synchronously. Read committed log
    // rows in subscribers; a rolled-back notification therefore emits nothing.
    queueMicrotask(() => { this.scheduled=false; if(!this.closed) for(const listener of this.listeners) { try{listener()}catch{} } })
  }
  private event(owner:string,profile:string,sessionId:string,type:TranscriptEvent['type'],data:unknown) {
    this.db.prepare('INSERT INTO chat_transcript_events(owner,profile,session_id,type,data,created_at) VALUES(?,?,?,?,?,?)')
      .run(owner,profile,sessionId,type,JSON.stringify(data),Date.now())
    this.notify()
  }
  private alias(owner:string,profile:string,sessionId:string,key:string):string|undefined {
    return (this.db.prepare('SELECT id FROM chat_transcript_aliases WHERE owner=? AND profile=? AND session_id=? AND source=?')
      .get(owner,profile,sessionId,key) as {id:string}|undefined)?.id
  }
  promote(owner:string,profile:string,sessionId:string,oldSource:string,newSource:string) {
    const id=this.alias(owner,profile,sessionId,`source:${oldSource}`)
    if(id&&!this.alias(owner,profile,sessionId,`source:${newSource}`)) this.db.prepare('INSERT INTO chat_transcript_aliases VALUES(?,?,?,?,?)').run(owner,profile,sessionId,`source:${newSource}`,id)
  }
  upsert(owner:string,profile:string,sessionId:string,source:Record<string,any>,position:number) {
    const sourceID=String(source.id??source.message_id??'')
    if(!sourceID)return
    const keys=[`source:${sourceID}`]
    if(source.role==='user'&&source.client_message_id)keys.unshift(`client:${source.client_message_id}`)
    if(source.role==='tool'&&source.tool_call_id)keys.unshift(`tool:${source.tool_call_id}`)
    const id=keys.map(key=>this.alias(owner,profile,sessionId,key)).find(Boolean)??randomUUID()
    for(const duplicate of new Set(keys.map(key=>this.alias(owner,profile,sessionId,key)).filter((value):value is string=>!!value&&value!==id))){
      const old=this.db.prepare('SELECT revision,deleted FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND id=?').get(owner,profile,sessionId,duplicate) as {revision:number;deleted:number}|undefined
      this.db.prepare('UPDATE chat_transcript_aliases SET id=? WHERE owner=? AND profile=? AND session_id=? AND id=?').run(id,owner,profile,sessionId,duplicate)
      if(old&&!old.deleted){this.db.prepare('UPDATE chat_transcript_messages SET deleted=1,revision=revision+1 WHERE owner=? AND profile=? AND session_id=? AND id=?').run(owner,profile,sessionId,duplicate);this.event(owner,profile,sessionId,'message.deleted',{id:duplicate,revision:old.revision+1})}
    }
    const row=this.db.prepare('SELECT data,revision,deleted FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND id=?')
      .get(owner,profile,sessionId,id) as {data:string;revision:number;deleted:number}|undefined
    const old:TranscriptMessage|undefined=row?JSON.parse(row.data):undefined
    const next:TranscriptMessage={...source,id,source_message_id:sourceID,seq:position+1,revision:row?.revision??0,
      role:String(source.role??'assistant'),content:source.content??'',reasoning:String(source.reasoning??source.reasoning_content??'')}
    if(!next.client_message_id&&old?.client_message_id)next.client_message_id=old.client_message_id
    for(const key of keys)this.db.prepare('INSERT INTO chat_transcript_aliases VALUES(?,?,?,?,?) ON CONFLICT(owner,profile,session_id,source) DO UPDATE SET id=excluded.id').run(owner,profile,sessionId,key,id)
    if(old&&!row?.deleted&&JSON.stringify(old)===JSON.stringify(next))return
    next.revision++
    this.db.prepare('INSERT INTO chat_transcript_messages VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(owner,profile,session_id,id) DO UPDATE SET seq=excluded.seq,revision=excluded.revision,data=excluded.data,deleted=0')
      .run(owner,profile,sessionId,id,next.seq,next.revision,JSON.stringify(next))
    let patch:Record<string,unknown>|undefined
    if(old&&!row?.deleted&&old.status==='streaming'&&next.status==='streaming'&&typeof old.content==='string'&&typeof next.content==='string'
      &&next.content.startsWith(old.content)&&next.reasoning!.startsWith(String(old.reasoning??''))){
      const {content:a,reasoning:b,revision:c,...oldMeta}=old
      const {content:d,reasoning:e,revision:f,...newMeta}=next
      if(JSON.stringify(oldMeta)===JSON.stringify(newMeta))patch={id,seq:next.seq,baseRevision:old.revision,revision:next.revision,
        contentAppend:next.content.slice(old.content.length),reasoningAppend:next.reasoning!.slice(String(old.reasoning??'').length)}
    }
    this.event(owner,profile,sessionId,patch?'message.patch':'message.upsert',patch??next)
  }
  reconcile(owner:string,profile:string,sessionId:string) {
    const rows=this.db.prepare('SELECT data,position FROM chat_messages WHERE owner=? AND profile=? AND session_id=? ORDER BY position').all(owner,profile,sessionId) as {data:string;position:number}[]
    const live=new Set<string>()
    const enriched=this.enrich(owner,profile,sessionId,rows.map(row=>JSON.parse(row.data)))
    for(const [index,row] of rows.entries()){const source=enriched[index]!;this.upsert(owner,profile,sessionId,source,row.position);const id=this.alias(owner,profile,sessionId,`source:${source.id??source.message_id}`);if(id)live.add(id)}
    for(const row of this.db.prepare('SELECT id,revision FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0').all(owner,profile,sessionId) as {id:string;revision:number}[]){
      if(live.has(row.id))continue
      this.db.prepare('UPDATE chat_transcript_messages SET deleted=1,revision=revision+1 WHERE owner=? AND profile=? AND session_id=? AND id=?').run(owner,profile,sessionId,row.id)
      this.event(owner,profile,sessionId,'message.deleted',{id:row.id,revision:row.revision+1})
    }
  }
  seed(owner:string,profile:string,sessionId:string) {
    if(this.db.prepare('SELECT 1 FROM chat_transcript_scopes WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionId))return
    this.reconcile(owner,profile,sessionId)
    this.db.prepare('INSERT INTO chat_transcript_scopes VALUES(?,?,?)').run(owner,profile,sessionId)
  }
  sessionChanged(owner:string,profile:string,sessionId:string,data:Record<string,unknown>) {
    const row=this.db.prepare('SELECT data FROM chat_transcript_execution WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionId) as {data:string}|undefined
    const state=row?JSON.parse(row.data):{running:false,queued:false,pending:{}}
    const p=(data.payload??{}) as Record<string,any>,type=String(data.eventType)
    state.pending??={}
    if(type==='command.submitted'){state.pending[p.delivery_id]=state.running;state.queued=state.running;state.running=true}
    if(type==='command.confirmed'||type==='command.rejected'){
      if(type==='command.rejected')state.running=state.pending[p.delivery_id]??state.running
      else{state.running=true;state.queued=p.status==='queued'}
      delete state.pending[p.delivery_id]
    }
    if(['message.start','run.started','approval.request','clarify.request'].includes(type))state.running=true
    if(type==='route.resumed'&&typeof p.running==='boolean')state.running=p.running
    if(['message.complete','run.completed','run.failed','error'].includes(type)){
      state.queued=Number(p.queue_remaining??p.queueRemaining??0)>0
      state.running=state.queued||Number(p.background_pending??p.backgroundPending??0)>0
    }
    this.db.prepare('INSERT INTO chat_transcript_execution VALUES(?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET data=excluded.data').run(owner,profile,sessionId,JSON.stringify(state))
    this.event(owner,profile,sessionId,'session.changed',{...data,running:state.running,queued:state.queued})
  }
  migrate(owner:string,profile:string,oldID:string,newID:string) {
    for(const table of ['chat_transcript_messages','chat_transcript_aliases','chat_transcript_scopes','chat_transcript_execution'])this.db.prepare(`UPDATE ${table} SET session_id=? WHERE owner=? AND profile=? AND session_id=?`).run(newID,owner,profile,oldID)
    this.event(owner,profile,oldID,'session.migrated',{sessionId:newID})
  }
  remove(owner:string,profile:string,sessionId:string) {
    this.event(owner,profile,sessionId,'session.deleted',{sessionId})
    for(const table of ['chat_transcript_messages','chat_transcript_aliases','chat_transcript_scopes','chat_transcript_execution'])this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND profile=? AND session_id=?`).run(owner,profile,sessionId)
  }
  cursor(owner:string,profile:string,sessionId:string):number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(cursor),0) cursor FROM chat_transcript_events WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionId)!.cursor)
  }
  events(owner:string,profile:string,sessionId:string,after:number,limit=250):TranscriptEvent[] {
    return (this.db.prepare('SELECT cursor,type,data FROM chat_transcript_events WHERE owner=? AND profile=? AND session_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(owner,profile,sessionId,after,limit) as {cursor:number;type:TranscriptEvent['type'];data:string}[])
      .map(row=>({...row,profile,sessionId,data:JSON.parse(row.data)}))
  }
  snapshot(owner:string,profile:string,sessionId:string,session:Record<string,unknown>,state:string,before=Number.MAX_SAFE_INTEGER,limit=150):TranscriptSnapshot {
    const execution=this.db.prepare('SELECT data FROM chat_transcript_execution WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionId) as {data:string}|undefined
    const run=execution?JSON.parse(execution.data):{}
    const rows=this.db.prepare('SELECT data FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0 AND seq<? ORDER BY seq DESC,id DESC LIMIT ?')
      .all(owner,profile,sessionId,before,limit+1) as {data:string}[]
    return {protocol:CHAT_TRANSCRIPT_FEATURE,epoch:this.epoch,cursor:this.cursor(owner,profile,sessionId),profile,sessionId,running:run.running,queued:run.queued,
      messages:rows.slice(0,limit).reverse().map(row=>JSON.parse(row.data)),session,state,
      deletedIds:(this.db.prepare('SELECT id FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=1').all(owner,profile,sessionId) as {id:string}[]).map(row=>row.id),
      hasOlder:rows.length>limit||(rows.length>0&&Number(JSON.parse(rows[Math.min(limit,rows.length)-1]!.data).seq)>1),
      total:Number(this.db.prepare('SELECT COUNT(*) n FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0').get(owner,profile,sessionId)!.n)}
  }
}
