import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import FileAccessPanel from '@/components/app/FileAccessPanel.vue'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'

const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/client', () => ({ apiRequest: api.request, apiUrl: (path: string, query: Record<string, string>) => `${path}?${new URLSearchParams(query)}` }))
afterEach(() => { api.request.mockReset(); vi.unstubAllGlobals() })

describe('server file permission interface', () => {
  it('keeps cwd visible and saves the global switch to the server without local storage', async () => {
    api.request.mockResolvedValue({ mode: 'folders', folders: [], workingDirectory: '/remote/work' })
    const wrapper = mount(FileAccessPanel, { props: { profile: 'server' } })
    await flushPromises()
    expect(wrapper.text()).toContain('/remote/work')
    expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
    expect(api.request).toHaveBeenCalledWith('/api/app/settings/file-access?profile=server')
    await wrapper.get('input[type=checkbox]').setValue(true)
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.request).toHaveBeenLastCalledWith('/api/app/settings/file-access', { method: 'PUT', body: { mode: 'all', folders: [] } })
    expect(wrapper.text()).toContain('已保存')
    wrapper.unmount()
  })
  it.each(['flat', 'nested'])('shows a %s server rejection next to a failed image and provides retry', async shape => {
    const reason = '目录未获授权，请检查文件访问设置'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: shape === 'flat' ? reason : { message: reason } }), { status: 403 })))
    const wrapper = mount(MarkdownContent, { attachTo: document.body, props: {
      content: 'MEDIA: /tmp/hello.png', legacyMedia: true, fileCards: true, fileProfile: 'server',
    } })
    await wrapper.get('img').trigger('error')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('目录未获授权')
    const src = new URL(wrapper.get('img').attributes('src')!, 'http://localhost')
    expect(src.searchParams.get('profile')).toBe('server')
    expect(src.searchParams.get('path')).toBe('/tmp/hello.png')
    await wrapper.get('[role=alert] button').trigger('click')
    expect(wrapper.get('img').attributes('src')).toContain('_retry=')
    wrapper.unmount()
  })
})
