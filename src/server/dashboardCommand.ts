import { basename, dirname, isAbsolute } from 'node:path'

const profile = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Recognize Hermes' executable, script and module entry points, including serve. */
export function dashboardCommandIndex(args: readonly string[]): number | undefined {
  let index: number
  const executable = basename(args[0] ?? '')
  if (executable === 'hermes') index = 1
  else if (/^python(?:\d+(?:\.\d+)*)?$/i.test(executable)) {
    const script = args[1] ?? ''
    if (basename(script) === 'hermes' || (basename(script) === 'main.py' && basename(dirname(script)) === 'hermes_cli')) index = 2
    else if (script === '-m' && args[2] === 'hermes_cli.main') index = 3
    else return
  } else return
  if (args[index] === '--profile' || args[index] === '-p') {
    if (!profile.test(args[index + 1] ?? '')) return
    index += 2
  } else if (args[index]?.startsWith('--profile=')) {
    if (!profile.test(args[index]!.slice(10))) return
    index++
  } else if (profile.test(args[index] ?? '') && ['dashboard', 'serve'].includes(args[index + 1] ?? '')) index++
  return ['dashboard', 'serve'].includes(args[index] ?? '') ? index : undefined
}

/** ps does not preserve argv boundaries. Only simple, bounded runtime flags can
 * be replayed; shell wrappers, SSH backends and ambiguous paths are rejected. */
export function standaloneDashboardCommand(command: string): { command: string; args: string[] } | undefined {
  if (command.length > 8192 || /[\n\r'"\\]/.test(command)) return
  const args = command.trim().split(/\s+/), index = dashboardCommandIndex(args)
  if (index === undefined || !isAbsolute(args[0]!) || args.length > 32) return
  if (index >= 2 && args[1] !== '-m' && !isAbsolute(args[1]!)) return
  for (let i = index + 1; i < args.length; i++) {
    const flag = args[i]!
    if (['--no-open', '--skip-build', '--insecure', '--isolated'].includes(flag)) continue
    const match = /^(--host|--port|--profile)(?:=(.*))?$/.exec(flag)
    if (!match) return
    const value = match[2] ?? args[++i]
    if (!value) return
    if (match[1] === '--host' && !['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1'].includes(value)) return
    if (match[1] === '--port' && value !== '9119') return
    if (match[1] === '--profile' && !profile.test(value)) return
  }
  return { command: args[0]!, args: args.slice(1) }
}
