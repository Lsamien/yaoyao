import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'
import type {LocalAuthStore} from './localAuth.js'
import type {CodexAuthorizationAttempt} from '../shared/executionEnvironment.js'
import {HttpError} from './errors.js'

const TTL = 15 * 60_000
export const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device'
function codexBinary() {
  if (process.env.HERMES_YAOYAO_CODEX_BIN) return process.env.HERMES_YAOYAO_CODEX_BIN
  const command = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, command))
  if (process.platform === 'darwin') for (const base of ['/Applications',join(homedir(),'Applications')]) {
    candidates.push(join(base,'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),join(base,'Codex.app/Contents/Resources/codex'))
  }
  return candidates.find(path => existsSync(path)) ?? command
}
interface Attempt {
  owner:string; version:number; state:CodexAuthorizationAttempt; directory:string
  child?:ChildProcess; timer?:ReturnType<typeof setTimeout>; output:string; authJson?:string
}

/** Each login has its own credential store; the host's Codex login is never read. */
export class CodexAuthorization {
  private attempts = new Map<string, Attempt>()
  constructor(private auth:LocalAuthStore, private launch:typeof spawn = spawn) {}

  begin(owner:string, id:string):CodexAuthorizationAttempt {
    const previous = this.attempts.get(owner)
    if (previous?.state.id === id) return this.snapshot(owner, id)
    if (previous) this.stop(previous, 'cancelled')
    if (!this.auth.isAdminActive(owner)) throw new HttpError(403, '需要管理员权限', 'admin_required')
    const directory = mkdtempSync(join(tmpdir(), 'yaoyao-codex-login-'))
    const attempt:Attempt = {owner, version:this.auth.pushAuthorizationVersion(owner) ?? 0, directory, output:'',
      state:{id, status:'starting', expiresAt:Date.now() + TTL}}
    this.attempts.set(owner, attempt)
    attempt.timer = setTimeout(() => this.stop(attempt, 'expired'), TTL)
    attempt.timer.unref()
    const env:NodeJS.ProcessEnv = {...process.env, CODEX_HOME:directory}
    for (const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_FEDERATION_RULE_ID','OPENAI_IDENTITY_TOKEN_FILE']) delete env[key]
    try {
      const child = this.launch(codexBinary(),
        ['login','--device-auth','-c','cli_auth_credentials_store="file"'],
        {cwd:directory, env, stdio:['ignore','pipe','pipe'], windowsHide:true})
      attempt.child = child
      const receive = (chunk:Buffer) => {
        if (!this.active(attempt) || !['starting','pending'].includes(attempt.state.status)) return
        // The CLI uses ANSI styling and can split either the URL or the code across chunks.
        attempt.output = (attempt.output + chunk.toString()).slice(-16000)
        const plain = attempt.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        const code = plain.match(/^\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})\s*$/m)?.[1]
        if (plain.includes(CODEX_DEVICE_URL) && code) {
          attempt.state = {...attempt.state, status:'pending', loginUrl:CODEX_DEVICE_URL, userCode:code}
        }
      }
      child.stdout?.on('data', receive)
      child.stderr?.on('data', receive)
      child.once('error', (error:NodeJS.ErrnoException) => {
        this.stop(attempt, 'failed', error.code === 'ENOENT'
          ? '服务器未找到 Codex CLI，请安装后重试，或选择导入授权文件。'
          : '无法启动浏览器授权，请稍后重试或导入授权文件。')
      })
      child.once('close', code => {
        attempt.child = undefined
        try {
          if (!this.active(attempt) || !['starting','pending'].includes(attempt.state.status)) return
          if (code !== 0) throw new Error('login failed')
          const path = join(directory, 'auth.json')
          if (statSync(path).size > 64000) throw new Error('invalid credentials')
          const authJson = readFileSync(path, 'utf8'), data = JSON.parse(authJson)
          if (typeof data?.tokens?.access_token !== 'string' || !data.tokens.access_token) throw new Error('missing credentials')
          attempt.authJson = authJson
          attempt.output = ''
          attempt.state = {id, status:'authorized', expiresAt:attempt.state.expiresAt}
        } catch {
          this.stop(attempt, 'failed', '浏览器授权未完成，请确认账号已开启设备码登录后重试，或导入授权文件。')
        } finally { this.cleanup(attempt) }
      })
    } catch { this.stop(attempt, 'failed', '无法启动浏览器授权，请检查服务器上的 Codex CLI，或导入授权文件。') }
    return {...attempt.state}
  }

  private active(attempt:Attempt) {
    if (this.attempts.get(attempt.owner) !== attempt) return false
    if (!this.auth.isAdminActive(attempt.owner) || this.auth.pushAuthorizationVersion(attempt.owner) !== attempt.version) {
      this.stop(attempt, 'cancelled'); return false
    }
    if (Date.now() >= attempt.state.expiresAt) { this.stop(attempt, 'expired'); return false }
    return true
  }

  private require(owner:string, id:string) {
    const attempt = this.attempts.get(owner)
    if (!attempt || attempt.state.id !== id) throw new HttpError(404, '这次授权已结束，请重新登录', 'codex_auth_not_found')
    this.active(attempt)
    return attempt
  }

  snapshot(owner:string, id:string) { return {...this.require(owner, id).state} }
  credentials(owner:string, id:string) {
    const attempt = this.require(owner, id)
    if (attempt.state.status !== 'authorized' || !attempt.authJson) throw new HttpError(409, '请先完成浏览器授权', 'codex_auth_incomplete')
    return attempt.authJson
  }
  cancel(owner:string, id:string) {
    const attempt = this.require(owner, id)
    this.stop(attempt, 'cancelled')
    return {...attempt.state}
  }
  private cleanup(attempt:Attempt) { rmSync(attempt.directory, {recursive:true, force:true}) }
  private stop(attempt:Attempt, status:CodexAuthorizationAttempt['status'], error?:string) {
    clearTimeout(attempt.timer)
    attempt.output = ''; attempt.authJson = undefined
    attempt.state = {id:attempt.state.id, expiresAt:attempt.state.expiresAt, status, ...(error ? {error} : {})}
    const child = attempt.child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      const force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref()
      child.once('close', () => clearTimeout(force))
    } else this.cleanup(attempt)
  }
  close() {
    for (const attempt of this.attempts.values()) this.stop(attempt, 'cancelled')
    this.attempts.clear()
  }
}
