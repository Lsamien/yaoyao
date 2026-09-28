#!/usr/bin/env node
// Browser acceptance only: no network, host credentials, or real provider account.
import {existsSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
if (!process.env.YAOYAO_CODEX_FIXTURE_COMPLETE || !process.env.CODEX_HOME?.includes('yaoyao-codex-login-')) process.exit(1)
process.stdout.write('Open https://auth.openai.com/codex/device\n\x1b[94mTEST-12345\x1b[0m\n')
const timer=setInterval(()=>{
  if (!existsSync(process.env.YAOYAO_CODEX_FIXTURE_COMPLETE)) return
  clearInterval(timer)
  writeFileSync(join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'codex-browser-fixture-token',refresh_token:'codex-browser-fixture-refresh'}}),{mode:0o600})
  process.exit(0)
},100)
