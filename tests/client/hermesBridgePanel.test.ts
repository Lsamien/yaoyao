import {flushPromises,mount} from '@vue/test-utils'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import HermesBridgePanel from '@/components/app/HermesBridgePanel.vue'
import {getHermesBridgeStatus,installHermesBridge,restartHermesDashboard} from '@/api/hermesBridge'
import type {HermesBridgeStatus} from '@shared/hermesBridge'
vi.mock('@/api/hermesBridge',()=>({getHermesBridgeStatus:vi.fn(),installHermesBridge:vi.fn(),restartHermesDashboard:vi.fn()}))
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

const managedSnapshot=():HermesBridgeStatus=>({...snapshot(),dashboard:{managed:true,canRestart:true,restarting:false,message:'重启会短暂断开此 Dashboard 下所有 Profile 的连接，完成后自动检查工具桥。'}})
it('shows one instance-wide restart action with progress and the verified result',async()=>{
  vi.mocked(getHermesBridgeStatus).mockResolvedValue(managedSnapshot())
  let finish!:(value:any)=>void
  vi.mocked(restartHermesDashboard).mockReturnValue(new Promise(done=>{finish=done}))
  const wrapper=mount(HermesBridgePanel);await flushPromises()
  expect(wrapper.findAll('.restart')).toHaveLength(1)
  expect(wrapper.text()).toContain('所有 Profile')
  await wrapper.get('.restart').trigger('click');await wrapper.get('.restart').trigger('click')
  expect(restartHermesDashboard).toHaveBeenCalledTimes(1)
  expect(wrapper.get('.restart').text()).toBe('重启中…')
  expect(wrapper.attributes('aria-busy')).toBe('true')
  expect(wrapper.findAll('button').every(b=>b.attributes('disabled')!==undefined)).toBe(true)
  const state=managedSnapshot();state.profiles.forEach(p=>{p.state='ready'})
  finish({message:'Hermes Dashboard 已重启，工具桥已就绪。',status:state});await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toContain('工具桥已就绪')
  expect(wrapper.findAll('.badge.ready')).toHaveLength(2)
  expect(wrapper.get('.restart').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('hides restart for unmanaged instances and disables it while tasks or installs are active',async()=>{
  const state=managedSnapshot();state.dashboard!.canRestart=false;state.dashboard!.message='当前仍有任务运行，请结束任务后重启。'
  vi.mocked(getHermesBridgeStatus).mockResolvedValue(state)
  const wrapper=mount(HermesBridgePanel);await flushPromises()
  expect(wrapper.get('.restart').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('当前仍有任务运行')
  await wrapper.get('.restart').trigger('click');expect(restartHermesDashboard).not.toHaveBeenCalled()
  state.dashboard!.managed=false
  await wrapper.findAll('button').find(b=>b.text()==='重新检查')!.trigger('click');await flushPromises()
  expect(wrapper.find('.restart').exists()).toBe(false)
  expect(wrapper.text()).toContain('Hermes 所在节点')
  wrapper.unmount()
})

it('refreshes capabilities after failure and preserves the restart error',async()=>{
  vi.mocked(getHermesBridgeStatus).mockResolvedValue(managedSnapshot())
  vi.mocked(restartHermesDashboard).mockRejectedValue(new Error('Hermes Dashboard 重启失败'))
  const wrapper=mount(HermesBridgePanel);await flushPromises()
  const state=managedSnapshot();state.dashboard!.canRestart=false;state.dashboard!.managed=false
  vi.mocked(getHermesBridgeStatus).mockResolvedValue(state)
  await wrapper.get('.restart').trigger('click');await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('重启失败')
  expect(wrapper.find('.restart').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('工具桥已就绪')
  wrapper.unmount()
})
