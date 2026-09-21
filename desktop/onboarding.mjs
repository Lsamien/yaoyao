import { normalizeServerURL } from './remote-login.mjs'

/** The native onboarding page owns one selected server and one in-flight action.
 * Credentials and CSRF/session tokens never appear in renderer snapshots. */
export class DesktopOnboarding {
  constructor(options) {
    this.options = options
    this.open()
  }
  get busy() { return ['preparing', 'authenticating', 'entering'].includes(this.state.phase) }
  snapshot() { return { ...this.state, history: [...this.state.history], busy: this.busy } }
  open({ mode = null, serverURL = '', remember = false, forceLogin = false } = {}) {
    if (this.state && this.busy) throw new Error('当前步骤尚未完成，请稍候')
    this.state = { active: true, mode, serverURL, remember, forceLogin, phase: 'idle', stage: 'checking',
      setupRequired: false, registrationAvailable: false, registrationNotice: '', authenticated: false, username: '', message: '', error: '',
      canForceSync: false, history: [] }
    return this.snapshot()
  }
  select(mode) {
    if (!['local', 'remote'].includes(mode)) throw new Error('请选择运行方式')
    return this.open({ mode, serverURL: this.options.remoteServer(), remember: this.state.remember })
  }
  serviceChanged(service) {
    if (!this.state.active || this.state.mode !== 'local') return
    this.state.stage = service.stage || this.state.stage
    this.state.message = service.message
    this.state.canForceSync = service.canForceSync === true
    if (this.state.history.at(-1) !== service.message) {
      this.state.history.push(service.message)
      this.state.history = this.state.history.slice(-30)
    }
    if (service.phase === 'error') {
      this.state.error = service.message
      // Keep the action locked until the outstanding prepare operation settles.
      if (!this.busy) this.state.phase = 'error'
    }
    if (['error', 'restarting', 'stopped', 'disconnected'].includes(service.phase)) {
      this.state.authenticated = false
      if (this.state.phase === 'ready') this.state.phase = 'error'
    }
  }
  async prepare({ serverURL = this.state.serverURL, remember = this.state.remember, force = false, autoEnter = false } = {}) {
    if (this.busy) throw new Error('当前步骤尚未完成，请稍候')
    const mode = this.state.mode
    if (!mode) throw new Error('请先选择服务器')
    Object.assign(this.state, { phase: 'preparing', error: '', authenticated: false,
      setupRequired: false, registrationAvailable: false, registrationNotice: '', remember: remember === true, stage: 'checking', canForceSync: false,
      message: mode === 'local' ? '正在检查本机环境…' : '正在检测服务器连接…' })
    try {
      const target = mode === 'local' ? await this.options.prepareLocal({ force }) : normalizeServerURL(serverURL)
      this.state.serverURL = target
      const info = await this.options.inspect(target)
      if (mode === 'remote' && info.setupRequired) throw new Error('远程服务器尚未初始化，请先在服务器本机创建管理员，再重新检测。')
      Object.assign(this.state, { phase: 'ready', stage: 'ready', setupRequired: info.setupRequired === true, registrationAvailable: info.registrationAvailable === true,
        authenticated: info.authenticated === true && !this.state.forceLogin, username: info.user?.username || '',
        message: mode === 'local' ? '本机服务已就绪' : '连接成功，服务器已就绪' })
      if (autoEnter && this.state.authenticated) await this.enter()
    } catch (error) {
      this.state.phase = 'error'
      this.state.error = error.message || '准备未完成，请重试'
    }
    return this.snapshot()
  }
  async submit({ username, password, confirmation, register = false, remember = this.state.remember } = {}) {
    if (this.state.phase !== 'ready') throw new Error('请先完成服务器检测')
    this.state.remember = remember === true
    this.state.error = ''
    if (register) return this.register({ username, password, confirmation })
    if (this.state.authenticated) return this.enter()
    if (!String(username || '').trim() || !password) throw new Error('请填写用户名和密码')
    if (this.state.setupRequired && (password.length < 8 || password !== confirmation))
      throw new Error(password.length < 8 ? '密码至少需要 8 个字符' : '两次输入的密码不一致')
    this.state.phase = 'authenticating'
    try {
      const result = await this.options.authenticate({ mode: this.state.mode, serverURL: this.state.serverURL,
        setup: this.state.mode === 'local' && this.state.setupRequired, username, password })
      this.state.authenticated = true
      this.state.username = result.username
      this.state.phase = 'ready'
      if (result.warning) {
        this.state.error = result.warning
        this.state.message = '账号已登录，可以继续进入夭夭'
      } else await this.enter()
    } catch (error) {
      this.state.phase = 'ready'
      this.state.error = error.message || '登录未完成，请重试'
    }
    return this.snapshot()
  }
  async register({ username, password, confirmation }) {
    if (!this.state.registrationAvailable || this.state.setupRequired || this.state.authenticated) throw new Error('当前服务器尚不支持子账号注册，请联系管理员初始化或升级。')
    if (!String(username || '').trim() || !password || password.length < 8 || password !== confirmation) throw new Error('请填写用户名及至少 8 位密码，并确认两次密码一致。')
    this.state.phase = 'authenticating'
    this.state.registrationNotice = ''
    try {
      await this.options.register({ serverURL: this.state.serverURL, username, password })
      this.state.registrationNotice = '注册成功，请等待管理员开通。开通后使用此账号登录。'
    } catch (error) { this.state.error = error.message || '注册失败，请重试。' }
    finally { this.state.phase = 'ready' }
    return this.snapshot()
  }
  async enter() {
    this.state.phase = 'entering'
    try {
      await this.options.activate(this.snapshot())
      this.state.active = false
      this.state.phase = 'complete'
      await this.options.navigate(this.state.serverURL)
    } catch (error) {
      this.state.active = true
      this.state.phase = 'ready'
      this.state.error = error.message || '打开服务未完成，请重试'
    }
    return this.snapshot()
  }
}
