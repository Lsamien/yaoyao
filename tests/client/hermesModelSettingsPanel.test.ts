import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import HermesModelSettingsPanel from '@/components/app/HermesModelSettingsPanel.vue'

const api = vi.hoisted(() => ({
  listHermesCredentials: vi.fn(async () => [
    { key: 'OPENROUTER_API_KEY', isSet: false, preview: null, description: 'OpenRouter API key', url: null, category: 'provider', secret: true, advanced: false, provider: 'openrouter', providerLabel: 'OpenRouter', custom: false, readonly: false },
    { key: 'HIDDEN_ADVANCED', isSet: false, preview: null, description: '', url: null, category: 'setting', secret: false, advanced: true, provider: '', providerLabel: '', custom: false, readonly: false },
  ]),
  saveHermesCredential: vi.fn(async () => undefined),
  deleteHermesCredential: vi.fn(async () => undefined),
  getAuxiliaryModels: vi.fn(async () => ({ tasks: [{ task: 'vision', provider: 'auto', model: '' }], main: { provider: 'openrouter', model: 'm1' } })),
  setAuxiliaryModel: vi.fn(async (_p: string, task: string, provider: string, model: string) => ({ tasks: [{ task, provider, model }], main: {} })),
  listOAuthProviders: vi.fn(async () => [{ id: 'nous', name: 'Nous Portal', flow: 'device_code', status: { logged_in: false } }]),
  startOAuth: vi.fn(async () => ({ session_id: 's1', user_code: 'ABCD-1234', verification_url: 'https://example.test/device' })),
  pollOAuth: vi.fn(async () => ({ session_id: 's1', status: 'pending' })),
  cancelOAuth: vi.fn(async () => undefined),
  submitOAuthToken: vi.fn(async () => undefined),
  disconnectOAuth: vi.fn(async () => undefined),
}))
vi.mock('@/api/hermesAdmin', () => api)
vi.mock('@/api/agentManagement', () => ({ listModelCatalog: vi.fn(async () => [{ slug: 'openrouter', name: 'OpenRouter', models: ['m1', 'm2'], isCurrent: true }]) }))

const stubs = { global: { stubs: { ModelServicesPanel: { template: '<div class="model-services-stub" />' } } } }
const tab = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('[role=tab]').find(item => item.text() === label)!.trigger('click')

describe('HermesModelSettingsPanel', () => {
  it('starts on providers and models', () => {
    const wrapper = mount(HermesModelSettingsPanel, stubs)
    expect(wrapper.find('.model-services-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it('saves an API key and hides advanced variables until requested', async () => {
    const wrapper = mount(HermesModelSettingsPanel, stubs)
    await tab(wrapper, '密钥与变量'); await flushPromises()
    expect(wrapper.text()).toContain('OPENROUTER_API_KEY')
    expect(wrapper.text()).not.toContain('HIDDEN_ADVANCED')
    await wrapper.findAll('button').find(button => button.text() === '设置')!.trigger('click')
    await wrapper.find('.flow-box input').setValue('sk-test')
    await wrapper.find('.flow-box').trigger('submit'); await flushPromises()
    expect(api.saveHermesCredential).toHaveBeenCalledWith('default', 'OPENROUTER_API_KEY', 'sk-test')
    await wrapper.find('.check input').setValue(true)
    expect(wrapper.text()).toContain('HIDDEN_ADVANCED')
    wrapper.unmount()
  })

  it('assigns an auxiliary model', async () => {
    const wrapper = mount(HermesModelSettingsPanel, stubs)
    await tab(wrapper, '辅助模型'); await flushPromises()
    expect(wrapper.text()).toContain('视觉识别')
    await wrapper.find('select[aria-label="视觉识别 Provider"]').setValue('openrouter')
    await wrapper.find('input[aria-label="视觉识别 模型"]').setValue('m2')
    await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click'); await flushPromises()
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('default', 'vision', 'openrouter', 'm2')
    wrapper.unmount()
  })

  it('shows the device code for an OAuth login', async () => {
    const wrapper = mount(HermesModelSettingsPanel, stubs)
    await tab(wrapper, '账号登录'); await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '登录')!.trigger('click'); await flushPromises()
    expect(api.startOAuth).toHaveBeenCalledWith('default', 'nous')
    expect(wrapper.find('.user-code').text()).toBe('ABCD-1234')
    await wrapper.findAll('button').find(button => button.text() === '取消')!.trigger('click')
    expect(api.cancelOAuth).toHaveBeenCalledWith('default', 'nous', 's1')
    wrapper.unmount()
  })
})
