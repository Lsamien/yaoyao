const byId = id => document.getElementById(id)
const form = byId('login-form')
const preset = new URLSearchParams(location.search).get('server')
if (preset) byId('server').value = preset
form.addEventListener('submit', async event => {
  event.preventDefault()
  const error = byId('error'), status = byId('status'), submit = byId('submit')
  error.hidden = true; status.hidden = false; status.textContent = '正在登录…'; submit.disabled = true
  try {
    const result = await window.yaoyaoRemoteLogin.submit({
      serverURL: byId('server').value,
      username: byId('username').value,
      password: byId('password').value,
    })
    if (!result.ok) throw new Error(result.error || '登录失败')
    status.textContent = result.hostRegistered ? '登录成功，已注册本机为电脑…' : '登录成功…'
  } catch (cause) {
    status.hidden = true; error.hidden = false
    error.textContent = cause instanceof Error ? cause.message : '登录失败'
    submit.disabled = false
  }
})
byId('use-local').addEventListener('click', () => { void window.yaoyaoRemoteLogin.useLocal() })
