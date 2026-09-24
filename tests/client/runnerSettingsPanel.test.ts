import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import RunnerSettingsPanel from '@/components/app/RunnerSettingsPanel.vue'
import {apiRequest} from '@/api/client'

vi.mock('@/api/client',()=>({apiRequest:vi.fn()}))
beforeEach(()=>{
  vi.mocked(apiRequest).mockReset()
  vi.mocked(apiRequest).mockImplementation(async(_path,options)=>options?.method==='POST'
    ?{runner:{id:'11111111-1111-4111-8111-111111111111',name:'Browser Runner'},token:'fixture-token'} as any
    :{runners:[],sources:[{id:'local',name:'本地'}]} as any)
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

it.each([false,true])('defaults browsers on and preserves an explicit opt-out in downloaded configuration (enabled=%s)',async(enabled)=>{
  let download:Blob|undefined
  vi.stubGlobal('URL',class extends URL {
    static createObjectURL(blob:Blob){download=blob;return 'blob:fixture'}
    static revokeObjectURL(){}
  })
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
  const wrapper=mount(RunnerSettingsPanel)
  try{
    await flushPromises()
    const browser=wrapper.findAll('.runner-check').find(label=>label.text()==='托管浏览器')!.get<HTMLInputElement>('input')
    const computer=wrapper.findAll('.runner-check').find(label=>label.text().includes('隔离电脑 Worker'))!.get<HTMLInputElement>('input')
    expect(browser.element.checked).toBe(true)
    expect(computer.element.checked).toBe(false)
    if(!enabled)await browser.setValue(false)
    await wrapper.get('input[placeholder="我的 Mac"]').setValue('Browser Runner')
    await wrapper.findAll('input[type="url"]')[0]!.setValue('http://127.0.0.1:18888')
    await wrapper.get('form').trigger('submit');await flushPromises()
    await wrapper.findAll('button').find(button=>button.text()==='下载 Runner 配置')!.trigger('click')
    const text=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsText(download!)})
    const config=JSON.parse(text)
    expect(config.computers).toBeUndefined()
    expect(config.browser).toEqual({enabled})
    expect(config.allowedProfiles).toEqual(['default'])
  }finally{wrapper.unmount()}
})
