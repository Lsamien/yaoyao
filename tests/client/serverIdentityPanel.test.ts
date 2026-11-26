import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth'
import ServerIdentityPanel from '@/components/app/ServerIdentityPanel.vue'
const api=vi.hoisted(()=>({fetch:vi.fn(),save:vi.fn()}))
vi.mock('@/api/serverIdentity',async original=>({...await original<typeof import('@/api/serverIdentity')>(),fetchServerIdentity:api.fetch,saveServerIdentity:api.save}))
const initial={serverId:'server-a',name:'家里',displayName:'家里',revision:1}
let auth:ReturnType<typeof useAuthStore>
function setup(role='admin'){
  setActivePinia(createPinia());auth=useAuthStore();auth.status='authenticated';auth.user={id:'user',username:'fixture',role}
  auth.acceptServerIdentity(initial);api.fetch.mockResolvedValue(initial)
  return mount(ServerIdentityPanel)
}
afterEach(()=>{auth?.$dispose();vi.clearAllMocks()})
it.each(['admin','user'])('shows the server name read-only for %s accounts; it is set in the admin console',async role=>{
  const wrapper=setup(role);await flushPromises()
  expect(wrapper.text()).toContain('家里');expect(wrapper.text()).toContain('管理后台')
  expect(wrapper.find('input').exists()).toBe(false);expect(wrapper.find('form').exists()).toBe(false)
  expect(api.save).not.toHaveBeenCalled();wrapper.unmount()
})
it('follows newer names from other clients and ignores older revisions',async()=>{
  const wrapper=setup();await flushPromises()
  auth.acceptServerIdentity({...initial,name:'其他端',displayName:'其他端',revision:2});await flushPromises()
  expect(wrapper.text()).toContain('其他端')
  auth.acceptServerIdentity(initial);expect(auth.serverIdentity?.name).toBe('其他端');wrapper.unmount()
})
