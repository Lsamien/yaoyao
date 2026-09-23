import { execFile } from 'node:child_process'
import { join } from 'node:path'

export function windowsFrame(display, dimensions, physicalBounds) {
  return { display: display.id, ...dimensions, bounds: display.bounds, scaleFactor: display.scaleFactor, physicalBounds }
}
export function sameWindowsDisplay(frame, display, physicalBounds) {
  return frame?.display === display.id && frame.scaleFactor === display.scaleFactor
    && JSON.stringify(frame.bounds) === JSON.stringify(display.bounds)
    && JSON.stringify(frame.physicalBounds) === JSON.stringify(physicalBounds)
}

export class WindowsInput {
  constructor(root, packaged, execute = execFile) {
    this.helper = join(root, packaged ? 'computer-helper.exe' : 'computer-helper-dev.exe')
    this.execute = execute; this.controllers = new Set(); this.pending = new Set(); this.available = false
  }
  async call(value) {
    const controller = new AbortController()
    this.controllers.add(controller)
    let completed, closed
    const completion = new Promise(resolve => { completed = resolve })
    this.pending.add(completion)
    try {
      return await new Promise((resolve, reject) => {
        const child = this.execute(this.helper, [], { timeout: 10000, signal: controller.signal, windowsHide: true, maxBuffer: 65536 }, (error, stdout, stderr) => {
          if (error) { this.available = false; reject(new Error(String(stderr || '').trim() || 'Windows 电脑助手不可用，请检查桌面会话或重新安装客户端')); return }
          try { const result = JSON.parse(stdout); if (result.ok !== true) throw new Error(); resolve(result) }
          catch { this.available = false; reject(new Error('Windows 电脑助手响应无效')) }
        })
        closed = new Promise(resolve => child.once('close', resolve))
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(value))
      })
    } finally {
      await closed
      this.controllers.delete(controller)
      // An aborted drag may have held the button when its process terminated.
      if (controller.signal.aborted && value.action?.kind === 'drag') await this.call({ operation: 'release-drag' }).catch(() => {})
      this.pending.delete(completion); completed()
    }
  }
  async probe() {
    try { await this.call({ operation: 'probe' }); this.available = true }
    catch { this.available = false }
    return this.available
  }
  cancel() { for (const controller of this.controllers) controller.abort(); this.available = false; return Promise.allSettled([...this.pending]) }
}
