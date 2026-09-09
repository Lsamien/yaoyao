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
it('saves the server name with the loaded revision',async()=>{
  const wrapper=setup();await flushPromises()
  api.save.mockResolvedValue({...initial,name:'办公室',displayName:'办公室',revision:2})
  await wrapper.get('input').setValue('办公室');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(api.save).toHaveBeenCalledWith('办公室',1,'server-a');expect(auth.serverIdentity?.displayName).toBe('办公室')
  wrapper.unmount()
})
it('shows the same name read-only for ordinary accounts',async()=>{
  const wrapper=setup('user');await flushPromises();expect(wrapper.text()).toContain('家里');expect(wrapper.find('input').exists()).toBe(false);wrapper.unmount()
})
it('keeps an unsaved draft when another client changes the name and ignores older revisions',async()=>{
  const wrapper=setup();await flushPromises();await wrapper.get('input').setValue('我的草稿')
  auth.acceptServerIdentity({...initial,name:'其他端',displayName:'其他端',revision:2});await flushPromises()
  expect(wrapper.get<HTMLInputElement>('input').element.value).toBe('我的草稿')
  auth.acceptServerIdentity(initial);expect(auth.serverIdentity?.name).toBe('其他端');wrapper.unmount()
})
