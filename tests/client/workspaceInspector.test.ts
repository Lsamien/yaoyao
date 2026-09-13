import {afterEach,expect,it,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import Panel from '../../src/client/components/workspace/WorkspaceInspectorPanel.vue'
import {apiRequest} from '../../src/client/api/client'
import type {WorkspaceInspectorEntry} from '../../src/shared/workspacePanels'
vi.mock('../../src/client/api/client',()=>({apiRequest:vi.fn()}))
const entry=(id:string,at:number,method='message.delta',direction:WorkspaceInspectorEntry['direction']='event',agentId='agent'):WorkspaceInspectorEntry=>({id,at,method,direction,agentId,runId:'run',data:{text:id}})
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks()})
function setup(entries:WorkspaceInspectorEntry[]){
 vi.spyOn(document,'hidden','get').mockReturnValue(false)
 vi.mocked(apiRequest).mockResolvedValue({entries})
 return mount(Panel,{props:{conversationId:'conversation'},global:{stubs:{AppIcon:true}}})
}
it('sorts by timestamp before grouping, shows newest groups first and keeps delta text in order',async()=>{
 const wrapper=setup([entry('done',400,'message.complete'),entry('B',300),entry('A',200),entry('other',100,'message.delta','event','other')])
 try{
  await flushPromises()
  const rows=wrapper.findAll('details')
  expect(rows.map(row=>row.find('.summary').text())).toEqual(['done','AB','other'])
  expect(rows[1]!.find('time').text()).toMatch(/\.300$/)
  expect(rows[1]!.find('.tag').text()).toContain('×2')
  expect(JSON.parse(rows[1]!.find('pre').text()).map((e:WorkspaceInspectorEntry)=>e.id)).toEqual(['A','B'])
 }finally{wrapper.unmount()}
})
it('sorts Raw responses and requests newest first, including equal-time arrival order',async()=>{
 const wrapper=setup([entry('response',300,'session.usage','response'),entry('request',100,'prompt.submit','request'),entry('same-1',200,'first','request'),entry('same-2',200,'second','response')])
 try{
  await flushPromises();await wrapper.get('.lenses button:last-child').trigger('click');await flushPromises()
  expect(wrapper.findAll('pre').map(row=>JSON.parse(row.text()).id)).toEqual(['response','same-2','same-1','request'])
 }finally{wrapper.unmount()}
})
it('opens at the top, follows new records at capacity, and resets a changed lens after reading older records',async()=>{
 const wrapper=setup([entry('old',100,'message.complete'),entry('new',200,'message.complete')])
 try{
  await flushPromises()
  const list=wrapper.get('.inspector-list').element as HTMLElement
  expect(list.scrollTop).toBe(0)
  list.scrollTop=150;await wrapper.get('.inspector-list').trigger('scroll')
  vi.mocked(apiRequest).mockResolvedValue({entries:[entry('new',200,'message.complete'),entry('latest',300,'message.complete')]})
  await wrapper.get('.reload').trigger('click');await flushPromises()
  expect(list.scrollTop).toBe(150)
  await wrapper.get('.lenses button:last-child').trigger('click');await flushPromises();expect(list.scrollTop).toBe(0)
  await wrapper.get('.lenses button:first-child').trigger('click');await flushPromises()
  list.scrollTop=20;await wrapper.get('.inspector-list').trigger('scroll')
  vi.mocked(apiRequest).mockResolvedValue({entries:[entry('latest',300,'message.complete'),entry('live',400,'message.complete')]})
  await wrapper.get('.reload').trigger('click');await flushPromises();expect(list.scrollTop).toBe(0)
  expect(wrapper.find('.summary').text()).toBe('live')
 }finally{wrapper.unmount()}
})
