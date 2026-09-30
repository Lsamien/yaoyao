import type { WorkspaceStore } from './workspaceStore.js'
import type { ChatCacheStore } from './chatCache.js'
import type { WorkspaceAgent, WorkspaceConversation } from '../shared/workspace.js'
import { emptyUnread, type UnreadSnapshot, type UnreadConversation } from '../shared/unread.js'
import { notificationPlainText } from './notificationText.js'

function messageTime(value:unknown):number {
 const numeric=Number(value);if(Number.isFinite(numeric))return numeric>0&&numeric<100_000_000_000?numeric*1000:numeric
 const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:0
}

export function unreadSnapshot(workspace:WorkspaceStore, cache:ChatCacheStore, owner:string,
  allowed:(node:string,profile:string)=>boolean = ()=>true):UnreadSnapshot {
  const result=emptyUnread()
  for(const c of workspace.list<WorkspaceConversation>(owner,'conversation')) {
    if(c.archived || !c.memberIds.every(id=>{const a=workspace.get<WorkspaceAgent>(owner,'agent',id);return !a || allowed(a.nodeId,a.profile)}))continue
    const messages=workspace.chatUnreadMessages(owner,c.id)
    if(!messages.length)continue
    result.conversations.push({mode:'bot',id:c.id,name:c.name,preview:notificationPlainText(messages.at(-1)!.content,{maximum:160,fallback:messages.at(-1)!.attachments[0]?.name ?? '附件'}),count:messages.length,
      updatedAt:messages.at(-1)!.createdAt,messages:messages.map(m=>({id:m.id,seq:m.seq,version:m.chatUnreadVersion,taskId:m.conversationTaskId}))})
  }
  for(const row of cache.unread(owner,'').sessions) {
    if(!allowed('local',row.profile))continue
    const stored=cache.db.prepare('SELECT s.data,l.archived FROM chat_sessions s LEFT JOIN chat_local_state l USING(owner,profile,session_id) WHERE s.owner=? AND s.profile=? AND s.session_id=?').get(owner,row.profile,row.session_id)
    if(!stored || stored.archived===1)continue
    const summary=JSON.parse(String(stored.data))
    if(summary.archived || summary.source==='yaoyao_workspace')continue
    const messages=cache.transcripts.unreadMessages(owner,row.profile,row.session_id)
    if(!messages.length)continue
    const last=messages.at(-1)!
    result.conversations.push({mode:'chat',id:row.session_id,profile:row.profile,name:summary.title || summary.name || '未命名聊天',preview:notificationPlainText(typeof last.content==='string'?last.content:'',{maximum:160,fallback:'附件'}),count:messages.length,
      updatedAt:messageTime(last.timestamp ?? last.created_at ?? last.createdAt ?? summary.updated_at ?? 0),messages:messages.map(m=>({id:m.id,seq:m.seq}))})
  }
  result.conversations.sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id))
  for(const row of result.conversations)result[row.mode]+=row.count
  result.total=result.bot+result.chat
  return result
}

/** Only IDs in the user's click/render snapshot are acknowledged; later completions survive. */
export function acknowledgeUnread(workspace:WorkspaceStore,cache:ChatCacheStore,owner:string,
  items:Array<Pick<UnreadConversation,'mode'|'id'|'profile'|'messages'>>,allowed:(node:string,profile:string)=>boolean=()=>true):void {
  for(const item of items) {
    if(item.mode==='bot') {
      const c=workspace.require<WorkspaceConversation>(owner,'conversation',item.id)
      if(!c.memberIds.every(id=>{const a=workspace.get<WorkspaceAgent>(owner,'agent',id);return !a || allowed(a.nodeId,a.profile)}))continue
      workspace.markChatMessagesRead(owner,c.id,item.messages)
    } else {
      const profile=item.profile ?? 'default'
      if(!allowed('local',profile))continue
      cache.requireOwned(owner,profile,item.id)
      cache.transcripts.seed(owner,profile,item.id)
      cache.transcripts.markMessagesRead(owner,profile,item.id,item.messages.map(m=>m.id))
    }
  }
}
