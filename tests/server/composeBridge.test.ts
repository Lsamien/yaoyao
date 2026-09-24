// @vitest-environment node
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {it,expect} from 'vitest'

it.skipIf(process.platform==='win32')('bounds Compose command output and stops a timed out process group without resetting shared work',async()=>{
  const {stdout}=await promisify(execFile)('python3',['tests/server/fixtures/compose_bridge_checks.py'],{timeout:15000})
  expect(stdout).toContain('COMPOSE_BRIDGE_CHECKS_OK')
},20000)
