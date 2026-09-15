import {flushPromises,mount} from '@vue/test-utils'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import HermesBridgePanel from '@/components/app/HermesBridgePanel.vue'
import {getHermesBridgeStatus,installHermesBridge} from '@/api/hermesBridge'
import type {HermesBridgeStatus} from '@shared/hermesBridge'
vi.mock('@/api/hermesBridge',()=>({getHermesBridgeStatus:vi.fn(),installHermesBridge:vi.fn()}))
const snapshot=():HermesBridgeStatus=>({endpoint:'http://127.0.0.1:9119',local:true,bundledVersion:'1.2.0',checkedAt:1,profiles:[
  {profile:'default',state:'outdated',message:'需要更新',canInstall:true,installedVersion:'1.1.0'},
  {profile:'writer',state:'disabled',message:'尚未启用',canInstall:true,installedVersion:'1.2.0'},
]})
beforeEach(()=>{vi.mocked(getHermesBridgeStatus).mockResolvedValue(snapshot())})
afterEach(()=>{vi.clearAllMocks()})
it('shows each Profile and installs only the selected one, with visible progress and restart instructions',async()=>{
  let finish!:(value:any)=>void
  vi.mocked(installHermesBridge).mockReturnValue(new Promise(done=>{finish=done}))
  const wrapper=mount(HermesBridgePanel)
  await flushPromises()
  expect(wrapper.text()).toContain('default');expect(wrapper.text()).toContain('writer')
  await wrapper.get('button[aria-label="安装并启用：writer"]').trigger('click')
  expect(installHermesBridge).toHaveBeenCalledWith('writer',true)
  expect(wrapper.text()).toContain('安装中…')
  expect(wrapper.findAll('button').every(button=>button.attributes('disabled')!==undefined)).toBe(true)
  const state=snapshot();state.profiles[1]!.state='restart-required'
  finish({profile:'writer',backup:'/backups/writer',message:'安装完成，请重启 Hermes',status:state})
  await flushPromises()
  expect(wrapper.text()).toContain('待重启');expect(wrapper.get('[role="status"]').text()).toContain('重启 Hermes')
  expect(wrapper.text()).toContain('/backups/writer')
  await wrapper.findAll('button').find(b=>b.text()==='重新检查')!.trigger('click');await flushPromises()
  expect(getHermesBridgeStatus).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})
it('provides retry feedback and keeps remote installation unavailable',async()=>{
  vi.mocked(getHermesBridgeStatus).mockRejectedValueOnce(new Error('连接失败'))
  const wrapper=mount(HermesBridgePanel);await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('连接失败')
  const state=snapshot();state.local=false;state.profiles=state.profiles.map(p=>({...p,canInstall:false}));state.message='请在 Hermes 所在节点安装'
  vi.mocked(getHermesBridgeStatus).mockResolvedValue(state)
  await wrapper.get('button').trigger('click');await flushPromises()
  expect(wrapper.text()).toContain('所在节点安装');expect(wrapper.findAll('.install')).toHaveLength(0)
  wrapper.unmount()
})
it('shows installation failures without claiming that Hermes has loaded the plugin',async()=>{
  vi.mocked(installHermesBridge).mockRejectedValue(new Error('没有写入权限'))
  const wrapper=mount(HermesBridgePanel);await flushPromises()
  await wrapper.get('button[aria-label="更新工具桥：default"]').trigger('click');await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('没有写入权限')
  expect(wrapper.text()).not.toContain('已就绪');expect(wrapper.text()).not.toContain('安装中…')
  wrapper.unmount()
})
