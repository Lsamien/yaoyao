import type { WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceAgent, WorkspaceConversation } from '../shared/workspace.js'
import { emptyUnread, type UnreadSnapshot, type UnreadConversation } from '../shared/unread.js'
import { notificationPlainText } from './notificationText.js'

/** Bot conversations only; `chat` stays 0 for clients that still read the field. */
export function unreadSnapshot(workspace:WorkspaceStore, owner:string,
  allowed:(node:string,profile:string)=>boolean = ()=>true):UnreadSnapshot {
  const result=emptyUnread()
  for(const c of workspace.list<WorkspaceConversation>(owner,'conversation')) {
    if(c.archived || !c.memberIds.every(id=>{const a=workspace.get<WorkspaceAgent>(owner,'agent',id);return !a || allowed(a.nodeId,a.profile)}))continue
    const messages=workspace.chatUnreadMessages(owner,c.id)
    if(!messages.length)continue
    result.conversations.push({mode:'bot',id:c.id,name:c.name,preview:notificationPlainText(messages.at(-1)!.content,{maximum:160,fallback:messages.at(-1)!.attachments[0]?.name ?? '附件'}),count:messages.length,
      updatedAt:messages.at(-1)!.createdAt,messages:messages.map(m=>({id:m.id,seq:m.seq,version:m.chatUnreadVersion,taskId:m.conversationTaskId}))})
  }
  result.conversations.sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id))
  for(const row of result.conversations)result[row.mode]+=row.count
  result.total=result.bot+result.chat
  return result
}

/** Only IDs in the user's click/render snapshot are acknowledged; later completions survive. */
export function acknowledgeUnread(workspace:WorkspaceStore,owner:string,
  items:Array<Pick<UnreadConversation,'mode'|'id'|'profile'|'messages'>>,allowed:(node:string,profile:string)=>boolean=()=>true):void {
  for(const item of items) {
    if(item.mode!=='bot')continue
    const c=workspace.require<WorkspaceConversation>(owner,'conversation',item.id)
    if(!c.memberIds.every(id=>{const a=workspace.get<WorkspaceAgent>(owner,'agent',id);return !a || allowed(a.nodeId,a.profile)}))continue
    workspace.markChatMessagesRead(owner,c.id,item.messages)
  }
}
