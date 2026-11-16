import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountSecurityDialog from '@/components/app/AccountSecurityDialog.vue'
import AccountSecurityPanel from '@/components/app/AccountSecurityPanel.vue'

const auth = vi.hoisted(() => ({
  user: { id: 'admin-1', username: 'owner', role: 'admin' } as { id: string; username: string; role: string; avatar?: string } | undefined,
  changeCredentials: vi.fn(async () => undefined),
  updateAccountAvatar: vi.fn(async (avatar: string | null) => { if (auth.user) { if (avatar) auth.user.avatar=avatar; else delete auth.user.avatar } }),
  logout: vi.fn(async () => undefined),
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

async function fill(wrapper: ReturnType<typeof mount>, name: string, value: string) {
  await wrapper.get<HTMLInputElement>(`input[name="${name}"]`).setValue(value)
}

beforeEach(() => {
  auth.user = { id: 'admin-1', username: 'owner', role: 'admin' }
  auth.changeCredentials.mockResolvedValue(undefined)
  auth.updateAccountAvatar.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('Account security panel', () => {
  it('saves the trimmed administrator username and resets its dirty state', async () => {
    const wrapper = mount(AccountSecurityPanel, { props: { active: true } })

    expect(wrapper.text()).toContain('仅修改当前 15300 Web 管理账号')
    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([false])
    await fill(wrapper, 'username', '  owner-two  ')
    await fill(wrapper, 'current-password', 'current-secret')
    await fill(wrapper, 'new-password', 'new-secret-123')
    await fill(wrapper, 'password-confirmation', 'new-secret-123')

    expect(wrapper.text()).toContain('两次输入一致')
    expect(wrapper.emitted('dirty-change')?.some(event => event[0] === true)).toBe(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(auth.changeCredentials).toHaveBeenCalledWith({
      currentPassword: 'current-secret',
      newPassword: 'new-secret-123',
      username: 'owner-two',
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([false])
    expect(wrapper.get<HTMLInputElement>('input[name="current-password"]').element.value).toBe('')
    expect(wrapper.text()).toContain('账号与密码已更新')
  })

  it('does not expose or submit an administrator username for a regular user', async () => {
    auth.user = { id: 'user-1', username: 'member', role: 'user' }
    const wrapper = mount(AccountSecurityPanel, { props: { active: true } })

    expect(wrapper.find('input[name="username"]').exists()).toBe(false)
    await fill(wrapper, 'current-password', 'current-secret')
    await fill(wrapper, 'new-password', 'member-secret-123')
    await fill(wrapper, 'password-confirmation', 'member-secret-123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(auth.changeCredentials).toHaveBeenCalledWith({
      currentPassword: 'current-secret',
      newPassword: 'member-secret-123',
    })
  })

  it('resets when activated and exposes logout as an independent action', async () => {
    const wrapper = mount(AccountSecurityPanel, { props: { active: false } })
    await fill(wrapper, 'current-password', 'discard-me')
    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([true])

    await wrapper.setProps({ active: true })
    expect(wrapper.get<HTMLInputElement>('input[name="current-password"]').element.value).toBe('')
    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([false])

    await wrapper.get<HTMLButtonElement>('.logout-button').trigger('click')
    expect(wrapper.emitted('logout')).toHaveLength(1)
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('restores the account to its generated initial avatar independently', async () => {
    auth.user = { id: 'admin-1', username: 'owner', role: 'admin', avatar: 'data:image/png;base64,aGVsbG8=' }
    const wrapper = mount(AccountSecurityPanel, { props: { active: true } })
    expect(wrapper.get('.account-initial-avatar img').attributes('src')).toBe(auth.user.avatar)
    await wrapper.get('.account-avatar-card button:last-of-type').trigger('click')
    await flushPromises()
    expect(auth.updateAccountAvatar).toHaveBeenCalledWith(null)
    expect(wrapper.get('.account-initial-avatar').text()).toBe('O')
  })

  it('keeps the legacy dialog wrapper operational', async () => {
    const wrapper = mount(AccountSecurityDialog, {
      attachTo: document.body,
      props: { open: true },
    })

    expect(document.querySelector('[role="dialog"][aria-label="账号安全"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('.logout-button')!.click()
    await flushPromises()

    expect(auth.logout).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
