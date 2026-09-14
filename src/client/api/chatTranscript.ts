import { apiRequest } from './client'
import { SSEParser } from '@shared/sse'
import { applyTranscriptEvent, CHAT_TRANSCRIPT_FEATURE, TranscriptGap,
  type TranscriptEvent, type TranscriptMessage, type TranscriptSnapshot } from '@shared/chatTranscript'

export class ChatTranscriptClient {
  private abort = new AbortController()
  private messages: TranscriptMessage[] = []
  private cursor = 0
  private epoch = ''
  private snapshot?: TranscriptSnapshot
  private fetchingOlder = false
  constructor(readonly profile:string,readonly sessionId:string,
    readonly changed:(snapshot:TranscriptSnapshot)=>Promise<void>,readonly failed:(error:Error)=>void,
    readonly initialCount=150){}
  static async supported():Promise<boolean>{
    try{return (await apiRequest<{features:string[]}>('/api/app/chat/capabilities')).features.includes(CHAT_TRANSCRIPT_FEATURE)}catch{return false}
  }
  close(){this.abort.abort()}
  restore(value:TranscriptSnapshot){if(value.profile===this.profile&&value.sessionId===this.sessionId){this.snapshot=value;this.messages=value.messages;this.cursor=value.cursor;this.epoch=value.epoch}}
  private path(suffix:string,query:Record<string,string>={}) {return `/api/app/chat/sessions/${encodeURIComponent(this.sessionId)}/${suffix}?${new URLSearchParams({profile:this.profile,...query})}`}
  private async page(before?:number):Promise<TranscriptSnapshot>{
    const value=await apiRequest<TranscriptSnapshot>(this.path('snapshot',{limit:'150',...(before===undefined?{}:{before:String(before)})}),{signal:this.abort.signal})
    if(value.protocol!==CHAT_TRANSCRIPT_FEATURE||value.profile!==this.profile||value.sessionId!==this.sessionId)throw new TranscriptGap()
    return value
  }
  private async publish(){if(this.snapshot&&!this.abort.signal.aborted)await this.changed({...this.snapshot,messages:this.messages,cursor:this.cursor,epoch:this.epoch})}
  private async hydrate(){
    const page=await this.page()
    if(this.abort.signal.aborted)return
    const first=page.messages[0]?.seq??Infinity,deleted=new Set(page.deletedIds??[])
    const old=this.epoch===page.epoch?this.messages.filter(m=>m.seq<first&&!deleted.has(m.id)):[]
    this.messages=[...old,...page.messages];this.epoch=page.epoch;this.cursor=page.cursor;this.snapshot=page
    // Upgrade already loaded legacy pages before replacing the visible cache.
    while(this.messages.length<this.initialCount&&this.snapshot.hasOlder&&this.messages.length){
      const older=await this.page(this.messages[0]!.seq)
      if(older.epoch!==this.epoch)throw new TranscriptGap()
      const ids=new Set(this.messages.map(m=>m.id))
      const added=older.messages.filter(m=>!ids.has(m.id))
      this.messages=[...added,...this.messages];this.snapshot.hasOlder=older.hasOlder
      if(!added.length)break
    }
    await this.publish()
  }
  async loadOlder(){
    if(this.fetchingOlder||!this.snapshot?.hasOlder||!this.messages.length)return
    this.fetchingOlder=true
    try{
      const page=await this.page(this.messages[0]!.seq)
      if(page.epoch!==this.epoch)throw new TranscriptGap()
      const current=new Map(this.messages.map(m=>[m.id,m]))
      for(const message of page.messages)if((current.get(message.id)?.revision??0)<message.revision)current.set(message.id,message)
      this.messages=[...current.values()].sort((a,b)=>a.seq-b.seq||a.id.localeCompare(b.id));this.snapshot.hasOlder=page.hasOlder
      // A history page is not an event acknowledgement; never move cursor here.
      await this.publish()
    }finally{this.fetchingOlder=false}
  }
  async run(){
    let needsSnapshot=!this.snapshot
    while(!this.abort.signal.aborted){
      let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
      try{
        if(needsSnapshot){await this.hydrate();needsSnapshot=false}
        const response=await fetch(this.path('events'),{headers:{Accept:'text/event-stream','Last-Event-ID':`${this.epoch}:${this.cursor}`},credentials:'include',cache:'no-store',signal:this.abort.signal})
        if(response.status===409){needsSnapshot=true;throw new TranscriptGap()}
        if(!response.ok||!response.body)throw new Error(`聊天消息流 HTTP ${response.status}`)
        const parser=new SSEParser(),decoder=new TextDecoder();reader=response.body.getReader()
        while(!this.abort.signal.aborted){
          const {value,done}=await reader.read();if(done)break
          for(const frame of parser.feed(decoder.decode(value,{stream:true}))){
            if(frame.event==='reset')throw new TranscriptGap()
            if(frame.event!=='transcript')continue
            const event=JSON.parse(frame.data) as TranscriptEvent
            if(event.profile!==this.profile||event.sessionId!==this.sessionId||!Number.isSafeInteger(event.cursor))throw new TranscriptGap()
            if(event.cursor<=this.cursor)continue
            if(event.type==='session.deleted'||event.type==='session.migrated')throw new TranscriptGap()
            const data=event.data as {seq?:number}
            // Older, unloaded pages are read from their current snapshot later.
            if(!(event.type==='message.patch'&&data.seq!==undefined&&this.messages[0]&&data.seq<this.messages[0].seq))
              this.messages=applyTranscriptEvent(this.messages,event)
            if(this.snapshot&&event.type==='session.changed'){
              const detail=event.data as {eventType?:string;payload?:Record<string,unknown>;running?:boolean;queued?:boolean}
              this.snapshot.running=detail.running;this.snapshot.queued=detail.queued
              if(detail.eventType==='session.info'&&detail.payload)this.snapshot.session={...this.snapshot.session,...detail.payload}
            }
            const previous=this.cursor;this.cursor=event.cursor
            try{await this.publish()}catch(error){this.cursor=previous;throw error}
          }
        }
      }catch(error){
        if(this.abort.signal.aborted)return
        if(error instanceof TranscriptGap)needsSnapshot=true
        this.failed(error instanceof Error?error:new Error('聊天消息需要同步'))
      }finally{await reader?.cancel().catch(()=>{});reader?.releaseLock()}
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',finish);resolve()};const timer=setTimeout(finish,1000);this.abort.signal.addEventListener('abort',finish,{once:true});if(this.abort.signal.aborted)finish()})
    }
  }
}
