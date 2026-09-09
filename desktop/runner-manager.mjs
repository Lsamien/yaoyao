import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Native-only credentials and child ownership. No browser IPC exposes this class. */
export class DesktopRunnerManager {
  constructor(options) {
    this.options = options
    this.path = join(options.home, 'desktop-runner.enc')
    this.state = '未配置执行节点'
    this.child = null
    this.chain = Promise.resolve()
    this.stopping = false
    this.generation = 0
    this.restarts = []
  }
  publish(message) { this.state = message; this.options.onState?.(message) }
  serial(work) { const result = this.chain.catch(() => {}).then(work); this.chain = result; return result }
  async read() {
    let encrypted
    try { encrypted = await readFile(this.path) } catch(error) { if(error.code === 'ENOENT') return; throw error }
    try { return this.options.validate(JSON.parse(await this.options.decrypt(encrypted))) }
    catch { throw new Error('无法解锁执行节点配置，请检查钥匙串或重新导入') }
  }
  importFile(path) {
    const generation=++this.generation
    return this.serial(async () => {
      let config
      try { config = this.options.validate(JSON.parse(await readFile(path, 'utf8'))) }
      catch { throw new Error('执行节点配置无效，请从夭夭重新下载配置') }
      // Encrypt before stopping a working node: failed Keychain access preserves it.
      if(generation!==this.generation)return
      const bytes = await this.options.encrypt(JSON.stringify(config))
      if(generation!==this.generation)return
      await this.stopChild()
      if(generation!==this.generation)return
      await mkdir(this.options.home, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}`
      try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path) }
      finally { await rm(temporary, { force: true }) }
      if(generation!==this.generation)return
      this.stopping = false; this.restarts = []
      await this.startChild(config)
    })
  }
  start() { const generation=++this.generation; return this.serial(async () => { const config=await this.read();if(generation!==this.generation)return;this.stopping=false;if(config)await this.startChild(config) }) }
  async startChild(config) {
    if(this.child || this.stopping) return
    const child = this.options.fork()
    this.child = child
    this.stopFailure = undefined
    // Drain diagnostics without persisting possible upstream or parser secrets.
    child.stdout?.resume();child.stderr?.resume()
    this.publish('执行节点正在连接')
    child.once('spawn', () => {
      if(this.child !== child || this.stopping) { child.postMessage({type:'shutdown'}); return }
      child.postMessage({ type: 'configure', config, home: join(this.options.home, 'runner-state') })
    })
    child.on('message', message => {
      if(this.child !== child) return
      if(['status','error'].includes(message?.type) && typeof message.message === 'string') this.publish(message.message.slice(0,200))
    })
    child.exited = new Promise(resolve => child.once('exit', code => {
      child.finished = true;child.exitCode=code
      if(this.stopping&&code!==0)this.stopFailure=new Error('执行节点异常退出，电脑停止状态待确认')
      resolve()
      if(this.child !== child) return
      this.child = null
      if(this.stopping) return
      if(code === 0) { this.publish('执行节点已停止'); return }
      this.restarts = this.restarts.filter(time => Date.now()-time < 60000)
      if(this.restarts.length >= 3) { this.publish('执行节点反复退出，请检查配置后重连'); return }
      this.restarts.push(Date.now())
      this.publish('执行节点意外退出，正在重连')
      this.restartTimer = setTimeout(() => { void this.start().catch(() => this.publish('无法读取执行节点配置，请重新导入')) },1000)
      this.restartTimer.unref()
    }))
  }
  async stopChild() {
    this.stopping = true; clearTimeout(this.restartTimer)
    const child = this.child
    if(!child){if(this.stopFailure)throw this.stopFailure;return}
    child.postMessage({type:'shutdown'})
    let timer
    try { await Promise.race([child.exited,new Promise(resolve => { timer = setTimeout(resolve,30000) })]) }
    finally { clearTimeout(timer) }
    if(!child.finished) {
      child.kill()
      try { await Promise.race([child.exited,new Promise(resolve => { timer = setTimeout(resolve,5000) })]) }
      finally { clearTimeout(timer) }
    }
    if(!child.finished) throw new Error('执行节点尚未确认退出，暂不启动替代进程')
    if(this.child === child) this.child = null
    if(this.stopFailure)throw this.stopFailure
  }
  stop() { this.generation++;this.stopping = true; clearTimeout(this.restartTimer); return this.serial(() => this.stopChild()) }
  forget() { this.generation++;this.stopping = true; return this.serial(async () => { await this.stopChild(); await rm(this.path,{force:true}); this.publish('未配置执行节点') }) }
}
