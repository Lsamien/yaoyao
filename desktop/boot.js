function display(state) {
  document.getElementById('status').textContent = state.message
  document.getElementById('actions').hidden = !['error','stopped','disconnected'].includes(state.phase)
  document.getElementById('retry').textContent = state.phase === 'disconnected' ? '重新连接' : state.phase === 'stopped' ? '启动后台服务' : '重试'
  document.getElementById('status').setAttribute('role', state.phase === 'error' ? 'alert' : 'status')
  document.querySelector('main').setAttribute('aria-busy', String(['starting','restarting','stopping'].includes(state.phase)))
}
async function render() {
  try { display(await window.yaoyaoDesktop.status()) }
  catch { display({ phase: 'error', message: '无法读取启动状态，请重试或查看服务日志。' }) }
}
document.getElementById('retry').onclick = async () => {
  document.getElementById('retry').disabled = true
  try { await window.yaoyaoDesktop.retry(); await render() }
  catch { display({ phase: 'error', message: '启动未完成，请重试或查看服务日志。' }) }
  finally { document.getElementById('retry').disabled = false }
}
document.getElementById('logs').onclick = () => window.yaoyaoDesktop.logs()
void render();setInterval(() => { void render() }, 500)
