const api = window.yaoyaoDesktop
const $ = id => document.getElementById(id)
let registering = false
let state, initialized = false, pending = false, serverDirty = false, generation = 0, actionError = ''

function display(next) {
  state = next
  if (!initialized) {
    $('server').value = state.serverURL || ''
    $('remember').checked = state.remember
    initialized = true
  }
  const busy = pending || state.busy
  const local = state.mode === 'local'
  const ready = ['ready', 'authenticating', 'entering'].includes(state.phase) && !serverDirty
  const setup = ready && state.setupRequired
  const confirm = setup || registering
  const accountTitle = setup ? '创建管理员' : registering ? '注册子账号' : '登录账号'
  $('register-toggle').hidden = !ready || setup || state.authenticated
  $('register-toggle').disabled = busy
  $('register-toggle').textContent = registering ? '已有账号？返回登录' : '没有账号？注册子账号'
  $('registration-notice').textContent = state.registrationNotice || ''
  $('registration-notice').hidden = !ready || !state.registrationNotice
  $('mode-options').disabled = busy
  for (const input of document.querySelectorAll('[name=mode]')) input.checked = input.value === state.mode
  $('remember').disabled = busy
  $('prepare-section').classList.toggle('pending', !state.mode)
  $('prepare-section').classList.toggle('local-ready', local && ready)
  $('prepare-heading').textContent = local ? '准备本机服务' : state.mode ? '连接服务器' : '准备服务'
  $('choose-hint').hidden = !!state.mode
  $('local-panel').hidden = !local
  $('connection-form').hidden = state.mode !== 'remote'
  $('server').disabled = busy
  $('detect').disabled = busy || !$('server').value.trim()
  $('detect').textContent = busy && !ready ? '正在检测…' : ready ? '重新检测' : '检测连接'
  $('prepare-local').hidden = !local || state.phase !== 'idle'
  $('prepare-local').disabled = busy
  $('actions').hidden = !local || state.phase !== 'error'
  $('retry').disabled = busy
  $('force-sync').hidden = !state.canForceSync
  $('force-sync').disabled = busy
  const preparationError = !ready && !serverDirty && (actionError || state.error)
  $('status').textContent = preparationError || (serverDirty ? '服务器地址已更改，请重新检测。' : state.message)
  $('status').setAttribute('role', preparationError ? 'alert' : 'status')
  $('status').classList.toggle('success', ready && !preparationError)
  $('prepare-section').setAttribute('aria-busy', String(busy && !ready))
  $('account-heading').textContent = accountTitle
  $('account-step-title').textContent = accountTitle
  $('account-section').classList.toggle('pending', !ready)
  $('account-section').setAttribute('aria-busy', String(busy && ready))
  $('account-hint').textContent = !ready ? '服务准备完成后，在此创建账号或登录。'
    : state.authenticated ? `已登录${state.username ? `：${state.username}` : ''}，可以继续进入夭夭。`
    : setup ? '首次使用，请设置管理员账号和密码。密码至少 8 个字符。' : registering ? '子账号仅可使用 Bot 模式，注册后需管理员分配机器人并开通。' : '登录所选服务器的夭夭账号。'
  $('login-form').hidden = !ready
  $('credentials').hidden = state.authenticated
  $('confirmation-field').hidden = !confirm
  $('username').disabled = busy || state.authenticated || !ready
  $('password').disabled = busy || state.authenticated || !ready
  $('confirmation').disabled = busy || !confirm || state.authenticated
  $('confirmation').required = confirm && !state.authenticated
  $('password').minLength = confirm ? 8 : 1
  $('password').autocomplete = confirm ? 'new-password' : 'current-password'
  $('toggle-password').disabled = busy
  $('submit').disabled = busy
  $('submit').querySelector('span').textContent = state.phase === 'authenticating' ? (confirm ? '正在提交…' : '正在登录…')
    : state.phase === 'entering' ? '正在进入…' : state.authenticated ? '进入夭夭' : setup ? '创建并进入夭夭' : registering ? '注册子账号' : '登录并进入夭夭'
  $('login-error').textContent = ready ? actionError || state.error : ''
  $('login-error').hidden = !$('login-error').textContent
  $('waiting').hidden = !busy || ready
  $('waiting').textContent = local ? '正在准备服务，请稍候' : '正在检测连接，请稍候'
  const activeStep = ready ? 2 : state.mode ? 1 : 0
  for (const [index, id] of ['step-choice', 'step-prepare', 'step-account'].entries()) {
    $(id).classList.toggle('complete', index < activeStep)
    if (index === activeStep) $(id).setAttribute('aria-current', 'step')
    else $(id).removeAttribute('aria-current')
  }
  const stages = ['checking', 'installing', 'starting']
  const current = stages.indexOf(state.stage)
  for (const [index, row] of [...document.querySelectorAll('[data-stage]')].entries()) {
    const complete = ready || (state.phase !== 'idle' && index < current)
    const active = !complete && state.phase === 'preparing' && index === current
    row.classList.toggle('complete', complete)
    row.classList.toggle('active', active)
    row.querySelector('use').setAttribute('href', `boot-icons.svg#${complete ? 'check' : active ? 'loader' : 'circle'}`)
    row.querySelector('small').textContent = complete ? '已完成' : active ? '进行中' : state.phase === 'error' && index === current ? '未完成' : '等待中'
  }
  $('install-progress').hidden = !local || state.phase !== 'preparing'
  document.querySelector('.install-steps').hidden = local && ready
  const history = state.history?.join('\n') || '准备开始'
  if ($('install-log').textContent !== history) $('install-log').textContent = history
}

async function action(run, { resetServer = false, focusAccount = false } = {}) {
  if (pending) return
  pending = true; actionError = ''; generation++
  if (state) display(state)
  try {
    const next = await run()
    if (resetServer) {
      if (next.phase === 'ready') $('server').value = next.serverURL || ''
      serverDirty = false
    }
    display(next)
  } catch (error) {
    actionError = error.message || '操作未完成，请重试。'
  } finally {
    pending = false
    if (state) display(state)
    if (focusAccount && state?.phase === 'ready' && !state.authenticated) $('username').focus()
  }
}
for (const input of document.querySelectorAll('[name=mode]')) input.addEventListener('change', () => {
  $('login-form').reset(); $('password').type = 'password'
  $('toggle-password').setAttribute('aria-pressed', 'false'); $('toggle-password').setAttribute('aria-label', '显示密码')
  $('password').removeAttribute('aria-invalid'); $('confirmation').removeAttribute('aria-invalid')
  serverDirty = false; registering = false
  void action(() => api.selectServer(input.value))
})
$('server').addEventListener('input', () => {
  serverDirty = true; registering = false; actionError = ''
  // Credentials belong to the checked server, never carry them to a new address.
  $('login-form').reset(); $('password').type = 'password'
  $('toggle-password').setAttribute('aria-pressed', 'false'); $('toggle-password').setAttribute('aria-label', '显示密码')
  if (state) display(state)
})
$('connection-form').addEventListener('submit', event => {
  event.preventDefault()
  void action(() => api.prepareServer({ serverURL: $('server').value, remember: $('remember').checked }), { resetServer: true, focusAccount: true })
})
$('prepare-local').onclick = () => action(() => api.prepareServer({ remember: $('remember').checked }), { focusAccount: true })
$('retry').onclick = () => action(() => api.prepareServer({ remember: $('remember').checked }), { focusAccount: true })
$('force-sync').onclick = () => action(() => api.forceSync(), { focusAccount: true })
$('logs').onclick = async () => { try { await api.logs() } catch (error) { actionError = error.message; display(state) } }
$('toggle-password').onclick = () => {
  const show = $('password').type === 'password'
  $('password').type = show ? 'text' : 'password'
  $('toggle-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
  $('toggle-password').setAttribute('aria-pressed', String(show))
}
$('confirmation').addEventListener('blur', () => {
  const mismatch = $('confirmation').value && $('confirmation').value !== $('password').value
  $('confirmation').setAttribute('aria-invalid', String(!!mismatch))
  actionError = mismatch ? '两次输入的密码不一致' : ''
  display(state)
})
$('login-form').addEventListener('submit', event => {
  event.preventDefault()
  if (serverDirty || pending) return
  if ((state.setupRequired || registering) && !state.authenticated && $('confirmation').value !== $('password').value) {
    actionError = '两次输入的密码不一致'; $('confirmation').setAttribute('aria-invalid', 'true'); display(state); $('confirmation').focus(); return
  }
  void action(async () => {
    const next = await api.login({ username: $('username').value, password: $('password').value,
      confirmation: $('confirmation').value, register: registering, remember: $('remember').checked })
    $('password').value = ''; $('confirmation').value = ''
    if (registering && !next.error) registering = false
    return next
  })
})
$('register-toggle').onclick = () => {
  if (!state.registrationAvailable) { actionError = '当前服务器尚不支持子账号注册，请联系管理员升级。'; display(state); return }
  registering = !registering; actionError = ''; state.error = ''; state.registrationNotice = ''
  $('password').value = ''; $('confirmation').value = ''; display(state); $('username').focus()
}
$('help-button').onclick = () => {
  $('help').hidden = !$('help').hidden
  $('help-button').setAttribute('aria-expanded', String(!$('help').hidden))
}
async function render() {
  const request = generation
  try { const next = await window.yaoyaoDesktop.status(); if (request === generation) display(next) }
  catch { if (!state) { $('status').textContent = '无法读取启动状态，请重新打开应用。'; $('status').setAttribute('role', 'alert') } }
}
void render()
const poll = setInterval(() => { void render() }, 500)
window.addEventListener('pagehide', () => clearInterval(poll), { once: true })
