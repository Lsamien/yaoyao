import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BotModelSettingsPanel from '@/components/workspace/BotModelSettingsPanel.vue'
const api = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ apiRequest: api }))
const defaults = {provider:'openai',model:'model-a',reasoningEffort:'medium',fastMode:'normal'}
const agent = {id:'bot-a',profile:'default',name:'甲',avatar:'',instructions:'',nodeId:'local',archived:false,revision:1,createdAt:1,updatedAt:1}
const catalogue = () => ({version:1,defaults,settings:null,revision:1,models:[
  {provider:'openai',model:'model-a',name:'A',reasoningEfforts:['none','high'],reasoningKnown:false,fastModes:['normal','fast','auto','cold']},
  {provider:'other',model:'model-b',name:'B',reasoningEfforts:[],reasoningKnown:true,fastModes:['normal']},
]})
beforeEach(() => { api.mockReset(); api.mockResolvedValue(catalogue()) })
afterEach(() => vi.restoreAllMocks())
it('loads the Bot catalogue, preserves full speed modes, and saves with a revision', async () => {
  const view = mount(BotModelSettingsPanel,{props:{agent}}); await flushPromises()
  await view.get('[aria-label="Bot 速度"]').setValue('cold')
  api.mockResolvedValueOnce({agent:{...agent,revision:2,modelSettings:{provider:null,model:null,reasoningEffort:null,fastMode:'cold'}}})
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api).toHaveBeenLastCalledWith('/api/app/agents/bot-a',{method:'PATCH',body:{modelSettings:{provider:null,model:null,reasoningEffort:null,fastMode:'cold'},expectedRevision:1}})
  expect(view.text()).toContain('已保存'); view.unmount()
})
it('does not silently reset incompatible settings after changing model', async () => {
  const view = mount(BotModelSettingsPanel,{props:{agent}}); await flushPromises()
  await view.get('[aria-label="Bot 思考等级"]').setValue('high')
  await view.get('[aria-label="Bot 模型"]').setValue('["other","model-b"]')
  expect(view.text()).toContain('不支持所选思考等级')
  expect(view.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true)
  view.unmount()
})
it('keeps dirty drafts when another client saves and disables stale submission', async () => {
  const view = mount(BotModelSettingsPanel,{props:{agent}}); await flushPromises()
  await view.get('[aria-label="Bot 速度"]').setValue('auto')
  await view.setProps({agent:{...agent,revision:2}})
  expect(view.get<HTMLSelectElement>('[aria-label="Bot 速度"]').element.value).toBe('auto')
  expect(view.text()).toContain('当前草稿已保留')
  expect(api).toHaveBeenCalledTimes(1); view.unmount()
})
it('confirms the exact model in the profile before saving', async () => {
  vi.spyOn(window,'confirm').mockReturnValue(true)
  const view = mount(BotModelSettingsPanel,{props:{agent}}); await flushPromises()
  api.mockResolvedValueOnce({confirmationRequired:true,confirmationMessage:'费用较高',confirmationTarget:'["openai","model-a"]'})
    .mockResolvedValueOnce({agent:{...agent,revision:2}})
  await view.get('form').trigger('submit'); await flushPromises()
  expect(window.confirm).toHaveBeenCalledWith('费用较高')
  expect(api.mock.lastCall?.[1].body.confirmedModel).toBe('["openai","model-a"]'); view.unmount()
})
it('refreshes a newer cross-client update that arrives while its own save is in flight', async () => {
  const view=mount(BotModelSettingsPanel,{props:{agent}});await flushPromises()
  await view.get('[aria-label="Bot 速度"]').setValue('cold')
  let finish:(value:any)=>void=()=>{}
  api.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    .mockResolvedValueOnce({...catalogue(),revision:3,settings:{provider:null,model:null,reasoningEffort:null,fastMode:'auto'}})
  await view.get('form').trigger('submit')
  expect(view.emitted('busyChange')?.at(-1)).toEqual([true])
  await view.setProps({agent:{...agent,revision:3}})
  finish({agent:{...agent,revision:2}});await flushPromises()
  expect(view.emitted('busyChange')?.at(-1)).toEqual([false])
  expect(api).toHaveBeenLastCalledWith('/api/app/agents/bot-a/model-options')
  expect(view.get<HTMLSelectElement>('[aria-label="Bot 速度"]').element.value).toBe('auto');view.unmount()
})
it('disables editing when a reload discovers an unavailable bridge and allows retry',async()=>{
  const view=mount(BotModelSettingsPanel,{props:{agent}});await flushPromises()
  api.mockRejectedValueOnce(new Error('请升级工具桥'))
  await view.get('button[type="button"]').trigger('click');await flushPromises()
  expect(view.find('form').exists()).toBe(false);expect(view.text()).toContain('请升级工具桥')
  await view.get('button[type="button"]').trigger('click');await flushPromises()
  expect(view.find('form').exists()).toBe(true);view.unmount()
})
