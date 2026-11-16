import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import NodePairingPanel from '@/components/app/NodePairingPanel.vue'
import { accountPairingStatus, createAccountPairing } from '@/api/accountPairing'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,cXItY29kZQ=='),
  },
}))

vi.mock('@/api/accountPairing', () => ({
  accountPairingStatus: vi.fn(),
  createAccountPairing: vi.fn(),
}))


beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-29T04:00:00.000Z'))
  vi.mocked(createAccountPairing).mockResolvedValue({
    protocolVersion: 1,
    serviceType: 'hermes-yaoyao',
    pairingId: 'account-pairing-1',
    expiresAt: Date.now() + 60_000,
    qrPayload: 'yaoyao://login?v=1&id=account-pairing-1',
  })
  vi.mocked(accountPairingStatus).mockResolvedValue({ state: 'pending' })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
})

describe('NodePairingPanel', () => {
  it('account 模式只创建账号登录二维码，并在停用时清理轮询', async () => {
    const wrapper = mount(NodePairingPanel, {
      attachTo: document.body,
      props: { active: true, mode: 'account', userName: 'admin' },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()

    expect(createAccountPairing).toHaveBeenCalledOnce()
    expect(QRCode.toDataURL).toHaveBeenCalledWith(
      'yaoyao://login?v=1&id=account-pairing-1',
      expect.objectContaining({ width: 296, margin: 2, errorCorrectionLevel: 'M' }),
    )
    expect(wrapper.text()).toContain('在 iOS 登录页选择扫码')
    expect(vi.getTimerCount()).toBe(1)

    await wrapper.setProps({ active: false })
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    wrapper.unmount()
  })


})
