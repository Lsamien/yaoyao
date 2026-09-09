const byId = id => document.getElementById(id)
let closed = false
let localError = '', previousPhase = ''
const sizeLabel = value => value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`
function render(state) {
  const busy = ['checking', 'downloading', 'verifying'].includes(state.phase)
  const ready = state.phase === 'ready'
  byId('current').textContent = `${state.currentVersion} · ${state.arch}`
  byId('latest').textContent = state.latestVersion || (state.phase === 'failed' ? '检查失败' : '待检查')
  byId('status').textContent = state.message
  byId('error').hidden = !(state.error || localError); byId('error').textContent = state.error || localError
  byId('check').disabled = busy
  byId('download').disabled = busy || !state.available; byId('download').hidden = ready
  byId('download').textContent = state.phase === 'failed' || state.phase === 'cancelled' ? '重试下载' : '下载 DMG'
  byId('cancel').hidden = !busy
  byId('open').hidden = !ready; byId('folder').hidden = !ready
  byId('progress').hidden = !['downloading', 'verifying'].includes(state.phase)
  byId('progress').max = state.total || 1; byId('progress').value = state.received || 0
  byId('bytes').textContent = state.received ? `${sizeLabel(state.received)} / ${sizeLabel(state.total)}` : ''
  byId('notes-section').hidden = !state.notes; byId('notes').textContent = state.notes || ''
  if (state.phase !== previousPhase && ['download', 'cancel'].includes(document.activeElement?.id)) {
    if (ready) byId('open').focus()
    else if (!busy) byId(state.available ? 'download' : 'check').focus()
  }
  previousPhase = state.phase
}
async function action(name) {
  if (name !== 'state') localError = ''
  try { const state = await window.yaoyaoUpdate[name](); if (state && !closed) render(state) }
  catch (error) { if (!closed) { localError = error.message; byId('error').hidden = false; byId('error').textContent = localError } }
}
for (const name of ['check', 'download', 'cancel', 'open', 'folder', 'release']) byId(name).addEventListener('click', () => void action(name))
const timer = setInterval(() => void action('state'), 500)
window.addEventListener('unload', () => { closed = true; clearInterval(timer) })
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close() })
void action('check')
