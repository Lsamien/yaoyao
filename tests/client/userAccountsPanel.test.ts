import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'
import { approveUser, createUser, listUsers } from '@/api/admin'

vi.mock('@/api/admin', () => ({
  approveUser: vi.fn(async () => undefined),
  createUser: vi.fn(async () => undefined),
  deleteUser: vi.fn(async () => undefined),
  listUsers: vi.fn(async () => []),
  updateUser: vi.fn(async () => undefined),
}))

afterEach(() => { vi.clearAllMocks() })

describe('user accounts use the single Hermes profile', () => {
  it('creates and approves accounts without choosing a profile', async () => {
    vi.mocked(listUsers).mockResolvedValue([
      { id: 'u1', username: 'pending-child', role: 'user', registrationStatus: 'pending', enabled: false, mustChangePassword: false, createdAt: 1, updatedAt: 1 },
    ])
    const wrapper = mount(SystemManagementPanel, {
      props: { section: 'users', profiles: [{ name: 'default' }, { name: 'writer' }] as never },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('基础机器人')

    const approve = wrapper.findAll('button').find(button => button.text() === '开通')!
    expect(approve.attributes('disabled')).toBeUndefined()
    await approve.trigger('click')
    await flushPromises()
    expect(approveUser).toHaveBeenCalledWith('u1')

    await wrapper.find('input[name=managed-username]').setValue('new-child')
    await wrapper.find('input[name=managed-temporary-password]').setValue('temporary-pass')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(createUser).toHaveBeenCalledWith('new-child', 'temporary-pass')
  })
})
