// The startup/login page uses the same process-wide updater as the workspace.
// It remains usable even when no server is reachable.
(() => {
  const desktop = window.yaoyaoDesktop
  if (!desktop?.updateState || document.querySelector('[data-desktop-update-inline]') || window.__yaoyaoInlineUpdate) return
  window.__yaoyaoInlineUpdate = true
  let entry = document.getElementById('desktop-update-entry')
  const fallback = !entry
  if (fallback) {
    entry = document.createElement('section')
    entry.id = 'desktop-update-entry'
    entry.className = 'desktop-update-entry desktop-update-fallback'
    entry.hidden = true
    entry.setAttribute('aria-label', 'App 更新')
    entry.innerHTML = '<button id="desktop-update-action" type="button"><svg id="desktop-update-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="update-track" cx="12" cy="12" r="9"/><circle id="desktop-update-value" cx="12" cy="12" r="9" pathLength="100"/></svg><span id="desktop-update-label" aria-live="polite">检测更新</span><span id="desktop-update-dot" hidden aria-hidden="true"></span></button><p id="desktop-update-error" role="alert" hidden></p>'
    document.body.append(entry)
  }
  const button = document.getElementById('desktop-update-action')
  const label = document.getElementById('desktop-update-label')
  const ring = document.getElementById('desktop-update-ring')
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.id = 'desktop-update-icon'
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  button.prepend(icon)
  const value = document.getElementById('desktop-update-value')
  const dot = document.getElementById('desktop-update-dot')
  const error = document.getElementById('desktop-update-error')
  let state, pending = false, closed = false, requested = false, reading = false, localError = ''
  let observer
  function stop() {
    closed = true; clearInterval(timer); detach(); observer?.disconnect()
    if (fallback) entry.remove()
  }
  function render() {
    if (!state || closed) return
    const busy = pending || ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(state.phase)
    const percent = state.phase === 'downloading' && state.total > 0 ? Math.max(0, Math.min(100, Math.floor(state.received / state.total * 100))) : undefined
    const hasUpdate = state.available || ['downloading', 'verifying', 'preparing', 'ready', 'installing'].includes(state.phase) || (state.phase === 'failed' && state.latestVersion)
    entry.hidden = entry.classList.contains('desktop-update-toolbar') ? !hasUpdate
      : !hasUpdate && !requested && !localError && state.phase !== 'failed'
    label.textContent = state.phase === 'ready' ? state.installMode === 'restart' ? '重新启动' : '打开安装包'
      : state.phase === 'installing' ? '正在重启…'
      : state.phase === 'downloading' ? percent === undefined ? '正在下载…' : `正在下载 · ${percent}%`
      : ['verifying', 'preparing'].includes(state.phase) ? '正在准备…'
      : busy ? '正在检测…' : state.retryable === false ? '更新未完成'
      : state.available ? '可更新' : state.phase === 'failed' || localError ? '重试更新'
      : state.phase === 'checked' ? '已是最新版本' : '检测更新'
    button.disabled = busy || state.retryable === false
    button.setAttribute('aria-label', label.textContent)
    button.setAttribute('aria-busy', String(busy))
    button.title = localError || state.error || (state.phase === 'ready'
      ? state.installMode === 'restart' ? '更新已下载，点击重新启动完成安装' : '更新已下载，点击打开安装包'
      : busy ? label.textContent : state.available ? `App ${state.latestVersion || ''} 可更新，点击下载` : state.message)
    entry.title = button.title
    entry.classList.toggle('desktop-update-ready', state.phase === 'ready')
    icon.toggleAttribute('hidden', busy)
    icon.innerHTML = state.phase === 'ready' && state.installMode === 'restart'
      ? '<path d="M20 7v5h-5M4 17v-5h5M5.1 9a8 8 0 0 1 13-3l2 2M18.9 15a8 8 0 0 1-13 3l-2-2"/>'
      : '<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>'
    ring.toggleAttribute('hidden', !busy)
    ring.classList.toggle('update-spinning', busy && percent === undefined)
    ring.setAttribute('role', busy ? 'progressbar' : 'img')
    ring.setAttribute('aria-label', label.textContent)
    if (busy) ring.removeAttribute('aria-hidden')
    else ring.setAttribute('aria-hidden', 'true')
    ring.setAttribute('aria-valuemin', '0'); ring.setAttribute('aria-valuemax', '100')
    if (percent === undefined) ring.removeAttribute('aria-valuenow')
    else ring.setAttribute('aria-valuenow', String(percent))
    value.setAttribute('stroke-dasharray', `${busy ? percent ?? 25 : 100} 100`)
    dot.hidden = !(state.available || state.phase === 'ready') || busy
    error.textContent = localError || state.error || ''; error.hidden = !error.textContent
  }
  async function refresh() {
    if (reading || closed) return
    if (fallback && document.querySelector('[data-desktop-update-inline]')) {
      stop()
      return
    }
    if (fallback) {
      const bell = document.querySelector('.desktop-sidebar .unread-entry')
      if (bell && bell.nextElementSibling !== entry) {
        bell.after(entry)
        entry.classList.remove('desktop-update-fallback')
        entry.classList.add('desktop-update-toolbar')
      }
    }
    reading = true
    try { state = await desktop.updateState(); render() } catch { /* Poll again after navigation settles. */ }
    finally { reading = false }
  }
  button.addEventListener('click', async () => {
    if (pending || !state || button.disabled) return
    const action = state.phase === 'ready' ? state.installMode === 'restart' ? 'install' : 'open' : state.available ? 'download' : 'check'
    pending = true; localError = ''; render()
    try {
      const operation = desktop.updateAction(action)
      void refresh()
      const next = await operation
      if (next) state = next
    } catch (cause) { localError = cause.message || '更新未完成，请重试' }
    finally { pending = false; render() }
  })
  const detach = desktop.onUpdateRequested(() => { requested = true; void refresh() })
  const timer = setInterval(() => void refresh(), 500)
  if (fallback) {
    observer = new MutationObserver(() => {
      if (document.querySelector('[data-desktop-update-inline]')) stop()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-desktop-update-inline'] })
  }
  window.addEventListener('unload', stop)
  void refresh()
})()
