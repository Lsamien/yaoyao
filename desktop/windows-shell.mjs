import { spawn, execFile } from 'node:child_process'
import { join } from 'node:path'

export function powershellArguments(command) {
  const script = `[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$global:LASTEXITCODE = 0\ntry {\n& {\n${command}\n}\n$ok = $?\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $ok) { exit 1 }\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** Bound both output streams, and terminate the owned process tree before
 * resolving a timeout or authorization cancellation. Never spawn a shell. */
export function windowsShell(shell, command, { cwd, timeout, signal, limit = 512 * 1024 }) {
  return new Promise(resolve => {
    let child, timer, stopping, timedOut = false, cancelled = false, finished = false
    const output = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }
    const capture = (key, bytes) => {
      const kept = bytes.subarray(0, Math.max(0, limit - sizes[key]))
      output[key].push(kept); sizes[key] += kept.length
    }
    const finish = async (code, error) => {
      if (finished) return
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      await stopping
      if (error) capture('stderr', Buffer.from(error.message))
      resolve({ command, exitCode: timedOut || cancelled || error ? 1 : code ?? 1, timedOut,
        ...(cancelled ? { cancelled: true } : {}),
        stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') })
    }
    const stop = () => {
      if (stopping || finished || !child?.pid) return
      stopping = new Promise(done => {
        execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {
            // The process may already have exited while taskkill was starting.
            if (child.exitCode === null) child.kill()
            done()
          })
      })
    }
    const abort = () => { cancelled = true; stop() }
    if (signal?.aborted) { cancelled = true; void finish(1); return }
    try {
      child = spawn(shell, powershellArguments(command), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb' } })
      child.stdout.on('data', bytes => capture('stdout', bytes))
      child.stderr.on('data', bytes => capture('stderr', bytes))
      child.once('error', error => { void finish(1, error) })
      child.once('close', code => { void finish(code) })
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { timedOut = true; stop() }, timeout)
    } catch (error) { void finish(1, error) }
  })
}
