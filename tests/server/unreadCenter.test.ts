// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { ChatCacheStore,ChatCacheCoordinator } from '../../src/server/chatCache'
import { unreadSnapshot,acknowledgeUnread } from '../../src/server/unreadCenter'
const homes:string[]=[];const stores:Array<{close():void}>=[]
afterEach(()=>{stores.reverse().forEach(s=>s.close());stores.length=0;homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}))})
it('shares exact snapshots between devices, isolates owners/profiles, and excludes task duplication and process rows',()=>{
 const home=mkdtempSync(join(tmpdir(),'unread-integration-'));homes.push(home)
 const workspace=new WorkspaceStore(home),cache=new ChatCacheStore(home),coordinator=new ChatCacheCoordinator(cache,{request:vi.fn()} as any);stores.push(workspace,cache,coordinator)
 const a=workspace.createAgent('a',{name:'bot',profile:'p'}),b=workspace.createAgent('a',{name:'two',profile:'p'}),c=workspace.createGroup('a',{name:'group',memberIds:[a.id,b.id],administratorId:a.id}),task=workspace.tasks('a',c.id)[0]!
 workspace.saveMessage('a',{id:'bot-final',conversationId:c.id,conversationTaskId:task.id,seq:0,role:'assistant',status:'complete',content:'附件答复',reasoning:'',attachments:[],tools:[],createdAt:1})
 for(const profile of ['p','other']){
  cache.recordCommand('a',profile,'s','session.create',{})
  coordinator.observe('a',profile,'s',{type:'message.interim',payload:{text:'检查中'},delivery_id:'progress'})
  coordinator.observe('a',profile,'s',{type:'message.complete',payload:{text:'答复'},delivery_id:'final'})
  coordinator.observe('a',profile,'s',{type:'message.complete',payload:{text:'答复'},delivery_id:'final'})
 }
 const device1=unreadSnapshot(workspace,cache,'a'),device2=unreadSnapshot(workspace,cache,'a')
 expect(device1).toMatchObject({total:3,bot:1,chat:2});expect(device2).toEqual(device1)
 expect(unreadSnapshot(workspace,cache,'b').total).toBe(0)
 expect(unreadSnapshot(workspace,cache,'a',(_,p)=>p==='p').total).toBe(2)
 coordinator.observe('a','p','s',{type:'message.start',payload:{},delivery_id:'new-start'})
 coordinator.observe('a','p','s',{type:'message.complete',payload:{text:'随后新消息'},delivery_id:'new-final'})
 acknowledgeUnread(workspace,cache,'a',device1.conversations)
 acknowledgeUnread(workspace,cache,'a',device2.conversations)
 expect(unreadSnapshot(workspace,cache,'a')).toMatchObject({total:1,chat:1,bot:0})
 expect(workspace.require<any>('a','conversation-task',task.id).unreadCount).toBe(0)
})
