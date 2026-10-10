// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopHostCore } from '../../desktop/environment-host.mjs'
import { authorizeCurrentComputer } from '../../desktop/computer-authorization.mjs'
import { dialog } from 'electron'

vi.mock('electron', () => ({
  app: { isPackaged: false }, BrowserWindow: class {}, session: {},
  desktopCapturer: {}, shell: {},
  dialog: { showMessageBox: vi.fn() },
  screen: { on: vi.fn(), removeListener: vi.fn() },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
}))
let home: string, core: any
const owner = 'a'.repeat(64)
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'native-authorization-'))
  core = new DesktopHostCore({ root: home, dataRoot: home })
  core.platform = { computer: true }
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
})
afterEach(async () => { await core.close(); rmSync(home, { recursive: true, force: true }); vi.clearAllMocks() })
const request = (scope = 'full', isCurrent = () => true, context = { owner, account: '当前账号' }) => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => context })
  return { fetchImpl, promise: authorizeCurrentComputer({ scope, core, origin: 'https://example.test', cookies: [{ name: 'session', value: 'test' }], fetchImpl, isCurrent }) }
}
it('grants only the current native core after reading the authenticated account context', async () => {
  const { promise, fetchImpl } = request()
  await expect(promise).resolves.toEqual({ ok: true })
  expect(core.approvedFull.has(owner)).toBe(true)
  expect(core.approved.size).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'computer-permissions.json'), 'utf8'))).toEqual({ screen: [], full: [owner] })
  expect(fetchImpl.mock.calls[0][0].pathname).toBe('/api/app/desktop-environment/authorization')
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' })
})
it('rejects server-dispatched authorization without showing a dialog', async () => {
  await expect(core.execute({ operation: 'authorize', scope: 'full', owner, deadline: Date.now() + 10000 })).rejects.toThrow('当前设备')
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
  expect(core.approvedFull.size).toBe(0)
})
it('does not grant if the client connection changes while confirmation is open', async () => {
  let current = true
  vi.mocked(dialog.showMessageBox).mockImplementation(async () => { current = false; return { response: 1, checkboxChecked: false } })
  await expect(request('full', () => current).promise).rejects.toThrow('已取消')
  expect(core.approvedFull.size).toBe(0)
})
it('rejects an all-devices scope before fetching or confirming', async () => {
  const { promise, fetchImpl } = request('all')
  await expect(promise).rejects.toThrow('授权范围无效')
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
})
it('leaves grants unchanged when confirmation is cancelled', async () => {
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
  await expect(request().promise).rejects.toThrow('已取消')
  expect(core.approvedFull.size).toBe(0)
})
