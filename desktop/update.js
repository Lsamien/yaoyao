const byId = id => document.getElementById(id)
let closed = false
let localError = '', previousPhase = ''
const sizeLabel = value => value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`
function render(state) {
  const busy = ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(state.phase)
  const ready = state.phase === 'ready'
  const automatic = state.installMode === 'restart'
  byId('current').textContent = `${state.currentVersion} · ${state.arch}`
  byId('latest').textContent = state.latestVersion || (state.phase === 'failed' ? '检查失败' : '待检查')
  byId('status').textContent = state.message
  byId('error').hidden = !(state.error || localError); byId('error').textContent = state.error || localError
  byId('subtitle').textContent = automatic ? '更新当前电脑的 App，下载完成后重启安装。' : '开发运行：从 GitHub 下载，校验后手动安装。'
  byId('check').disabled = busy || (automatic && ready) || state.retryable === false
  byId('download').disabled = busy || !state.available; byId('download').hidden = ready
  byId('download').textContent = automatic ? '下载更新' : state.phase === 'failed' || state.phase === 'cancelled' ? '重试下载' : '下载 DMG'
  byId('cancel').hidden = automatic ? !state.canCancel : !busy
  byId('open').hidden = !ready || automatic; byId('folder').hidden = !ready || automatic
  byId('install').hidden = !automatic || (!ready && state.phase !== 'installing')
  byId('install').disabled = !ready || busy
  byId('install').textContent = state.phase === 'installing' ? '正在重启…' : '重启更新'
  byId('progress').hidden = !['downloading', 'verifying', 'preparing'].includes(state.phase)
  byId('progress').max = state.total || 1
  if (state.total && state.phase === 'downloading') byId('progress').value = state.received || 0
  else byId('progress').removeAttribute('value')
  byId('bytes').textContent = state.received ? `${sizeLabel(state.received)} / ${sizeLabel(state.total)}` : ''
  byId('bytes').hidden = !['downloading', 'verifying', 'preparing'].includes(state.phase)
  byId('notes-section').hidden = !state.notes; byId('notes').textContent = state.notes || ''
  if (state.phase !== previousPhase && ['download', 'cancel'].includes(document.activeElement?.id)) {
    if (ready) byId(automatic ? 'install' : 'open').focus()
    else if (!busy) byId(state.available ? 'download' : 'check').focus()
  }
  previousPhase = state.phase
}
async function action(name) {
  if (name !== 'state') localError = ''
  try { const state = await window.yaoyaoUpdate[name](); if (state && !closed) render(state) }
  catch (error) { if (!closed) { localError = error.message; byId('error').hidden = false; byId('error').textContent = localError } }
}
for (const name of ['check', 'download', 'cancel', 'install', 'open', 'folder', 'release']) byId(name).addEventListener('click', () => void action(name))
const timer = setInterval(() => void action('state'), 500)
window.addEventListener('unload', () => { closed = true; clearInterval(timer) })
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close() })
// Reopening the window must preserve an active download or staged update.
void (async () => {
  try {
    const state = await window.yaoyaoUpdate.state()
    if (closed) return
    render(state)
    if (state.phase === 'idle') await action('check')
  } catch (error) { if (!closed) { byId('error').hidden = false; byId('error').textContent = error.message } }
})()
