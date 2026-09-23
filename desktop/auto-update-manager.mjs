const releasePageUrl = 'https://github.com/Lsamien/yaoyao/releases'
const busyPhases = new Set(['checking', 'downloading', 'preparing', 'installing'])

function errorMessage(error) {
  const message = String(error?.message || error || '未知错误')
  if (/404|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ZIP file not provided/i.test(message))
    return '该版本尚未提供完整的自动更新包，请到发布页下载安装。'
  if (/signature|code.?sign|指定的要求|签名/i.test(message))
    return '安装包签名验证失败，请到发布页安装正式签名版本。'
  if (/ENOTFOUND|ECONN|ETIMEDOUT|ERR_INTERNET|net::|timeout/i.test(message))
    return '无法连接更新服务器，请检查网络后重试。'
  if (/sha512|checksum|digest/i.test(message)) return '安装包完整性校验失败，请重新下载。'
  // Keep HTTP dumps and remote HTML out of the product's error area.
  return message.split('\n')[0].slice(0, 240)
}

/** Process-wide desktop updates; independent of server identity and login.
 * The patched MacUpdater resolves downloadUpdate only after native staging.
 * Native staging cannot be canceled or retried safely in the same process. */
export class DesktopAutoUpdateManager {
  constructor({ driver, version, arch = process.arch, platform = process.platform, prepareInstall = async () => {}, recoverInstall = async () => {}, stagingTimeout = 300000, restartTimeout = 120000 }) {
    Object.assign(this, { driver, platform, prepareInstall, recoverInstall, stagingTimeout, restartTimeout })
    this.state = { phase: 'idle', installMode: 'restart', currentVersion: version, arch, available: false,
      received: 0, total: 0, message: '点击检查 App 更新', releasePageUrl, retryable: true }
    driver.autoDownload = false
    // NSIS installation must follow our explicit connection/process cleanup.
    driver.autoInstallOnAppQuit = platform !== 'win32'
    driver.autoRunAppAfterInstall = true
    driver.allowPrerelease = false
    driver.allowDowngrade = false
    driver.on('error', error => {
      if (this.operation || this.nativeStarted) this.failure(error)
    })
    driver.on('download-progress', progress => {
      if (this.operation !== 'downloading' || this.nativeStarted || this.recoveryRequired || this.cancelled) return
      this.set({ received: progress.transferred || 0, total: progress.total || 0, message: '正在下载 App 更新…' })
    })
    driver.on('update-downloaded', () => {
      if (this.operation !== 'downloading' || this.recoveryRequired || this.cancelled) return
      this.nativeStarted = true
      this.set({ phase: 'preparing', message: platform === 'win32' ? '下载完成，正在核对安装包…' : '下载完成，正在验证签名并准备安装…' })
      if (platform !== 'win32') {
        this.stagingTimer = setTimeout(() => this.failure(new Error('准备更新超时')), this.stagingTimeout)
        this.stagingTimer.unref?.()
      }
    })
  }
  set(patch) { this.state = { ...this.state, ...patch } }
  snapshot() { return { ...this.state, canCancel: this.state.phase === 'downloading' && !this.nativeStarted } }
  get busy() { return busyPhases.has(this.state.phase) }
  startChecking() {
    if (this.firstCheck || this.checkTimer) return
    this.firstCheck = setTimeout(() => { this.firstCheck = undefined; void this.check(false) }, 15000)
    this.checkTimer = setInterval(() => void this.check(false), 3600000)
    this.firstCheck.unref?.(); this.checkTimer.unref?.()
  }
  stopChecking() {
    clearTimeout(this.firstCheck); clearInterval(this.checkTimer)
    this.firstCheck = this.checkTimer = undefined
  }
  async check(manual = true) {
    if (this.operation === 'checking' && manual) this.manual = true
    if (this.operation || this.nativeStarted || this.recoveryRequired || (!manual && ['failed', 'cancelled'].includes(this.state.phase))) return this.snapshot()
    this.operation = 'checking'; this.manual = manual; this.cancelled = false; this.failed = false
    this.set({ phase: 'checking', available: false, latestVersion: undefined, notes: '', error: undefined,
      retryable: true, received: 0, total: 0, message: '正在检查 App 更新…' })
    try {
      const result = await this.driver.checkForUpdates()
      if (this.failed) return this.snapshot()
      if (!result) throw new Error('当前运行环境不支持自动更新，请使用正式安装的 App')
      this.token = result.cancellationToken
      const info = result.updateInfo
      const available = result.isUpdateAvailable === true
      const notes = typeof info?.releaseNotes === 'string' ? info.releaseNotes
        : Array.isArray(info?.releaseNotes) ? info.releaseNotes.map(note => note.note || '').join('\n\n') : ''
      this.set({ phase: 'checked', latestVersion: info?.version, available, notes,
        message: available ? `发现 App ${info.version}，下载后可重启更新` : '当前 App 已是最新版本' })
    } catch (error) { this.failure(error) }
    finally { this.operation = undefined }
    return this.snapshot()
  }
  cancel() {
    if (this.state.phase !== 'downloading' || this.nativeStarted || !this.token) return
    this.cancelled = true
    this.token.cancel()
  }
  async download() {
    if (this.operation || this.nativeStarted || this.recoveryRequired || !this.state.available) return this.snapshot()
    this.operation = 'downloading'; this.cancelled = false; this.manual = true; this.failed = false
    this.set({ phase: 'downloading', received: 0, total: 0, error: undefined, message: '正在连接下载服务器…' })
    try {
      await this.driver.downloadUpdate(this.token)
      if (this.cancelled) this.set({ phase: 'cancelled', message: '下载已取消，可重新检查更新后下载', available: false })
      else if (!this.recoveryRequired && !this.failed) {
        if (!this.nativeStarted) throw new Error('安装包尚未完成准备，请重新检查更新')
        this.set({ phase: 'ready', available: false, message: '更新已准备完成，点击“重启更新”完成安装。' })
      }
    } catch (error) {
      if (this.cancelled && !this.nativeStarted) this.set({ phase: 'cancelled', message: '下载已取消，可重新检查更新后下载', available: false, error: undefined })
      else this.failure(error)
    } finally { clearTimeout(this.stagingTimer); this.operation = undefined }
    return this.snapshot()
  }
  async recover() {
    if (this.recovery) return this.recovery
    if (!this.installAttempted || !this.installPrepared) return
    this.installAttempted = false
    this.recovery = Promise.resolve().then(() => this.recoverInstall()).catch(error => this.driver.logger?.error?.(error))
    return this.recovery
  }
  failure(error) {
    if (this.recoveryRequired || this.cancelled) return
    this.failed = true
    clearTimeout(this.stagingTimer); clearTimeout(this.restartTimer)
    this.recoveryRequired = Boolean(this.nativeStarted && (this.platform !== 'win32' || this.installAttempted))
    if (this.platform === 'win32' && !this.recoveryRequired) this.nativeStarted = false
    const suffix = this.recoveryRequired ? ' 请退出并重新打开 App 后再尝试。' : ''
    const silent = this.manual === false && !this.nativeStarted
    this.set({ phase: silent ? 'idle' : 'failed',
      available: false, retryable: !this.recoveryRequired, error: silent ? undefined : errorMessage(error) + suffix,
      message: silent ? '点击检查 App 更新' : this.nativeStarted ? '更新未完成' : '检查或下载更新失败，可重试' })
    void this.recover()
  }
  async install() {
    if (this.operation || this.state.phase !== 'ready' || !this.nativeStarted || this.recoveryRequired) return this.snapshot()
    this.operation = 'installing'; this.manual = true; this.installAttempted = true
    this.stopChecking()
    this.set({ phase: 'installing', message: '正在关闭 App 连接并重启更新…', error: undefined })
    try {
      try { await this.prepareInstall() } finally { this.installPrepared = true }
      // A native error may have arrived while our app was releasing resources.
      if (this.recoveryRequired) { await this.recover(); return this.snapshot() }
      this.driver.quitAndInstall()
      if (this.recoveryRequired) return this.snapshot()
      this.restartTimer = setTimeout(() => {
        this.set({ message: '重启用时较长，请退出并重新打开 App 完成更新。' })
      }, this.restartTimeout)
      this.restartTimer.unref?.()
    } catch (error) { this.failure(error); await this.recover() }
    // Do not unlock another install after dispatch: quitAndInstall is not cancelable.
    return this.snapshot()
  }
  verifiedFile() { throw new Error('自动更新包由系统安装，请使用“重启更新”') }
}
