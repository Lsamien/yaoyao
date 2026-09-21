import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

test('the first paint and every restoring snapshot hide the entire login guide', async () => {
  const html = await readFile(new URL('./boot.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('./boot.js', import.meta.url), 'utf8')
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const { window } = dom
  const guide = window.document.getElementById('onboarding')
  const loading = window.document.getElementById('session-loading')
  let respond, poll
  window.yaoyaoDesktop = { status: () => new Promise(resolve => { respond = resolve }) }
  window.setInterval = callback => { poll = callback; return 1 }
  try {
    assert.equal(guide.hidden, true, 'HTML hides the guide before JavaScript or IPC runs')
    assert.equal(loading.hidden, false)
    window.eval(script)
    for (const phase of ['idle', 'preparing', 'ready', 'entering', 'complete']) {
      respond({ phase, restoring: true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(guide.hidden, true, phase)
      assert.equal(loading.hidden, false, phase)
      poll()
    }
    respond({ mode: 'remote', phase: 'ready', restoring: false, history: [], serverURL: 'http://remote.test' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(guide.hidden, false, 'an expired session shows the account form')
    assert.equal(loading.hidden, true)
    assert.equal(window.document.getElementById('login-form').hidden, false)
  } finally { window.close() }
})
