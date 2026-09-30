import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
// Both staged variants coexist after packaging. The source entry must use the
// requested variant's manifest and policy without moving either build marker.
for (const clientOnly of [false, true]) {
  test(`source entry selects the ${clientOnly ? 'client' : 'full'} staged variant`, { timeout: 45000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'yaoyao-source-entry-'))
    let app
    try {
      app = await electron.launch({ args: [root], cwd: root, env: { ...process.env,
        HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_TEST_MODE: 'ask',
        HERMES_YAOYAO_DESKTOP_CLIENT_ONLY: clientOnly ? '1' : '0', HERMES_YAOYAO_DESKTOP_PORT: '1',
        HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0' }, timeout: 30000 })
      const page = await app.firstWindow()
      await page.waitForURL(/boot\.html$/)
      assert.equal(await app.evaluate(({ app }) => app.getName()), clientOnly ? '夭夭' : '夭夭完整版')
      const state = await page.evaluate(() => window.yaoyaoDesktop.status())
      assert.deepEqual(state.supportedModes, !clientOnly && process.platform === 'darwin' ? ['client', 'server'] : ['client'])
      assert.equal(state.mode, !clientOnly && process.platform === 'darwin' ? null : 'remote')
    } finally {
      await app?.close().catch(() => {})
      await rm(home, { recursive: true, force: true })
    }
  })
}
