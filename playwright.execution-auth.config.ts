import {defineConfig,devices} from '@playwright/test'
import {resolve} from 'node:path'
import {tmpdir} from 'node:os'
process.env.YAOYAO_CODEX_FIXTURE_COMPLETE ??= resolve(tmpdir(),'yaoyao-codex-browser-fixture-complete-'+process.pid)
process.env.NO_PROXY = [process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',')
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'execution-auth.spec.ts',workers:1,timeout:45000,reporter:'list',
  use:{baseURL:'http://127.0.0.1:18847',viewport:{width:1440,height:1000},trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{
    command:'node --import tsx tests/fixtures/workspace-server.ts',url:'http://127.0.0.1:18847/healthz',reuseExistingServer:false,timeout:60000,
    env:{WORKSPACE_FIXTURE_PORT:'18847',WORKSPACE_FIXTURE_UPSTREAM_PORT:'19147',HERMES_YAOYAO_CODEX_BIN:resolve('tests/fixtures/codex-login.mjs'),YAOYAO_CODEX_FIXTURE_COMPLETE:process.env.YAOYAO_CODEX_FIXTURE_COMPLETE},
  },
})
