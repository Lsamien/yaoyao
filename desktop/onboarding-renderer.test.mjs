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

test('only the active page is shown; back retains server and remembered choice; expired sessions open login directly', async () => {
  const { DesktopOnboarding } = await import('./onboarding.mjs')
  const html = await readFile(new URL('./boot.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('./boot.js', import.meta.url), 'utf8')
  const dom = new JSDOM(html, {runScripts:'outside-only',url:'https://preview.test'})
  const w=dom.window, $=id=>w.document.getElementById(id)
  const flow = new DesktopOnboarding({ remoteServer:()=>'',inspect:async()=>({authenticated:false}) })
  w.yaoyaoDesktop={status:async()=>flow.snapshot(),selectServer:async mode=>flow.select(mode),prepareServer:input=>flow.prepare(input)}
  w.setInterval=()=>1
  const tick=()=>new Promise(resolve=>setImmediate(resolve))
  const visible=()=>['choice-section','prepare-section','account-section'].filter(id=>!$(id).hidden)
  try {
    w.eval(script);await tick()
    assert.deepEqual(visible(),['choice-section'])
    w.document.querySelector('[value=remote]').click();$('remember').checked=true;$('continue').click();await tick()
    assert.deepEqual(visible(),['prepare-section'])
    $('server').value='https://server.test';$('server').dispatchEvent(new w.Event('input'))
    $('connection-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick()
    assert.deepEqual(visible(),['account-section'])
    $('change-server').click();await tick()
    assert.deepEqual(visible(),['prepare-section'])
    assert.equal($('server').value,'https://server.test');assert.equal($('remember').checked,true)
    $('back').click();await tick()
    assert.deepEqual(visible(),['choice-section'])
  } finally {w.close()}
})
