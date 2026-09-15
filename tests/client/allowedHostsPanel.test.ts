import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearApiSecurityContext, setApiCsrfToken } from '@/api/client'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'

afterEach(() => {
  clearApiSecurityContext()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('allowed hosts settings panel', () => {
  it('shows environment entries separately and saves Web-managed domains and IPs', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      const editableHosts = init?.method === 'PUT'
        ? (JSON.parse(String(init.body)) as { hosts: string[] }).hosts
        : ['old.example.com']
      return new Response(JSON.stringify({
        source: 'file',
        hosts: ['127.0.0.1', ...editableHosts],
        editableHosts,
        environmentHosts: ['127.0.0.1', 'localhost'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    setApiCsrfToken('csrf-panel')
    const wrapper = mount(SystemManagementPanel, {
      props: { section: 'connection', active: true },
      global: { stubs: { AppIcon: true, HermesBridgePanel: true } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('外网访问地址')
    expect(wrapper.text()).toContain('环境变量保留地址（Web 中不能移除）')
    expect(wrapper.get<HTMLTextAreaElement>('textarea[name="allowed-hosts"]').element.value).toBe('old.example.com')

    await wrapper.get('textarea[name="allowed-hosts"]').setValue('yaoyao.example.com\n203.0.113.10')
    const save = wrapper.findAll('button').find(button => button.text() === '保存访问地址')
    expect(save).toBeDefined()
    await save!.trigger('submit')
    await flushPromises()

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/system/allowed-hosts',
      '/api/app/admin/upstream-connection',
      '/api/app/system/allowed-hosts',
    ])
    expect(calls[2]!.init?.body).toBe(JSON.stringify({
      hosts: ['yaoyao.example.com', '203.0.113.10'],
    }))
    expect(wrapper.text()).toContain('允许的访问地址已保存并立即生效')
  })
})
